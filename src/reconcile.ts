/**
 * Fold what the model wrote on disk back into the ledger.
 *
 * The gap this closes: the model produces `index.html` and `_workbench.json` by
 * writing files. Nothing in that act touches the ledger, so a window row created
 * as `draft`/`building` would stay that way forever — the panel would keep saying
 * "waiting for the model" over a page that is already on disk and already
 * rendering in the iframe, and the declared actions would never be adopted, so
 * every action the artifact sent back would be dropped as undeclared.
 *
 * Three decisions worth naming:
 *
 *   1. **Reconcile on read, not on a watcher.** There is no `fs.watch` here and
 *      there should not be one: a watcher per project folder is a resource that
 *      outlives its usefulness, and it fires in bursts on every save. The client
 *      already polls `/state` while it believes something is building, so the
 *      read is the natural trigger. `GET /state` is therefore not side-effect
 *      free — it is a cache-invalidation point, which is a normal shape for a
 *      read-through cache.
 *
 *   2. **Write only on a real difference.** Every ledger write bumps the revision
 *      and is broadcast, so an unconditional patch would turn one poll into a
 *      write and that write into another poll. Comparing first makes the loop
 *      converge after one extra round trip and then go quiet.
 *
 *   3. **Only unsettled windows change status.** `draft` and `building` may
 *      become `ready` once the entry file exists. `error` is left alone: the file
 *      may well exist from an earlier build, but the last thing the user was told
 *      is that the build failed, and silently flipping it would hide that.
 *
 * The module is deliberately free of policy: it returns the ids it changed and
 * lets the API layer decide what to journal and broadcast.
 */
import { join } from 'node:path'
import { findEntryCandidates, readManifest, referencesMissingAssetsOnDisk, resolveArtifactPath } from './artifacts.ts'
import type { ForgeLedgerStore } from './ledger.ts'
import { BUILD_BUTTON_ID, DESCRIPTOR_V1_MARK, WORKBENCH_BUILD_ACTION, WORKBENCH_BUILD_LABEL, isDescriptorPath, type ForgeActionDecl, type ForgeManifest, type ForgeProject, type ForgeWindow } from './protocol.ts'

/**
 * Minimum interval between two disk checks of the same project folder.
 *
 * A burst of SSE invalidations can make the client ask for state several times in
 * a few milliseconds; re-statting the same folder for each of them buys nothing.
 * The window is short enough that a poll right after the model finishes still
 * sees the new files.
 */
const RECHECK_MS = 300

/** The actions every imported window should declare, as a fresh copy per call. */
function buildActions(): ForgeActionDecl[] {
  return [{ name: WORKBENCH_BUILD_ACTION, label: WORKBENCH_BUILD_LABEL }]
}

/**
 * Is this entry the *old* descriptor page this plugin used to write?
 *
 * v1 cards carried the literal lead sentence below and a React-service note; no
 * real workbench says that about itself. Matching on it lets an import from an
 * earlier release be upgraded in place to the 2.0 page (headline + working
 * "ask the AI to build it" button) instead of staying stuck as a dry card.
 * The mark and the path test live in the protocol so the site route applies
 * the same rule when deciding which page to serve.
 */

function isDescriptorEntry(entry: string): boolean {
  return isDescriptorPath(entry)
}

/** Last time each project folder was examined, keyed by absolute folder path. */
const lastChecked = new Map<string, number>()

/** One row that a reconcile pass rewrote. */
export interface ReconcileChange {
  windowId: string
  /** The title after the patch, for the journal line. */
  title: string
  /** True only on the pass that flipped the row out of `draft`/`building`. */
  becameReady: boolean
  /**
   * True when this pass created the row for a project that had a page on disk
   * but no window. Worth a distinct journal line: the user never asked for it,
   * so the console has to explain where the new window came from.
   */
  adopted?: boolean
}

/** Two declared-action lists are the same when every field of every entry is. */
function sameActions(left: readonly ForgeActionDecl[], right: readonly ForgeActionDecl[]): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === undefined || b === undefined) return false
    if (a.name !== b.name) return false
    if ((a.label ?? '') !== (b.label ?? '')) return false
    if ((a.description ?? '') !== (b.description ?? '')) return false
  }
  return true
}

/**
 * What a window row should look like given the folder it points at.
 *
 * Returns `undefined` when nothing needs to change, which is the common case once
 * a window has settled — the steady state costs one directory lookup per project
 * and no writes at all.
 */
async function derivePatch(
  project: ForgeProject,
  window: ForgeWindow,
  manifests: Map<string, ForgeManifest | undefined>,
): Promise<Partial<ForgeWindow> | undefined> {
  const patch: Partial<ForgeWindow> = {}

  // A `url` window has no folder and no manifest: once it names a page there is
  // nothing left to wait for.
  if (window.kind === 'url') {
    if (window.entry.trim().length > 0 && window.status !== 'ready') patch.status = 'ready'
    return Object.keys(patch).length > 0 ? patch : undefined
  }

  if (!manifests.has(project.id)) manifests.set(project.id, await readManifest(project))
  const manifest = manifests.get(project.id)

  const declared = manifest?.entry?.trim() ?? ''
  if (declared.length > 0 && declared !== window.entry) patch.entry = declared

  const title = manifest?.title?.trim() ?? ''
  if (title.length > 0 && title !== window.title) patch.title = title

  const note = manifest?.note?.trim() ?? ''
  if (note.length > 0 && note !== (window.note ?? '')) patch.note = note

  const actions = manifest?.actions
  if (actions !== undefined && !sameActions(actions, window.actions)) {
    // Copy: the ledger stores what it is given, and the manifest object is shared
    // with the cache for this pass.
    patch.actions = actions.map((action) => ({ ...action }))
  }

  const settled = window.status === 'ready' || window.status === 'error'
  if (!settled) {
    // `ready: false` is the model saying "I am still working on it" — a file that
    // exists is not permission to announce a finished window.
    if (manifest?.ready === false) return Object.keys(patch).length > 0 ? patch : undefined
    // Deep candidate: the declared entry may not exist yet, but a real page one
    // or two directories down (a market package's `standalone/index.html` for
    // example) is a better answer than waiting forever for the root.
    const preferred = declared.length > 0 ? declared : window.entry.trim()
    let candidate = preferred.length > 0 ? preferred : 'index.html'
    let probe = await resolveArtifactPath(project.folder, candidate)
    if (!probe.ok) {
      const others = (await findEntryCandidates(project.folder)).filter((path) => path !== candidate)
      for (const path of others) {
        const next = await resolveArtifactPath(project.folder, path)
        if (next.ok) {
          candidate = path
          probe = next
          break
        }
      }
    }
    if (probe.ok) {
      patch.status = 'ready'
      // A model that wrote a page but no manifest leaves `entry` empty. Adopt the
      // name that was actually found, otherwise the row says "ready" while the
      // window still renders its "no page yet" state.
      if (patch.entry === undefined && window.entry.trim().length === 0) patch.entry = candidate
      // Adopted a page that is not the declared one: say so in the row.
      if (candidate !== preferred && patch.entry === undefined) patch.entry = candidate
      // A real page with no declared actions still gets the build button, so a
      // half-working shell can be handed to the model instead of dead-ending.
      if (window.actions.length === 0) patch.actions = buildActions()
    }
  }

  // Self-heal: an entry written by the v1 descriptor generator stays a dry card
  // forever — it has no build button, so there is no way out of the dead end
  // short of deleting the window. Regenerating that page replaces the card with
  // the 2.0 layout and its working button. Only root entries qualify: a custom
  // page that merely *mentions* the old service name must never be rewritten.
  if (
    isDescriptorEntry(window.entry) &&
    window.inlineHtml !== undefined &&
    window.inlineHtml.includes(DESCRIPTOR_V1_MARK)
  ) {
    const candidate = patch.entry ?? window.entry
    const regenerated = descriptorPageSelfHeal(project, candidate)
    if (regenerated !== undefined) patch.inlineHtml = regenerated
  }

  return Object.keys(patch).length > 0 ? patch : undefined
}

/**
 * Rebuild a v1 descriptor page in place, as inline HTML.
 *
 * The folder copy (if any) is left untouched — the ledger's inline copy wins for
 * windows that have one, and rewriting the user's folder on a read path would be
 * a surprise. Returns the new document, or `undefined` when the folder cannot be
 * described (the caller then keeps the old card rather than writing an empty
 * page).
 */
function descriptorPageSelfHeal(project: ForgeProject, entry: string): string | undefined {
  const name = project.name.trim()
  if (name.length === 0) return undefined
  // descriptorPage itself is private to bundle.ts; the upgrade writes the same
  // 2.0 shape by hand here, with the same postMessage contract (source +
  // workbench.build) so the client bridge treats both identically.
  const esc = (text: string): string =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  return [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${esc(name)}</title><style>`,
    'html,body{margin:0;min-height:100%}',
    'body{font:14px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif;',
    'background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,#1c1c1f);',
    'padding:36px 32px;box-sizing:border-box;max-width:680px;margin:0 auto}',
    '.kicker{font-size:12px;letter-spacing:.08em;text-transform:uppercase;',
    'color:var(--dsw-alias-label-tertiary,#8a8a90);margin:0 0 6px}',
    'h1{font-size:28px;font-weight:650;line-height:1.3;margin:0 0 8px}',
    'p.lead{margin:0 0 24px;color:var(--dsw-alias-label-secondary,#5c5c62)}',
    '.card{border:1px solid var(--dsw-alias-border-l2,#e2e2e6);border-radius:12px;',
    'padding:16px 18px;background:var(--dsw-alias-bg-layer-1,transparent);margin:0 0 18px}',
    '.row{display:flex;gap:12px;padding:4px 0}',
    '.key{flex:none;width:4em;color:var(--dsw-alias-label-tertiary,#8a8a90)}',
    '.value{flex:1;word-break:break-word}',
    'button.primary{appearance:none;border:none;border-radius:10px;padding:10px 22px;',
    'font:600 14px/1.4 inherit;cursor:pointer;color:var(--dsw-alias-label-primary-inverted,#fff);',
    'background:var(--dsw-alias-button-primary-fill,#2b6ef2)}',
    'button.primary:hover{background:var(--dsw-alias-interactive-bg-hover-solid,#4a83f4)}',
    'button.primary:disabled{opacity:.6;cursor:default}',
    '.hint{font-size:13px;color:var(--dsw-alias-label-secondary,#5c5c62);margin:10px 0 0}',
    '.note{font-size:13px;color:var(--dsw-alias-label-secondary,#5c5c62);',
    'border-left:3px solid var(--dsw-alias-state-warn-primary,#d6a13a);padding-left:12px}',
    '</style></head><body>',
    '<p class="kicker">dsh-desktop 工作台包</p>',
    `<h1>${esc(name)}</h1>`,
    `<p class="lead">这个工作台还没有能直接运行的界面。让 AI 搭建：点下面的按钮记录一次意图，然后打开窗口右上角的 💬 对话，用自己的话发一句「帮我搭建这个工作台」。</p>`,
    `<div class="card"><div class="row"><span class="key">文件夹</span><span class="value">${esc(project.folder)}</span></div>`,
    `<div class="row"><span class="key">入口</span><span class="value">${esc(entry)}</span></div></div>`,
    `<button class="primary" id="${BUILD_BUTTON_ID}" type="button">${WORKBENCH_BUILD_LABEL}</button>`,
    '<p class="hint">按钮不会自动发送给 AI——只有你在对话里自己发的消息才会送到模型。AI 搭建完成后，这个窗口会自动换成新界面。</p>',
    `<script>(function(){var b=document.getElementById('${BUILD_BUTTON_ID}');if(!b)return;`,
    "b.addEventListener('click',function(){b.disabled=true;",
    "b.textContent='已记录，请在右侧对话里让 AI 搭建';",
    `parent.postMessage({source:'dsh-ai-workbench',action:'${WORKBENCH_BUILD_ACTION}',data:{}},'*');});})();</script>`,
    '</body></html>',
  ].join('\n')
}

/**
 * Adopt a project that has a page on disk but no window row.
 *
 * The gap this closes is a real one, seen in the wild: a page was written before
 * the window row was guaranteed to exist (an older release, or a folder the user
 * pointed at by hand), so the folder holds a finished `index.html` and a manifest
 * while the ledger holds a project with zero windows. The panel lists the project
 * but nothing ever renders, and no amount of polling fixes it, because reconcile
 * used to skip any project without a window row to patch.
 *
 * Adoption is deliberately conservative — it requires a page that actually
 * resolves. An empty folder, a folder the user has not built into yet, or a
 * missing folder all stay window-less, which is the honest state: there is
 * nothing to show. Once adopted the project has a window, so this never runs
 * again for it.
 */
async function adoptProject(
  ledger: ForgeLedgerStore,
  project: ForgeProject,
  manifests: Map<string, ForgeManifest | undefined>,
): Promise<ForgeWindow | undefined> {
  // The user deleted this project's window on purpose. The page is still on disk
  // and still renders, but putting the window back would fight the delete button,
  // so adoption stays off until an explicit create clears the flag.
  if (project.windowDismissed === true) return undefined

  if (!manifests.has(project.id)) manifests.set(project.id, await readManifest(project))
  const manifest = manifests.get(project.id)

  const declared = manifest?.entry?.trim() ?? ''
  // Deep candidate: market packages often keep their only real page below the
  // root (`standalone/index.html`), so the scan walks two directory levels
  // before giving up. A page that references assets the package does not ship
  // (an unrunnable shell) is ranked behind a self-contained one.
  let candidate = declared.length > 0 ? declared : 'index.html'
  let probe = await resolveArtifactPath(project.folder, candidate)
  if (!probe.ok) {
    const others: string[] = []
    for (const path of await findEntryCandidates(project.folder)) {
      if (path !== candidate) others.push(path)
    }
    others.sort((a, b) => {
      // Rank without I/O first: a page name that hints at a real entry
      // (`standalone/index.html`, `public/index.html`) beats an arbitrary one,
      // and only ties reach the on-disk reference scan.
      const rank = (path: string): number => {
        const name = path.toLowerCase()
        if (name === 'index.html') return 0
        if (name.endsWith('/index.html') || name.endsWith('/index.htm')) return 1
        return 2
      }
      return rank(a) - rank(b)
    })
    for (const path of others) {
      const next = await resolveArtifactPath(project.folder, path)
      if (next.ok) {
        candidate = path
        probe = next
        break
      }
    }
  }
  if (!probe.ok) return undefined

  // A page whose local scripts are missing opens to a spinner — it *looks*
  // ready and then never works, which reads as "broken" to a user with no code
  // vocabulary. Prefer the honest descriptor page (with its working build
  // button) over a stalled shell when this would be a brand-new window.
  if (await referencesMissingAssetsOnDisk(join(project.folder, candidate))) {
    const stalledEntry = candidate
    const page = descriptorPageSelfHeal(project, stalledEntry)
    if (page !== undefined) {
      return ledger.createWindow({
        projectId: project.id,
        title: (manifest?.title?.trim() ?? '') || project.name,
        kind: 'html',
        entry: 'index.html',
        status: 'ready',
        actions: buildActions(),
        inlineHtml: page,
        ...(manifest?.note?.trim() ? { note: manifest.note.trim() } : {}),
      })
    }
  }

  const title = manifest?.title?.trim() ?? ''
  const note = manifest?.note?.trim() ?? ''
  const actions = manifest?.actions
  const adoptedActions: ForgeActionDecl[] =
    actions !== undefined && actions.length > 0 ? actions.map((action) => ({ ...action })) : buildActions()
  return ledger.createWindow({
    projectId: project.id,
    title: title.length > 0 ? title : project.name,
    kind: 'html',
    entry: candidate,
    // `ready: false` is the model saying "still working": adopt the row so the
    // user can watch it, but do not announce a finished window.
    status: manifest?.ready === false ? 'building' : 'ready',
    actions: adoptedActions,
    ...(note.length > 0 ? { note } : {}),
  })
}

/**
 * Reconcile every window of every project against its folder.
 *
 * Returns the rows that actually changed, in ledger order. The caller broadcasts
 * and journals for those; the ledger's own subscription already announces the
 * revision bump, so this list exists to say *what* moved and *why it is worth a
 * line in the console*.
 */
export async function reconcileWindows(
  ledger: ForgeLedgerStore,
  now = Date.now(),
): Promise<ReconcileChange[]> {
  const changed: ReconcileChange[] = []
  const manifests = new Map<string, ForgeManifest | undefined>()

  for (const project of ledger.projects) {
    const previous = lastChecked.get(project.folder)
    if (previous !== undefined && now - previous < RECHECK_MS) continue
    lastChecked.set(project.folder, now)

    const windows = ledger.windowsOf(project.id)
    if (windows.length === 0) {
      let adopted: ForgeWindow | undefined
      try {
        adopted = await adoptProject(ledger, project, manifests)
      } catch {
        continue
      }
      if (adopted === undefined) continue
      changed.push({
        windowId: adopted.id,
        title: adopted.title,
        becameReady: adopted.status === 'ready',
        adopted: true,
      })
      continue
    }

    for (const window of windows) {
      let patch: Partial<ForgeWindow> | undefined
      try {
        patch = await derivePatch(project, window, manifests)
      } catch {
        // An unreadable folder is not an error worth surfacing here: the window
        // keeps its current row and the panel already has an empty state for it.
        continue
      }
      if (patch === undefined) continue
      const next = ledger.updateWindow(window.id, patch)
      if (next === undefined) continue
      changed.push({
        windowId: next.id,
        title: next.title,
        becameReady: window.status !== 'ready' && next.status === 'ready',
      })
    }
  }

  return changed
}

/** Forget the throttle state. Only used when a Host is disposed and re-created. */
export function resetReconcileCache(): void {
  lastChecked.clear()
}

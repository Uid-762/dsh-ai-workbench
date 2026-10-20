/**
 * Portable workbench files: export, import, and dsh-desktop package mapping.
 *
 * ## The two formats this module knows about
 *
 * **Native (`.dshwb.json`)** — this plugin's own bundle. It is a `WorkbenchBundle`
 * from `protocol.ts`: a name, an entry path, the declared actions, and every file
 * inlined as text. Importing one needs no folder, no network, and no trust beyond
 * "this is HTML I am about to render in a sandboxed iframe" — which is exactly
 * the trust a workbench artifact already has.
 *
 * **dsh-desktop package** — a `.tgz` from the dsh-desktop market. Its *runtime*
 * contract is a React component registered through `ctx.desktopWorkbenches`,
 * a service this DSH build does not have (see `README.md`, "what this plugin can
 * and cannot do"). What this module can do is read the package, take its
 * descriptor (name, version, description, repository), and — when the package
 * happens to ship a static HTML entry — adopt that as an inline artifact. When it
 * does not, the import still succeeds as a *descriptor window* that states, in
 * the artifact itself, that this package needs dsh-desktop to run. That is the
 * honest version of "one-click install": the user gets the workbench into their
 * list with its real identity, and is told what it would take to make it live,
 * instead of getting a silent failure or a fabricated success.
 *
 * ## Why text only
 *
 * Every artifact this plugin produces is one HTML file with inline CSS and JS.
 * Allowing binaries in a bundle would mean a second transport, a size explosion,
 * and a content-type trust decision for no product gain. `files[].text` is a
 * string, and the export refuses to include a file that is not valid UTF-8.
 */
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import {
  ACTION_SOURCE,
  BUNDLE_FORMAT,
  BUNDLE_VERSION,
  BUILD_BUTTON_ID,
  MANIFEST_FILE,
  WORKBENCH_BUILD_ACTION,
  WORKBENCH_BUILD_LABEL,
  type BundleFile,
  type BundleOrigin,
  type ForgeActionDecl,
  type ForgeLedger,
  type ForgeProject,
  type ForgeWindow,
  type WorkbenchBundle,
} from './protocol.ts'
import { readManifest, resolveArtifactPath } from './artifacts.ts'
import { extractTarball, selectPackageRoot, type TarEntry } from './tar.ts'

/**
 * Files a bundle may carry.
 *
 * A market package is a *built* front end, not a hand-written page: a single
 * Vite bundle is easily 40 files once code-split chunks and CSS are counted, and
 * the cap that was here (64) silently truncated exactly the assets a page needs
 * to come up — the import looked successful and the window stayed blank. 256
 * still bounds an accidental `node_modules` dump without cutting a real build.
 */
const MAX_BUNDLE_FILES = 256

/** Total text a bundle may carry, in characters. */
const MAX_BUNDLE_CHARS = 16 * 1024 * 1024

/** Folders are walked this deep; deeper ones are reported as skipped. */
const MAX_DEPTH = 3

/** Extensions that are text and part of a static artifact. */
const TEXT_EXTENSIONS = new Set([
  '.html',
  '.htm',
  '.js',
  '.mjs',
  '.css',
  '.json',
  '.svg',
  '.txt',
  '.md',
  '.csv',
  '.webmanifest',
])

/** A failure with a message a non-coder can read. */
export type BundleFailure = { ok: false; reason: string }

/** What an export produced. */
export type BundleExport = { ok: true; bundle: WorkbenchBundle; skipped: string[] } | BundleFailure

/** What an import produced. */
export type BundleImport =
  | { ok: true; bundle: WorkbenchBundle; files: BundleFile[]; skipped: string[] }
  | BundleFailure

function failure(reason: string): BundleFailure {
  return { ok: false, reason }
}

/** POSIX-style relative path, so a bundle made on Windows opens on any platform. */
function toPosix(path: string): string {
  return path.split('\\').join('/')
}

/**
 * Collect the text files of a project folder.
 *
 * Bounded three ways (count, total characters, depth) because the folder is
 * writable by the model: an unbounded walk of a folder that unexpectedly holds a
 * `node_modules` would hang the export with no error the user could act on.
 */
async function collectFiles(
  project: ForgeProject,
  relative: string,
  depth: number,
  into: BundleFile[],
  skipped: string[],
): Promise<number> {
  if (depth > MAX_DEPTH) return 0
  if (into.length >= MAX_BUNDLE_FILES) {
    skipped.push('the bundle reached its file limit')
    return 0
  }
  const resolved = await resolveArtifactPath(project.folder, relative)
  if (!resolved.ok) return 0
  let names: string[]
  try {
    names = await readdir(resolved.path)
  } catch {
    return 0
  }
  let chars = 0
  for (const name of names.sort()) {
    if (into.length >= MAX_BUNDLE_FILES) break
    // Dot-entries are never part of an artifact and `.git` can be enormous.
    if (name.startsWith('.')) continue
    if (name === 'node_modules') continue
    const childRelative = relative.length === 0 ? name : `${relative}/${name}`
    const child = await resolveArtifactPath(project.folder, childRelative)
    if (!child.ok) continue
    let info
    try {
      info = await stat(child.path)
    } catch {
      continue
    }
    if (info.isDirectory()) {
      chars += await collectFiles(project, childRelative, depth + 1, into, skipped)
      continue
    }
    const extension = extname(name).toLowerCase()
    if (!TEXT_EXTENSIONS.has(extension)) {
      skipped.push(`${childRelative} (binary or unsupported type)`)
      continue
    }
    if (info.size > MAX_BUNDLE_CHARS) {
      skipped.push(`${childRelative} (too large)`)
      continue
    }
    let text: string
    try {
      text = await readFile(child.path, 'utf8')
    } catch {
      skipped.push(`${childRelative} (unreadable)`)
      continue
    }
    chars += text.length
    if (chars > MAX_BUNDLE_CHARS) {
      skipped.push('the bundle reached its size limit')
      break
    }
    into.push({ path: toPosix(childRelative), text })
  }
  return chars
}

/**
 * Export one project as a portable bundle.
 *
 * The window chosen is the one the user is looking at (`preferredWindowId`) when
 * it belongs to the project, else the first ready window, else the first window.
 * Its entry file becomes the bundle's entry; every other text file travels along
 * so a multi-file artifact still works after import.
 */
export async function exportProject(
  ledger: ForgeLedger,
  projectId: string,
  preferredWindowId?: string,
): Promise<BundleExport> {
  const project = ledger.projects.find((candidate) => candidate.id === projectId)
  if (project === undefined) return failure(`no such project: ${projectId}`)
  const windows = ledger.windows.filter((window) => window.projectId === projectId)
  if (windows.length === 0) return failure('this project has no window to export yet')
  const chosen =
    windows.find((window) => window.id === preferredWindowId) ??
    windows.find((window) => window.status === 'ready') ??
    windows[0]
  if (chosen === undefined) return failure('this project has no window to export yet')

  const files: BundleFile[] = []
  const skipped: string[] = []
  await collectFiles(project, '', 0, files, skipped)

  // The ledger's inline copy is the fallback for a window that never had a file:
  // an import, a market download, or a model that wrote its HTML through the API.
  let entry = chosen.entry
  if (files.length === 0 && chosen.inlineHtml !== undefined && chosen.inlineHtml.length > 0) {
    entry = chosen.entry.length > 0 ? chosen.entry : 'index.html'
    files.push({ path: toPosix(entry), text: chosen.inlineHtml })
  }
  if (files.length === 0) {
    return failure('this window has no artifact yet — ask the model to build it first')
  }
  // The entry must be one of the files; otherwise the import has nothing to show.
  const entryFile = files.find((file) => file.path === toPosix(entry))
  if (entryFile === undefined) {
    entry = files[0]?.path ?? 'index.html'
  } else {
    entry = entryFile.path
  }

  const manifest = await readManifest(project)
  const actions: ForgeActionDecl[] = manifest?.actions ?? chosen.actions
  const bundle: WorkbenchBundle = {
    format: BUNDLE_FORMAT,
    bundleVersion: BUNDLE_VERSION,
    name: chosen.title.length > 0 ? chosen.title : project.name,
    files,
    entry: toPosix(entry),
    actions,
    exportedAt: Date.now(),
  }
  if (project.request !== undefined && project.request.trim().length > 0) bundle.request = project.request.trim()
  if (chosen.layout !== undefined) bundle.layout = chosen.layout
  if (chosen.placement !== undefined) bundle.placement = chosen.placement
  const note = manifest?.note ?? chosen.note
  if (note !== undefined && note.trim().length > 0) bundle.note = note.trim()
  return { ok: true, bundle, skipped }
}

/** Read a bundle from parsed JSON, validating every field the importer relies on. */
export function parseBundle(value: unknown): BundleImport {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return failure('this file is not a workbench bundle')
  }
  const record = value as Record<string, unknown>
  if (record.format !== BUNDLE_FORMAT) {
    return failure(`this file is not a ${BUNDLE_FORMAT} bundle`)
  }
  const bundleVersion = typeof record.bundleVersion === 'number' ? record.bundleVersion : 0
  if (bundleVersion > BUNDLE_VERSION) {
    return failure(
      `this bundle was made by a newer version (${bundleVersion}); this plugin reads up to ${BUNDLE_VERSION}`,
    )
  }
  const name = typeof record.name === 'string' && record.name.trim().length > 0 ? record.name.trim() : '导入的工作台'
  if (!Array.isArray(record.files)) return failure('this bundle has no files')
  const files: BundleFile[] = []
  const skipped: string[] = []
  let chars = 0
  for (const raw of record.files) {
    if (files.length >= MAX_BUNDLE_FILES) {
      skipped.push('the bundle carries more files than this plugin accepts')
      break
    }
    if (raw === null || typeof raw !== 'object') continue
    const file = raw as Record<string, unknown>
    const path = typeof file.path === 'string' ? file.path.trim() : ''
    const text = typeof file.text === 'string' ? file.text : undefined
    if (path.length === 0 || text === undefined) continue
    // A bundle is a file a stranger sent you. `..` in a path would let it write
    // outside the project folder, so a path that is not a clean relative path is
    // dropped rather than sanitized into something surprising.
    if (path.startsWith('/') || path.includes('..') || path.includes('\\') || path.includes('\0')) {
      skipped.push(`${path} (unsafe path)`)
      continue
    }
    chars += text.length
    if (chars > MAX_BUNDLE_CHARS) {
      skipped.push('the bundle is larger than this plugin accepts')
      break
    }
    files.push({ path, text })
  }
  if (files.length === 0) return failure('this bundle has no usable files')
  const declaredEntry = typeof record.entry === 'string' ? toPosix(record.entry.trim()) : ''
  const entry = files.some((file) => file.path === declaredEntry) ? declaredEntry : (files[0]?.path ?? 'index.html')
  const actions: ForgeActionDecl[] = []
  if (Array.isArray(record.actions)) {
    for (const raw of record.actions) {
      if (actions.length >= 32) break
      if (raw === null || typeof raw !== 'object') continue
      const item = raw as Record<string, unknown>
      const actionName = typeof item.name === 'string' ? item.name.trim() : ''
      if (actionName.length === 0) continue
      const action: ForgeActionDecl = { name: actionName }
      if (typeof item.label === 'string') action.label = item.label
      if (typeof item.description === 'string') action.description = item.description
      actions.push(action)
    }
  }
  const bundle: WorkbenchBundle = {
    format: BUNDLE_FORMAT,
    bundleVersion,
    name,
    files,
    entry,
    actions,
    exportedAt: typeof record.exportedAt === 'number' ? record.exportedAt : Date.now(),
  }
  if (typeof record.request === 'string' && record.request.trim().length > 0) bundle.request = record.request.trim()
  if (record.layout === 'auto' || record.layout === 'single' || record.layout === 'two-col' || record.layout === 'three-col' || record.layout === 'grid-2x2' || record.layout === 'top-one' || record.layout === 'dashboard') {
    bundle.layout = record.layout
  }
  if (record.placement === 'embedded' || record.placement === 'standalone') bundle.placement = record.placement
  if (typeof record.note === 'string' && record.note.trim().length > 0) bundle.note = record.note.trim()
  const origin = record.origin
  if (origin !== null && typeof origin === 'object' && !Array.isArray(origin)) {
    const raw = origin as Record<string, unknown>
    if (raw.kind === 'local' || raw.kind === 'dsh-desktop') {
      const parsed: BundleOrigin = { kind: raw.kind }
      if (typeof raw.id === 'string') parsed.id = raw.id
      if (typeof raw.url === 'string') parsed.url = raw.url
      if (typeof raw.version === 'string') parsed.version = raw.version
      bundle.origin = parsed
    }
  }
  return { ok: true, bundle, files, skipped }
}

/**
 * Write a bundle's files into a fresh project folder.
 *
 * `overwrite: false` refuses to touch a file that already exists. The import
 * lands in a folder the Host derived from the bundle name, so a collision means
 * the user already has a workbench by that name — and silently replacing their
 * artifact with a downloaded one is not a decision this plugin gets to make.
 */
export async function writeBundle(
  folder: string,
  files: readonly BundleFile[],
  options: { overwrite?: boolean } = {},
): Promise<{ ok: true; written: string[]; skipped: string[] } | BundleFailure> {
  const written: string[] = []
  const skipped: string[] = []
  try {
    await mkdir(folder, { recursive: true })
  } catch (error) {
    return failure(`could not create the project folder: ${describe(error)}`)
  }
  for (const file of files) {
    const target = join(folder, file.path)
    if (options.overwrite !== true) {
      try {
        await stat(target)
        skipped.push(`${file.path} (already exists)`)
        continue
      } catch {
        // Absent, which is the expected case.
      }
    }
    try {
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, file.text, 'utf8')
      written.push(file.path)
    } catch (error) {
      skipped.push(`${file.path} (${describe(error)})`)
    }
  }
  if (written.length === 0) {
    return failure('none of the files could be written; the folder may already contain them')
  }
  return { ok: true, written, skipped }
}

/**
 * Turn a dsh-desktop workbench package into a bundle this plugin can show.
 *
 * The package is a `.tgz` with `package.json`, `cordis.patch.yml`, a server entry
 * and a built React client. Only the descriptor and any static HTML are usable
 * here; the React client needs a host service this DSH build does not expose.
 *
 * When no HTML exists, the returned bundle is a *descriptor page* generated by
 * this function: a small self-contained HTML document that shows the workbench's
 * identity and says plainly that it requires dsh-desktop. That page is honest,
 * it is editable, and it gives the user something to look at instead of an
 * import that appears to succeed and shows nothing.
 */
export function bundleFromPackage(
  bytes: Uint8Array,
  source: { id?: string; url?: string; version?: string } = {},
): { ok: true; bundle: WorkbenchBundle; descriptorOnly: boolean; skipped: string[] } | BundleFailure {
  const extracted = extractTarball(bytes)
  if (!extracted.ok) {
    return failure(`this package could not be unpacked: ${extracted.reason}${extracted.detail === undefined ? '' : ` (${extracted.detail})`}`)
  }
  const entries = selectPackageRoot(extracted.entries)
  const byPath = new Map<string, TarEntry>()
  for (const entry of entries) {
    if (entry.directory) continue
    byPath.set(toPosix(entry.path).replace(/^\.\//, ''), entry)
  }
  const decoder = new TextDecoder('utf-8', { fatal: false })
  const textAt = (path: string): string | undefined => {
    const entry = byPath.get(path)
    if (entry === undefined) return undefined
    return decoder.decode(entry.bytes)
  }
  let packageName: string | undefined
  let packageVersion: string | undefined
  let description: string | undefined
  let repository: string | undefined
  const packageText = textAt('package.json')
  if (packageText !== undefined) {
    try {
      const parsed = JSON.parse(packageText) as Record<string, unknown>
      if (typeof parsed.name === 'string') packageName = parsed.name
      if (typeof parsed.version === 'string') packageVersion = parsed.version
      if (typeof parsed.description === 'string') description = parsed.description
      const repo = parsed.repository
      if (typeof repo === 'string') repository = repo
      else if (repo !== null && typeof repo === 'object' && !Array.isArray(repo)) {
        const url = (repo as Record<string, unknown>).url
        if (typeof url === 'string') repository = url
      }
    } catch {
      // A package with an unparsable manifest is still worth reading for HTML.
    }
  }
  // A static entry, in the order an author would most likely have placed it.
  // Browser-extension popups are never workbench pages: they call `chrome.*`
  // APIs that do not exist in an iframe and render a blank panel or throw on
  // load. A package that ships nothing but a popup is better served by the
  // descriptor page than by a broken popup.
  const htmlCandidates = [...byPath.keys()].filter((path) => {
    const extension = extname(path).toLowerCase()
    if (extension !== '.html' && extension !== '.htm') return false
    if (path.includes('node_modules/')) return false
    if (isExtensionDocument(path)) return false
    return true
  })
  const plans = new Map<string, PagePlan>()
  const planFor = (path: string): PagePlan => {
    const cached = plans.get(path)
    if (cached !== undefined) return cached
    const plan = planPage(path, byPath)
    plans.set(path, plan)
    return plan
  }
  htmlCandidates.sort((a, b) => {
    const rank = (path: string): number => {
      if (path === 'index.html') return 0
      if (path === 'dsh/index.html') return 1
      if (path.startsWith('public/')) return 2
      if (path.startsWith('assets/')) return 3
      return 4
    }
    // A page that references local scripts the package does not ship would open
    // blank or stall on a spinner — worse than no page, because it *looks* ready.
    // The descriptor page is honest about the limits; a broken shell is not.
    const stalled = (path: string): number => {
      if (planFor(path).dead) return 20
      if (isDevShell(path, byPath)) return 10
      return referencesMissingAssets(path, byPath) ? 10 : 0
    }
    return rank(a) + stalled(a) - (rank(b) + stalled(b)) || (a < b ? -1 : a > b ? 1 : 0)
  })
  const skipped: string[] = []
  const title = packageName !== undefined && packageName.length > 0 ? packageName : (source.id ?? 'dsh-desktop 工作台')
  // The best candidate is only worth importing when it can actually come up: a
  // dev-server shell (its `src/main.jsx` was never built into the package) or a
  // page whose own script/stylesheet is absent is a blank window that *looks*
  // installed. The descriptor page says what the package is and offers the AI
  // build button, which is a real next step.
  const best = htmlCandidates[0]
  const bestPlan = best === undefined ? undefined : planFor(best)
  const usable = best !== undefined && bestPlan !== undefined && !bestPlan.dead && !isDevShell(best, byPath)
  if (usable && best !== undefined && bestPlan !== undefined) {
    const entry = best
    const files: BundleFile[] = []
    for (const path of byPath.keys()) {
      const extension = extname(path).toLowerCase()
      if (!TEXT_EXTENSIONS.has(extension)) continue
      if (path.includes('node_modules/')) continue
      const text = textAt(path)
      if (text === undefined) continue
      files.push({ path, text })
      if (files.length >= MAX_BUNDLE_FILES) break
    }
    // The entry document is stored *rewritten*: root-absolute asset paths
    // (`/api/<plugin>/app.js`, what the package's own server route would answer)
    // are mapped onto files the package really ships and turned into paths
    // relative to the entry, so the page loads under `/site/<projectId>/`
    // instead of 404ing every asset.
    const entryIndex = files.findIndex((file) => file.path === entry)
    if (entryIndex >= 0) files[entryIndex] = { path: entry, text: bestPlan.html }
    else {
      if (files.length >= MAX_BUNDLE_FILES) files.pop()
      files.unshift({ path: entry, text: bestPlan.html })
    }
    // The entry page gets one action: "ask the AI to build/fix this workbench".
    // A static shell that loads gets the button too — the model can extend a page
    // that half-works — so it is declared for every imported package, not only
    // for descriptor-only ones.
    const actions: ForgeActionDecl[] = [{ name: WORKBENCH_BUILD_ACTION, label: WORKBENCH_BUILD_LABEL }]
    const bundle: WorkbenchBundle = {
      format: BUNDLE_FORMAT,
      bundleVersion: BUNDLE_VERSION,
      name: title,
      files,
      entry,
      actions,
      exportedAt: Date.now(),
      origin: {
        kind: 'dsh-desktop',
        ...(source.id === undefined ? {} : { id: source.id }),
        ...(source.url === undefined ? {} : { url: source.url }),
        ...(packageVersion ?? source.version) === undefined
          ? {}
          : { version: (packageVersion ?? source.version) as string },
      },
    }
    if (description !== undefined && description.length > 0) bundle.note = description
    return { ok: true, bundle, descriptorOnly: false, skipped }
  }
  // No static page: generate the descriptor page. Everything interpolated is
  // escaped, and the document is fully self-contained so it renders in the
  // sandboxed iframe like any other artifact.
  //
  // The package's own text files still travel with the bundle. They are the only
  // thing a user can act on here — the README says what the workbench is for, and
  // the source is there to read or to hand to a model — and dropping them would
  // leave an import that shows a card and nothing else.
  const files: BundleFile[] = []
  // One slot is reserved for the descriptor page itself.
  for (const path of byPath.keys()) {
    if (files.length >= MAX_BUNDLE_FILES - 1) break
    if (path.includes('node_modules/')) continue
    if (!TEXT_EXTENSIONS.has(extname(path).toLowerCase())) continue
    const text = textAt(path)
    if (text === undefined) continue
    files.push({ path, text })
  }
  const identity = source.id ?? packageName ?? '(unknown)'
  const html = descriptorPage({
    title,
    identity,
    version: packageVersion ?? source.version ?? '(unknown)',
    description: description ?? '',
    repository: repository ?? (source.url === undefined ? '' : source.url),
    readme: textAt('README.md') ?? textAt('readme.md'),
    files: files.map((file) => file.path),
  })
  // Reaching here means the package ships no usable static page: it either has
  // no `.html` at all, or the only candidates are pages that cannot come up
  // (a dev-server shell, a browser-extension popup, a page whose own script the
  // package does not ship). The descriptor page is the honest outcome.
  const entryPath = 'index.html'
  files.unshift({
    path: entryPath,
    text: html,
  })
  return {
    ok: true,
    descriptorOnly: true,
    skipped,
    bundle: {
      format: BUNDLE_FORMAT,
      bundleVersion: BUNDLE_VERSION,
      name: title,
      files,
      entry: entryPath,
      actions: [{ name: WORKBENCH_BUILD_ACTION, label: WORKBENCH_BUILD_LABEL }],
      exportedAt: Date.now(),
      note: '这是一个 dsh-desktop 工作台包：本插件能读出它的说明和源码。点下面的按钮，AI 可以按它的源码把界面搭出来。',
      origin: {
        kind: 'dsh-desktop',
        ...(source.id === undefined ? {} : { id: source.id }),
        ...(source.url === undefined ? {} : { url: source.url }),
        ...(packageVersion ?? source.version) === undefined
          ? {}
          : { version: (packageVersion ?? source.version) as string },
      },
    },
  }
}

/**
 * Does this path look like a browser-extension popup rather than a page?
 *
 * `chrome.*` / `browser.*` APIs do not exist inside an iframe, so a popup loads
 * with a blank body or throws on its first API call. Several market packages
 * ship one (`extension/popup.html`, `chrome-extension/popup.html`,
 * `lib/browser-extension/chromium/popup.html`) and nothing else that renders;
 * picking it makes an import look installed and show nothing.
 */
function isExtensionDocument(path: string): boolean {
  const segments = path.split('/')
  // The file name itself is not a directory, so it is skipped by the loop bound.
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (/^(?:chrome-extension|browser-extension|extensions?)$/i.test(segments[index] ?? '')) return true
  }
  return false
}

/**
 * Is this HTML a Vite/webpack *dev-server* shell?
 *
 * `<script type="module" src="/src/main.jsx">` is the index a dev server serves:
 * the browser compiles the JSX on the fly, and a published package does not ship
 * the toolchain that would. The page therefore loads and renders nothing. A
 * package that also ships its real build (`dist/index.html`) should have that
 * one chosen instead.
 */
function isDevShell(path: string, byPath: Map<string, TarEntry>): boolean {
  const entry = byPath.get(path)
  if (entry === undefined) return false
  const html = new TextDecoder('utf-8', { fatal: false }).decode(entry.bytes)
  for (const match of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*"([^"]*)"/gi)) {
    const source = (match[1] ?? '').trim().replace(/[?#].*$/, '')
    if (/\.(?:jsx|tsx|ts|vue|svelte)$/i.test(source)) return true
  }
  return false
}

/** A candidate entry page, after its asset references have been resolved. */
interface PagePlan {
  /** The document with root-absolute references rewritten to relative ones. */
  html: string
  /** True when a script or stylesheet the page needs is not in the package. */
  dead: boolean
}

/**
 * Prepare one HTML candidate for serving under `/site/<projectId>/`.
 *
 * A package authored for its *own* server writes root-absolute asset paths
 * (`<script src="/api/site-selection/app.js">`) because its plugin route serves
 * them. Under this Host's site route those paths resolve against the DSH origin
 * and 404, so the page comes up blank even though every file is in the package.
 * The fix is to map each such reference onto the file that is really there and
 * express it relative to the entry document — which is what this does. A
 * reference that cannot be mapped and that the page needs to render (a script or
 * a stylesheet) marks the page `dead`, so the caller prefers the descriptor page
 * over a guaranteed-blank window.
 */
function planPage(path: string, byPath: Map<string, TarEntry>): PagePlan {
  const entry = byPath.get(path)
  if (entry === undefined) return { html: '', dead: true }
  const html = new TextDecoder('utf-8', { fatal: false }).decode(entry.bytes)
  const base = dirname(path)
  let dead = false
  const rewritten = html.replace(/<(script|link|img|source|iframe|video|audio)\b([^>]*)>/gi, (tag, name: string, attrs: string) => {
    const attribute = /\b(src|href)\s*=\s*"([^"]*)"/i.exec(attrs)
    if (attribute === null) return tag
    const raw = (attribute[2] ?? '').trim()
    if (raw.length === 0) return tag
    // External URLs, protocol-relative URLs, fragments and data URIs are not
    // this Host's business.
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(raw)) return tag
    const reference = raw.replace(/[?#].*$/, '')
    const suffix = raw.slice(reference.length)
    const critical =
      name.toLowerCase() === 'script' ||
      (name.toLowerCase() === 'link' && /\brel\s*=\s*"?(?:stylesheet|modulepreload)\b/i.test(attrs))
    // Root-absolute: the package's own server route used to answer it.
    if (reference.startsWith('/')) {
      const target = resolvePackageReference(reference, byPath)
      if (target === undefined) {
        if (critical) dead = true
        return tag
      }
      const relative = relativePosix(base, target)
      const next = attrs.replace(attribute[0], `${attribute[1]}="${relative}${suffix}"`)
      return `<${name}${next}>`
    }
    // Already relative: keep it, but a critical target the package does not ship
    // means the page cannot render.
    if (critical && !byPath.has(normalizeJoin(base, reference))) dead = true
    return tag
  })
  return { html: rewritten, dead }
}

/**
 * Find the package file a root-absolute reference points at.
 *
 * Tries the literal path first (`/public/app.js` → `public/app.js`), then the
 * longest path suffix, so `/api/site-selection/app.js` finds `public/app.js` and
 * `/api/ming-life/app/assets/index.js` finds `dist/assets/index.js`. The shortest
 * match wins: it is the one closest to the package root, which is where a build
 * puts its output.
 */
function resolvePackageReference(reference: string, byPath: Map<string, TarEntry>): string | undefined {
  const literal = normalizeJoin('', reference)
  if (byPath.has(literal)) return literal
  const trimmed = literal.replace(/^\/+/, '')
  let best: string | undefined
  for (const candidate of byPath.keys()) {
    if (!candidate.endsWith(`/${trimmed}`)) continue
    if (best === undefined || candidate.length < best.length) best = candidate
  }
  return best
}

/** `posix.relative` for the two-argument case this module needs. */
function relativePosix(fromDirectory: string, target: string): string {
  const from = fromDirectory.length === 0 ? [] : fromDirectory.split('/')
  const to = target.split('/')
  let common = 0
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common += 1
  const up = new Array<string>(from.length - common).fill('..')
  const down = to.slice(common)
  const joined = up.concat(down).join('/')
  return joined.startsWith('.') ? joined : `./${joined}`
}

/**
 * Does this HTML page reference sibling assets the package does not actually
 * contain?
 *
 * Scans `src`/`href` attributes for local (non-URL) paths and checks each
 * against the package's own file set. A page whose script or stylesheet is
 * missing cannot come up by itself: `standalone/index.html` in a package that
 * only ships the *source* of its bundle (`lib/` left unbuilt) is exactly this.
 * Ranking such a page behind every self-contained one keeps an import from
 * serving a spinner.
 */
function referencesMissingAssets(path: string, byPath: Map<string, TarEntry>): boolean {
  const entry = byPath.get(path)
  if (entry === undefined) return false
  const html = new TextDecoder('utf-8', { fatal: false }).decode(entry.bytes)
  const base = dirname(path)
  const references = new Set<string>()
  for (const match of html.matchAll(/(?:src|href)\s*=\s*"([^"]*)"/gi)) {
    const raw = (match[1] ?? '').trim()
    if (raw.length === 0) continue
    if (/^(?:[a-z]+:|\/\/|#|data:)/i.test(raw)) continue
    references.add(raw.replace(/^\.\//, '').replace(/[?#].*$/, ''))
  }
  for (const reference of references) {
    const target = normalizeJoin(base, reference)
    if (!byPath.has(target)) return true
  }
  return false
}

/** `posix.join` for the two-argument case this scanner needs. */
function normalizeJoin(base: string, relative: string): string {
  const parts = (base.length === 0 ? [] : base.split('/')).concat(relative.split('/'))
  const out: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}

/**
 * The generated page shown for a package this build cannot execute.
 *
 * The 2.0 page is built around one real button. The old card explained what the
 * package *was* and stopped there; a user with no code vocabulary reads that as
 * "broken". Now the identity block still tells the truth, but the primary
 * affordance asks the AI to rebuild the interface as a self-contained static
 * page — the loop this plugin exists to run. Exported because the site route
 * needs to serve this page for windows whose folder still holds the v1 card on
 * disk (the folder belongs to the user; this plugin does not rewrite it).
 */
export function descriptorPage(input: {
  title: string
  identity: string
  version: string
  description: string
  repository: string
  readme?: string | undefined
  files?: readonly string[] | undefined
}): string {
  // Typed as a tuple list so the destructure below stays `string`, not
  // `string | undefined` under `noUncheckedIndexedAccess`.
  const rows: [string, string][] = [
    ['标识', input.identity],
    ['版本', input.version],
    ['说明', input.description.length > 0 ? input.description : '（这个包没有写说明）'],
    ['来源', input.repository.length > 0 ? input.repository : '（没有仓库地址）'],
  ]
  const body = rows
    .map(
      ([key, value]) =>
        `<div class="row"><span class="key">${escapeHtml(key)}</span><span class="value">${escapeHtml(value)}</span></div>`,
    )
    .join('')
  // The README is the package author's own explanation of what the workbench is
  // for, so it is worth showing verbatim — escaped, and in a scroll box so a long
  // one does not push the page around. Markdown is not rendered: a hand-rolled
  // renderer would be a liability, and raw text is still readable.
  const readmeBlock =
    input.readme !== undefined && input.readme.trim().length > 0
      ? `<details class="more"><summary>包的 README</summary><pre>${escapeHtml(input.readme)}</pre></details>`
      : ''
  const filesBlock =
    input.files !== undefined && input.files.length > 1
      ? `<details class="more"><summary>包里的文件（${input.files.length} 个）</summary><pre>${escapeHtml(input.files.join('\n'))}</pre></details>`
      : ''
  // dsh-desktop's design vocabulary, inlined: a wide headline, one card, a
  // filled primary button. The page must work inside the sandboxed iframe with
  // no network and no theme provider, so every token has a literal fallback.
  //
  // The button does NOT wake the model. Product rule: only the user's own chat
  // message reaches the AI. Pressing it posts a record-only action (the parent
  // frame journals it) and the hint below tells the user what to do next — go
  // to the chat pane and ask in their own words.
  const script = `<script>(function(){var b=document.getElementById('${BUILD_BUTTON_ID}');if(!b)return;b.addEventListener('click',function(){b.disabled=true;b.textContent='已记录，请在右侧对话里让 AI 搭建';parent.postMessage({source:'${ACTION_SOURCE}',action:'${WORKBENCH_BUILD_ACTION}',data:{}},'*');});})();</script>`
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(input.title)}</title><style>
:root{color-scheme:light dark}
html,body{margin:0;min-height:100%}
body{font:14px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif;
background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,#1c1c1f);
padding:36px 32px;box-sizing:border-box;max-width:680px;margin:0 auto}
.kicker{font-size:12px;letter-spacing:.08em;text-transform:uppercase;
color:var(--dsw-alias-label-tertiary,#8a8a90);margin:0 0 6px}
h1{font-size:28px;font-weight:650;line-height:1.3;margin:0 0 8px}
p.lead{margin:0 0 24px;color:var(--dsw-alias-label-secondary,#5c5c62)}
.card{border:1px solid var(--dsw-alias-border-l2,#e2e2e6);border-radius:12px;
padding:16px 18px;background:var(--dsw-alias-bg-layer-1,transparent);margin:0 0 18px}
.row{display:flex;gap:12px;padding:4px 0}
.key{flex:none;width:4em;color:var(--dsw-alias-label-tertiary,#8a8a90)}
.value{flex:1;word-break:break-word}
button.primary{appearance:none;border:none;border-radius:10px;padding:10px 22px;
font:600 14px/1.4 inherit;cursor:pointer;color:var(--dsw-alias-label-primary-inverted,#fff);
background:var(--dsw-alias-button-primary-fill,#2b6ef2)}
button.primary:hover{background:var(--dsw-alias-interactive-bg-hover-solid,#4a83f4)}
button.primary:disabled{opacity:.6;cursor:default}
.hint{font-size:13px;color:var(--dsw-alias-label-secondary,#5c5c62);margin:10px 0 0}
.note{font-size:13px;color:var(--dsw-alias-label-secondary,#5c5c62);
border-left:3px solid var(--dsw-alias-state-warn-primary,#d6a13a);padding-left:12px}
.more{margin:14px 0 0;font-size:13px}
.more summary{cursor:pointer;color:var(--dsw-alias-label-secondary,#5c5c62)}
.more pre{margin:8px 0 0;padding:10px 12px;max-height:40vh;overflow:auto;
border:1px solid var(--dsw-alias-border-l1,#ebebef);border-radius:8px;
background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.03));
font:12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;word-break:break-word}
</style></head><body>
<p class="kicker">dsh-desktop 工作台包</p>
<h1>${escapeHtml(input.title)}</h1>
<p class="lead">${escapeHtml(input.description.length > 0 ? input.description : '这个包的界面是一个桌面组件，本插件可以先读懂它，再由 AI 搭出能直接用的静态界面。')}</p>
<div class="card">${body}</div>
<button class="primary" id="${BUILD_BUTTON_ID}" type="button">${WORKBENCH_BUILD_LABEL}</button>
<p class="hint">点按钮只是记录一次意图，不会自动发送给 AI。要让 AI 搭建：打开窗口右上角的 💬 对话，用自己的话发一句「帮我搭建这个工作台」。</p>
<p class="note">原包的界面需要 dsh-desktop 桌面版才能原生运行；这里显示的是它的说明与源码。AI 搭建完成后，这个窗口会自动换成新界面。</p>
${readmeBlock}${filesBlock}
${script}
</body></html>`
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The window row an import should create.
 *
 * Kept here rather than in the route so the export/import round trip is decided
 * in one file: whatever `exportProject` reads, `importWindow` writes.
 */
export function importWindow(bundle: WorkbenchBundle): {
  title: string
  entry: string
  kind: 'html'
  actions: ForgeActionDecl[]
  note?: string
  layout?: ForgeWindow['layout']
  placement?: ForgeWindow['placement']
  inlineHtml?: string
} {
  const entryFile = bundle.files.find((file) => file.path === bundle.entry) ?? bundle.files[0]
  const inlineHtml = entryFile?.text
  return {
    title: bundle.name,
    entry: bundle.entry,
    kind: 'html',
    actions: bundle.actions,
    ...(bundle.note === undefined ? {} : { note: bundle.note }),
    ...(bundle.layout === undefined ? {} : { layout: bundle.layout }),
    ...(bundle.placement === undefined ? {} : { placement: bundle.placement }),
    // The entry document also goes into the ledger: the import writes files too,
    // but keeping the source here means the window renders even if the folder is
    // later moved, and `inlineArtifact` only ever consults it when the file read
    // has already failed.
    ...(inlineHtml === undefined ? {} : { inlineHtml }),
  }
}

/** Where an imported project's folder should go, given the bundle name. */
export function importFolderName(bundle: WorkbenchBundle): string {
  const origin = bundle.origin
  if (origin !== undefined && origin.kind === 'dsh-desktop' && origin.id !== undefined) {
    return marketFolderName(origin.id)
  }
  return bundle.name
}

/**
 * The folder a market workbench lands in.
 *
 * Exported so the market list can tell which entries are already installed
 * without downloading them: the folder name is derived from the catalog id
 * alone, so comparing it against the projects on hand needs no network call.
 */
export function marketFolderName(id: string): string {
  return id.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'imported'
}

/** Re-exported so the routes do not need to reach into `protocol.ts` for it. */
export { MANIFEST_FILE }

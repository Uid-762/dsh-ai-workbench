/**
 * The JSON API and the artifact host.
 *
 * One handler is registered on `ctx.webServer` as a single `prefix` route, and
 * this module dispatches inside it. That is deliberate: every extra registration
 * is another chance to collide with another plugin's route, and a duplicate
 * `(kind, path)` pair throws during composition and takes the whole plugin down.
 * One prefix means one collision surface, under a name nothing else uses.
 *
 * Every JSON response is an `ApiEnvelope`. The client therefore never has to
 * guess whether a parsed body is data or an error, and a handler that throws
 * mid-write still produces a well-formed response because the whole dispatch is
 * wrapped.
 *
 * The artifact host lives here too (`/site/:projectId/*`) rather than in its own
 * module because it shares the project lookup, and because it must be reachable
 * from an iframe without a token — the sandboxed artifact has no credentials.
 */
import { readFile, readdir, rm, rmdir } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  ACTION_SOURCE,
  BUNDLE_EXTENSION,
  clampWindowBox,
  DESCRIPTOR_V1_MARK,
  projectPhase,
  ROUTE_API,
  ROUTE_SITE,
  slugify,
  windowLayout,
  windowPlacement,
  WORKBENCH_BUILD_ACTION,
  isDescriptorPath,
  type ForgeActionDecl,
  type ForgeChatLine,
  type ForgeLedger,
  type ForgeProject,
  type ForgeWindow,
  type JsonValue,
  type MarketEntry,
  type MarketView,
  type WorkbenchBundle,
} from '../protocol.ts'
import { type ForgeLedgerStore } from '../ledger.ts'
import { inlineArtifact, listFolder, readArtifact, readManifest, statArtifact } from '../artifacts.ts'
import { reconcileWindows, type ReconcileChange } from '../reconcile.ts'
import {
  bundleFromPackage,
  descriptorPage,
  exportProject,
  importFolderName,
  importWindow,
  marketFolderName,
  parseBundle,
  writeBundle,
} from '../bundle.ts'
import type { MarketScreenshot } from '../market.ts'
import { downloadWorkbench, fetchCatalog, fetchImage, type MarketCatalog } from '../market.ts'
import { assistantText, buildWorkbenchSummary, chatTurn, userText } from '../summary.ts'
import type { EventHub } from './sse.ts'

/** Largest request body accepted, in bytes. */
const MAX_BODY_BYTES = 2 * 1024 * 1024

/**
 * How long a fetched market catalog is reused, in milliseconds.
 *
 * Fifteen minutes matches the catalog's own cache window. The panel asks for this
 * list every time it is opened, and a desktop app that refetches someone else's
 * index on every click is a bad citizen.
 */
const CATALOG_TTL_MS = 15 * 60 * 1000

/**
 * Prefixes this plugin puts on a user message when it speaks to the model itself.
 *
 * A project's session is the session the user already talks to the model in, so
 * the chat pane cannot treat every assistant message as a workbench reply — it has
 * to recognise the turns it started. Both markers are emitted by this plugin and
 * by nothing else: `[workbench-chat]` opens a chat-pane turn, `[workbench-action]`
 * opens one for a declared artifact action.
 */
const CHAT_MARKERS: readonly string[] = [
  '[workbench-chat]',
  '[workbench-action]',
  '【工作台 ·',
]

/**
 * What happened when an action was handed to the model.
 *
 * `unbound` and `failed` are both "not delivered" but they are not the same
 * problem, and the panel says so.
 */
export type ForwardResult =
  | { ok: true; sessionId: string }
  | { ok: false; reason: 'unbound' }
  | { ok: false; reason: 'failed'; error: string }

/**
 * The face the API needs from the Host.
 *
 * Keeping it structural (rather than importing the Host class) means this module
 * can be exercised without a cordis context, and it documents exactly which Host
 * capabilities the routes depend on.
 */
export interface ApiDeps {
  /**
   * The open ledger.
   *
   * A thunk rather than the store itself. `createApiHandler` is called from a
   * cordis `inject` callback, which runs synchronously during boot, while the
   * ledger opens asynchronously. Handing over the store would mean reading it
   * before it exists; the resulting throw aborts route registration silently and
   * every endpoint answers 404 for the life of the process. Deferring the read
   * to request time keeps registration infallible and lets the first request pay
   * the wait instead.
   */
  ledger(): ForgeLedgerStore
  hub: EventHub
  /** Limits echoed to the client. */
  limits: {
    minWindowW: number
    minWindowH: number
    maxProjects: number
    maxWindowsPerProject: number
    maxChatLines: number
    protocolVersion: number
  }
  /**
   * Send an artifact action into the session bound to a project.
   *
   * Returns a discriminated result rather than `string | undefined`, because the
   * caller has to tell two very different failures apart:
   *
   *   - `unbound`: nobody asked the model to open a window in this project yet,
   *     so there is no session to talk to. The fix is in the user's hands.
   *   - `failed`: a session was known but the delivery itself broke.
   *
   * Collapsing both into "no session is bound" sends the user looking for a
   * missing binding when the real problem is elsewhere, so the reason is carried
   * out to the panel verbatim.
   *
   * Neither outcome is fatal: the action is journalled and broadcast either way,
   * so the panel can show that the click happened even when the model was not
   * reached.
   */
  forward(input: {
    projectId: string
    windowId: string
    action: string
    data?: JsonValue
    sessionId?: string
  }): Promise<ForwardResult>
  /** Write a journal line without going through the ledger's own level filter. */
  journal(text: string, level: 'info' | 'warn' | 'error' | 'action' | 'success'): void
  /**
   * Where a project's artifacts live, derived from its name.
   *
   * The client never learns the DSH home directory, so it cannot build this path
   * itself. Deriving it here keeps the filesystem layout a Host concern and
   * means a project created from the panel and one created by the model land in
   * the same place.
   */
  defaultFolder(projectName: string): string
  /**
   * Deliver a turn of text to a project's session, creating one if needed.
   *
   * This is the one path by which anything the browser knows reaches the model
   * other than an artifact action. It is deliberately separate from `forward`:
   * an action is a click with a name, while this is free prose (the chat pane, the
   * interview answer, a "try again" from the panel), and the wording handed to
   * the model differs accordingly.
   */
  promptProject(projectId: string, text: string, sessionId?: string): Promise<ForwardResult>
  /** Create the project's session when it has none, and report the id. */
  ensureSession(projectId: string): Promise<{ sessionId?: string; error?: string }>
  /** Root under which new project folders are created. */
  projectsRoot: string
  /** dsh-desktop market catalog URL, from the plugin's own config. */
  marketUrl: string
  /** Prefix proxy retried when a direct GitHub download fails; empty disables it. */
  marketProxy: string
  /** Name of the built-in authoring skill, when it is registered. */
  skillName: string | undefined
  /**
   * Read a session's event log without activating its agent.
   *
   * The chat pane needs the model's *reply*, and the reply exists only as session
   * events. Reading them here (rather than in the browser) keeps the session
   * service on the Host side, where it is guaranteed to exist.
   */
  inspectSession(sessionId: string): Promise<readonly unknown[] | undefined>
  /** Whether the panel should run the interview before building. */
  interviewFirst: boolean
  /** Whether the right-hand chat pane is offered at all. */
  chatPane: boolean
}

/** A minimal router over the part of the path after the API prefix. */
interface Route {
  method: string
  /** `:name` segments capture; everything else must match literally. */
  pattern: string
  handle(ctx: RouteContext): Promise<void> | void
}

interface RouteContext {
  req: IncomingMessage
  res: ServerResponse
  params: Record<string, string>
  query: URLSearchParams
  body: () => Promise<unknown>
}

/** Write an envelope. `status` defaults to 200. */
function reply<T>(res: ServerResponse, payload: unknown, status = 200): void {
  if (res.headersSent) return
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** A successful envelope. */
function ok<T>(res: ServerResponse, data: T, revision: number): void {
  reply(res, { ok: true, data, revision } satisfies { ok: true; data: T; revision: number })
}

/** A failure envelope. Never includes a stack trace: it is a browser boundary. */
function fail(res: ServerResponse, message: string, status = 400, revision?: number): void {
  reply(res, { ok: false, error: message, revision }, status)
}

/** Read a bounded request body and parse it as JSON. */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer)
    total += buffer.byteLength
    if (total > MAX_BODY_BYTES) throw new Error('the request body is too large')
    chunks.push(buffer)
  }
  if (total === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim().length === 0) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('the request body is not valid JSON')
  }
}

/** Narrow an unknown value to a plain object. */
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

/** Read a required non-empty string field. */
function requireString(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`"${key}" is required and must be a non-empty string`)
  }
  return value.trim()
}

/** Read an optional string field. */
function optionalString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  if (typeof value !== 'string') return undefined
  return value
}

/** Read an optional finite number field. */
function optionalNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return value
}

/** Read an optional boolean field. */
function optionalBoolean(source: Record<string, unknown>, key: string): boolean | undefined {
  const value = source[key]
  return typeof value === 'boolean' ? value : undefined
}

/**
 * Read an optional array of declared actions.
 *
 * The manifest on disk is model-authored, so this is untrusted input twice over:
 * it arrives as a PATCH body that the client derived from that file. Only `name`
 * is load-bearing — it is what the relay matches against — so an entry without a
 * usable name is dropped rather than rejected. A malformed list therefore costs
 * the declared actions, never the whole request.
 */
function optionalActions(
  source: Record<string, unknown>,
  key: string,
): ForgeActionDecl[] | undefined {
  const value = source[key]
  if (!Array.isArray(value)) return undefined
  const actions: ForgeActionDecl[] = []
  for (const entry of value) {
    const item = record(entry)
    const name = optionalString(item, 'name')?.trim()
    if (name === undefined || name.length === 0) continue
    const action: ForgeActionDecl = { name }
    const label = optionalString(item, 'label')
    if (label !== undefined) action.label = label
    const description = optionalString(item, 'description')
    if (description !== undefined) action.description = description
    actions.push(action)
    // A window that declares hundreds of actions is not a chatty artifact, it is
    // a runaway manifest. Cap it; the relay only ever sends one at a time.
    if (actions.length >= 32) break
  }
  return actions
}

/**
 * Build the request handler.
 *
 * `prefix` is the route prefix the handler was registered under; it is used to
 * strip the mount point so the router only sees the endpoint path.
 */
export function createApiHandler(deps: ApiDeps, prefix: string) {
  /**
   * The last good catalog, kept across requests.
   *
   * Per-handler rather than module-level: the handler is rebuilt if the plugin is
   * reconfigured, and a stale cache from a previous mount should not survive it.
   */
  let catalogCache: { catalog?: MarketCatalog; error?: string; fetchedAt: number } | undefined

  const routes: Route[] = [
    { method: 'GET', pattern: '/state', handle: handleState },
    { method: 'GET', pattern: '/log', handle: handleLog },
    { method: 'POST', pattern: '/log/clear', handle: handleLogClear },
    { method: 'POST', pattern: '/project', handle: handleCreateProject },
    { method: 'PATCH', pattern: '/project/:id', handle: handleUpdateProject },
    { method: 'DELETE', pattern: '/project/:id', handle: handleDeleteProject },
    { method: 'POST', pattern: '/window', handle: handleCreateWindow },
    { method: 'PATCH', pattern: '/window/:id', handle: handleUpdateWindow },
    { method: 'DELETE', pattern: '/window/:id', handle: handleDeleteWindow },
    { method: 'POST', pattern: '/action', handle: handleAction },
    { method: 'POST', pattern: '/session', handle: handleSession },
    { method: 'GET', pattern: '/chat/:projectId', handle: handleChatList },
    { method: 'POST', pattern: '/chat', handle: handleChatSend },
    { method: 'POST', pattern: '/chat/clear', handle: handleChatClear },
    { method: 'GET', pattern: '/bundle/:projectId', handle: handleBundleExport },
    { method: 'POST', pattern: '/import', handle: handleBundleImport },
    { method: 'POST', pattern: '/import/package', handle: handlePackageImport },
    { method: 'GET', pattern: '/market', handle: handleMarket },
    { method: 'POST', pattern: '/market/install', handle: handleMarketInstall },
    { method: 'GET', pattern: '/screenshot', handle: handleScreenshot },
    { method: 'GET', pattern: '/manifest/:projectId', handle: handleManifest },
    { method: 'GET', pattern: '/folder/:projectId', handle: handleFolder },
    { method: 'GET', pattern: '/standalone/:windowId', handle: handleStandalone },
    { method: 'GET', pattern: '/site/:projectId/*', handle: handleSite },
  ]

  /**
   * State, reconciled against the folders first.
   *
   * The model produces a window by *writing files*. Nothing in that act touches
   * the ledger, so without this step a row created as `draft` would keep saying
   * "waiting for the model" over a page that is already on disk, and the actions
   * the artifact declares would never be adopted — which in turn makes the relay
   * drop them as undeclared. Reading is therefore the moment to look at disk:
   * the client polls this endpoint precisely while it believes something is
   * building, so no separate watcher or timer is needed.
   *
   * The reconcile writes through the ledger, whose own subscription already
   * broadcasts a `state` frame — so there is nothing extra to push here.
   */
  async function handleState(ctx: RouteContext): Promise<void> {
    const ledger = deps.ledger()
    let changed: ReconcileChange[] = []
    try {
      changed = await reconcileWindows(ledger)
    } catch (error) {
      // Reconciling is best-effort: a folder that cannot be read must not take
      // the whole state endpoint down, because that endpoint is how the client
      // recovers from anything else going wrong.
      deps.journal(
        `could not check the project folders: ${error instanceof Error ? error.message : String(error)}`,
        'warn',
      )
    }
    for (const change of changed) {
      // Adoption is announced separately and first: the user did not ask for this
      // window, so the console owes them an explanation of where it came from.
      if (change.adopted === true) {
        deps.journal(`adopted "${change.title}" — the folder already held a page but no window`, 'success')
        continue
      }
      if (change.becameReady) {
        deps.journal(`the model finished "${change.title}" — the page is on disk now`, 'success')
      }
    }
    const state = {
      ledger: ledger.file satisfies ForgeLedger,
      limits: deps.limits,
      // The session is per-project, so the top-level copy is only a convenience:
      // it names the one the panel was last told about, and a project that has its
      // own `sessionId` always wins in the client.
      ...(deps.skillName === undefined ? {} : { skillName: deps.skillName }),
      ...(boundSession() === undefined ? {} : { sessionId: boundSession() }),
      // The Host reports its own switches rather than the client keeping a copy:
      // these come from the plugin Config, which the user edits in the shell's
      // settings page, and a browser-side duplicate would drift on the next edit.
      features: { interviewFirst: deps.interviewFirst, chatPane: deps.chatPane },
      // The projects root, so the "new project" form can pre-fill the folder
      // field with the default location instead of guessing at it. A path is
      // not sensitive here: the user can already read it from any journal line.
      projectsRoot: deps.projectsRoot,
    }
    ok(ctx.res, state, ledger.revision)
  }

  /**
   * The session a project is bound to.
   *
   * Read from the ledger rather than from a single Host field: a project created
   * by the panel gets its own session, and two projects in the same panel must not
   * deliver into each other's conversation.
   */
  function boundSession(projectId?: string): string | undefined {
    const ledger = deps.ledger()
    if (projectId !== undefined) return ledger.project(projectId)?.sessionId
    return ledger.projects.find((project) => (project.sessionId ?? '').length > 0)?.sessionId
  }

  function handleLog(ctx: RouteContext): void {
    ok(ctx.res, { log: deps.ledger().log }, deps.ledger().revision)
  }

  function handleLogClear(ctx: RouteContext): void {
    deps.ledger().clearLog()
    deps.journal('journal cleared', 'info')
    ok(ctx.res, { cleared: true }, deps.ledger().revision)
  }

  function handleCreateProject(ctx: RouteContext): Promise<void> | void {
    return (async () => {
      const body = record(await ctx.body())
      const name = requireString(body, 'name')
      // The folder is optional on the wire. A caller that knows where it wants
      // the artifacts to go passes one; the panel does not, because the DSH home
      // directory is a Host fact. Both paths end up in the same place because
      // the default is derived here rather than in the browser.
      //
      // Blank counts as absent. A form that submits `folder: ''` means "I did not
      // fill this in", not "put the project in the current directory" — and an
      // empty folder would make the session's `cwd` the process directory, which
      // is exactly the bug this default exists to prevent.
      const requested = optionalString(body, 'folder')
      const folder = requested !== undefined && requested.trim().length > 0 ? requested.trim() : deps.defaultFolder(name)
      const { project, reused } = deps.ledger().createProject({ name, folder })
      // The ledger deduplicates by folder (one folder is one project — the model
      // re-deriving a path the panel created must reuse the row, not mint one),
      // so say which happened. A silent success would hide the merge from the
      // user who is staring at an unchanged project list.
      deps.journal(reused ? `reused project ${project.name} — that folder is already a project` : `created project ${project.name}`, 'success')
      deps.hub.broadcast({ kind: 'project', revision: deps.ledger().revision, projectId: project.id })
      ok(ctx.res, { project }, deps.ledger().revision)
    })()
  }

  function handleUpdateProject(ctx: RouteContext): Promise<void> | void {
    return (async () => {
      const body = record(await ctx.body())
      const id = ctx.params.id ?? ''
      const patch: Partial<Pick<ForgeProject, 'name' | 'folder' | 'sessionId' | 'request' | 'phase' | 'intake'>> = {}
      const name = optionalString(body, 'name')
      if (name !== undefined) patch.name = name
      const folder = optionalString(body, 'folder')
      // A blank folder is refused rather than stored: the folder is what the
      // session's `cwd` is set from, so an empty one would silently retarget the
      // model at the harness process directory.
      if (folder !== undefined && folder.trim().length > 0) patch.folder = folder.trim()
      const sessionId = optionalString(body, 'sessionId')
      if (sessionId !== undefined) patch.sessionId = sessionId
      const request = optionalString(body, 'request')
      if (request !== undefined) patch.request = request
      // The interview's answers. Stored on the project so the build prompt and the
      // chat summary can both quote what the user actually confirmed, rather than
      // re-asking or guessing.
      const intake = optionalString(body, 'intake')
      if (intake !== undefined) patch.intake = intake
      if (body.phase !== undefined) {
        const phase = projectPhase(body.phase)
        if (phase === undefined) {
          fail(ctx.res, `unknown project phase: ${JSON.stringify(body.phase)}`, 400, deps.ledger().revision)
          return
        }
        patch.phase = phase
      }
      const project = deps.ledger().updateProject(id, patch)
      if (project === undefined) {
        fail(ctx.res, `no such project: ${id}`, 404, deps.ledger().revision)
        return
      }
      deps.hub.broadcast({ kind: 'project', revision: deps.ledger().revision, projectId: id })
      ok(ctx.res, { project }, deps.ledger().revision)
    })()
  }

  function handleDeleteProject(ctx: RouteContext): Promise<void> | void {
    return (async () => {
      const id = ctx.params.id ?? ''
      const project = deps.ledger().project(id)
      if (project === undefined) {
        fail(ctx.res, `no such project: ${id}`, 404, deps.ledger().revision)
        return
      }
      const removed = deps.ledger().removeProject(id)
      // Delete means delete. The ledger entry is what separates a project row
      // from a folder on disk, and a folder left behind is what made the market
      // list keep showing workbenches the user had just removed — plus 10 stale
      // folders nobody asked to keep.
      //
      // The directory is only ever removed when it is *this plugin's own*
      // projectsRoot, never a user directory drag-and-dropped into the panel.
      // A failure here is journalled and ignored: the project is already gone
      // from the ledger and the GUI, and a folder no future code will read is
      // not worth an error page.
      let removedFiles = 0
      let folderError: string | undefined
      const folder = resolve(project.folder)
      const root = resolve(deps.projectsRoot)
      if (folder.startsWith(root + sep) && folder !== root) {
        try {
          removedFiles = await removeTree(folder)
        } catch (error) {
          folderError = errorMessage(error)
        }
      }
      deps.journal(
        removedFiles > 0
          ? `removed project ${project.name} · ${removed?.windows ?? 0} window(s) · ${removedFiles} file(s) deleted`
          : `removed project ${project.name} · ${removed?.windows ?? 0} window(s)${folderError === undefined ? ' · files left on disk' : ` · ${folderError}`}`,
        removedFiles > 0 ? 'action' : 'warn',
      )
      deps.hub.broadcast({ kind: 'state', revision: deps.ledger().revision })
      ok(
        ctx.res,
        { removed: { ...(removed ?? { windows: 0 }), files: removedFiles }, folder: project.folder },
        deps.ledger().revision,
      )
    })()
  }

  /**
   * Delete a directory tree, returning how many files it held.
   *
   * Counted rather than boolean so the journal line can say what actually went
   * away.
   */
  async function removeTree(target: string): Promise<number> {
    const entries = await readdir(target, { withFileTypes: true })
    let count = 0
    for (const item of entries) {
      const path = join(target, item.name)
      if (item.isDirectory()) {
        count += await removeTree(path)
      } else if (item.isSymbolicLink() || item.isFile()) {
        await rm(path, { force: true })
        count += 1
      }
    }
    await rmdir(target)
    return count
  }

  /** The first line of an error message, bounded — it goes into a journal row. */
  function errorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error)
    return message.split('\n')[0]?.slice(0, 120) ?? 'unknown error'
  }

  function handleCreateWindow(ctx: RouteContext): Promise<void> | void {
    return (async () => {
      const body = record(await ctx.body())
      const projectId = requireString(body, 'projectId')
      const title = optionalString(body, 'title') ?? '窗口'
      const entry = optionalString(body, 'entry')
      const note = optionalString(body, 'note')
      const kind = optionalString(body, 'kind') === 'url' ? 'url' : 'html'
      // Optional presentation fields. Absent stays absent; present but unknown
      // is a caller bug and is rejected — the ledger refuses unknown presets,
      // so silently dropping one here would store a window that disagrees
      // with what was asked for.
      if (body.layout !== undefined && windowLayout(body.layout) === undefined) {
        fail(ctx.res, `unknown layout preset: ${JSON.stringify(body.layout)}`, 400, deps.ledger().revision)
        return
      }
      if (body.placement !== undefined && windowPlacement(body.placement) === undefined) {
        fail(ctx.res, `unknown window placement: ${JSON.stringify(body.placement)}`, 400, deps.ledger().revision)
        return
      }
      const layout = windowLayout(body.layout)
      const placement = windowPlacement(body.placement)
      // An imported workbench carries its page inline, because the folder it came
      // from may not exist on this machine yet (or at all, if the write failed).
      const inlineHtml = optionalString(body, 'inlineHtml')
      const chat = optionalBoolean(body, 'chat')
      const window = deps.ledger().createWindow({
        projectId,
        title,
        kind,
        ...(entry === undefined ? {} : { entry }),
        ...(note === undefined ? {} : { note }),
        ...(layout === undefined ? {} : { layout }),
        ...(placement === undefined ? {} : { placement }),
        ...(inlineHtml === undefined ? {} : { inlineHtml }),
        ...(chat === undefined ? {} : { chat }),
        status: 'draft',
      })
      deps.hub.broadcast({ kind: 'window', revision: deps.ledger().revision, windowId: window.id })
      ok(ctx.res, { window }, deps.ledger().revision)
    })()
  }

  function handleUpdateWindow(ctx: RouteContext): Promise<void> | void {
    return (async () => {
      const body = record(await ctx.body())
      const id = ctx.params.id ?? ''
      const patch: Partial<ForgeWindow> = {}
      const title = optionalString(body, 'title')
      if (title !== undefined) patch.title = title
      const entry = optionalString(body, 'entry')
      if (entry !== undefined) patch.entry = entry
      const note = optionalString(body, 'note')
      if (note !== undefined) patch.note = note
      // Declared actions are rewritten from disk by the client after a build, so
      // a PATCH has to be able to replace the whole list. Only names are trusted
      // to be action identities; labels and descriptions are display copy.
      const actions = optionalActions(body, 'actions')
      if (actions !== undefined) patch.actions = actions
      const kind = optionalString(body, 'kind')
      if (kind === 'html' || kind === 'url') patch.kind = kind
      if (body.layout !== undefined && windowLayout(body.layout) === undefined) {
        fail(ctx.res, `unknown layout preset: ${JSON.stringify(body.layout)}`, 400, deps.ledger().revision)
        return
      }
      const layout = windowLayout(body.layout)
      if (layout !== undefined) patch.layout = layout
      if (body.placement !== undefined && windowPlacement(body.placement) === undefined) {
        fail(ctx.res, `unknown window placement: ${JSON.stringify(body.placement)}`, 400, deps.ledger().revision)
        return
      }
      const placement = windowPlacement(body.placement)
      if (placement !== undefined) patch.placement = placement
      // `inlineHtml` is the fallback document served when the project folder has no
      // entry file. An empty string clears it, which is how the client switches a
      // window back to being served purely from disk after a rebuild.
      const inlineHtml = optionalString(body, 'inlineHtml')
      if (inlineHtml !== undefined) patch.inlineHtml = inlineHtml
      const chat = optionalBoolean(body, 'chat')
      if (chat !== undefined) patch.chat = chat
      const status = optionalString(body, 'status')
      if (status === 'draft' || status === 'building' || status === 'ready' || status === 'error') {
        patch.status = status
      }
      const open = optionalBoolean(body, 'open')
      if (open !== undefined) patch.open = open
      const minimized = optionalBoolean(body, 'minimized')
      if (minimized !== undefined) patch.minimized = minimized
      const fullscreen = optionalBoolean(body, 'fullscreen')
      if (fullscreen !== undefined) patch.fullscreen = fullscreen
      const x = optionalNumber(body, 'x')
      const y = optionalNumber(body, 'y')
      const w = optionalNumber(body, 'w')
      const h = optionalNumber(body, 'h')
      if (x !== undefined && y !== undefined && w !== undefined && h !== undefined) {
        Object.assign(patch, clampWindowBox({ x, y, w, h }))
      } else {
        if (x !== undefined) patch.x = x
        if (y !== undefined) patch.y = y
        if (w !== undefined) patch.w = w
        if (h !== undefined) patch.h = h
      }
      const window = deps.ledger().updateWindow(id, patch)
      if (window === undefined) {
        fail(ctx.res, `no such window: ${id}`, 404, deps.ledger().revision)
        return
      }
      deps.hub.broadcast({ kind: 'window', revision: deps.ledger().revision, windowId: id })
      ok(ctx.res, { window }, deps.ledger().revision)
    })()
  }

  function handleDeleteWindow(ctx: RouteContext): Promise<void> | void {
    return (async () => {
      const id = ctx.params.id ?? ''
      // `dismissWindow` rather than `removeWindow`: reconcile adopts a project
      // that has a page on disk but no window row, so a plain removal would be
      // undone by the next poll and the delete button would look broken.
      if (!deps.ledger().dismissWindow(id)) {
        fail(ctx.res, `no such window: ${id}`, 404, deps.ledger().revision)
        return
      }
      deps.hub.broadcast({ kind: 'state', revision: deps.ledger().revision })
      ok(ctx.res, { removed: id }, deps.ledger().revision)
    })()
  }

  /**
   * An artifact action coming back from the user's click.
   *
   * The declared-action check happens on the CLIENT, where the manifest is
   * already loaded and the user is looking at the window. Here the job is to
   * journal it and report it — never to wake the model on the user's behalf.
   *
   * A click used to be forwarded to the project's session, which made every
   * button in a workbench a hidden prompt trigger: press "sync", and the model
   * would answer whether or not the user wanted it to. The rule now is that
   * only the user's own chat message reaches the AI. A click is recorded (the
   * chat summary quotes recent actions, so the model still *sees* them once the
   * user does write in), broadcast to the activity feed, and left there.
   *
   * The legacy path is kept behind `recordOnly: false` for callers that
   * explicitly ask for the old behaviour (the tool surface), because the
   * workbench_window tool's own prompt flow never goes through this route.
   */
  function handleAction(ctx: RouteContext): Promise<void> | void {
    return (async () => {
      const body = record(await ctx.body())
      const windowId = requireString(body, 'windowId')
      const action = requireString(body, 'action')
      const data = body.data as JsonValue | undefined
      // recordOnly is the default: a caller that omits it gets the safe
      // behaviour. Only an explicit `false` opts back into delivery, and no
      // shipped caller does.
      const recordOnly = body.recordOnly !== false
      const window = deps.ledger().window(windowId)
      if (window === undefined) {
        fail(ctx.res, `no such window: ${windowId}`, 404, deps.ledger().revision)
        return
      }
      const project = deps.ledger().project(window.projectId)
      if (project === undefined) {
        fail(ctx.res, `window ${windowId} has no project`, 409, deps.ledger().revision)
        return
      }
      const recordId = `${windowId}:${action}:${Date.now()}`
      let delivered = false
      let error: string | undefined
      let sessionId = project.sessionId
      if (recordOnly) {
        // Nothing is sent anywhere. The record below says so honestly.
        error = undefined
      } else {
        try {
          // The descriptor page's build button is the one action that may create
          // its own path: a project imported from the market has no session yet,
          // and asking the user to first "open a window" is backwards when the
          // button they pressed exists precisely to summon the model. Everything
          // else keeps the strict rule — no session, no delivery, honest warning.
          if (action === WORKBENCH_BUILD_ACTION && (sessionId ?? '').length === 0) {
            const ensured = await deps.ensureSession(project.id)
            sessionId = ensured.sessionId
            if (sessionId === undefined && ensured.error !== undefined) error = ensured.error
          }
          if ((sessionId ?? '').length > 0) {
            const result = await deps.forward({
              projectId: project.id,
              windowId,
              action,
              ...(data === undefined ? {} : { data }),
              sessionId: sessionId as string,
            })
            delivered = result.ok
            if (!result.ok && result.reason !== 'unbound') error = result.error
            else if (!result.ok && result.reason === 'unbound') error = 'the session disappeared before the action could be delivered'
          } else if (error === undefined) {
            error = 'no session is bound to this project yet — ask the model to open a window first'
          }
        } catch (cause) {
          error = cause instanceof Error ? cause.message : String(cause)
        }
      }
      const line = recordOnly
        ? `action ${action} · recorded only — the user decides when to ask the AI`
        : delivered
          ? `action ${action} → session`
          : `action ${action} · not delivered: ${error ?? 'unknown reason'}`
      deps.journal(line, recordOnly ? 'info' : delivered ? 'action' : 'warn')
      const result = {
        id: recordId,
        projectId: project.id,
        windowId,
        action,
        ...(data === undefined ? {} : { data }),
        timestamp: Date.now(),
        delivered,
        ...(error === undefined ? {} : { error }),
      }
      deps.hub.broadcast({ kind: 'action', revision: deps.ledger().revision, record: result })
      ok(ctx.res, { record: result }, deps.ledger().revision)
    })()
  }

  /**
   * Bind a session to a project, creating one if it has none.
   *
   * The panel calls this before its first prompt so that "the model is thinking"
   * and "there is a session to think in" cannot get out of order: a prompt sent to
   * a project with no session would have nowhere to land, and the user would see a
   * spinner over nothing.
   */
  function handleSession(ctx: RouteContext): Promise<void> | void {
    return (async () => {
      const body = record(await ctx.body())
      const projectId = requireString(body, 'projectId')
      const project = deps.ledger().project(projectId)
      if (project === undefined) {
        fail(ctx.res, `no such project: ${projectId}`, 404, deps.ledger().revision)
        return
      }
      if ((project.sessionId ?? '').length > 0) {
        ok(ctx.res, { sessionId: project.sessionId }, deps.ledger().revision)
        return
      }
      const result = await deps.ensureSession(projectId)
      if (result.sessionId === undefined) {
        // 502 rather than 500: the failure is upstream (the harness could not make
        // a session), not a bug in this request.
        fail(ctx.res, result.error ?? 'the harness could not create a session', 502, deps.ledger().revision)
        return
      }
      deps.hub.broadcast({ kind: 'project', revision: deps.ledger().revision, projectId })
      ok(ctx.res, { sessionId: result.sessionId }, deps.ledger().revision)
    })()
  }

  /**
   * The chat transcript of one project, with any new model replies folded in.
   *
   * The model answers in its own session, not through this API, so its reply
   * arrives as a session event. Reading those events on every list request is what
   * closes the loop without a second transport: the pane polls this endpoint while
   * it is waiting, sees the reply appear, and stops.
   */
  function handleChatList(ctx: RouteContext): Promise<void> | void {
    return (async () => {
      const projectId = ctx.params.projectId ?? ''
      const project = deps.ledger().project(projectId)
      if (project === undefined) {
        fail(ctx.res, `no such project: ${projectId}`, 404, deps.ledger().revision)
        return
      }
      const added = await ingestReplies(projectId)
      for (const line of added) {
        deps.hub.broadcast({ kind: 'chat', revision: deps.ledger().revision, projectId, line })
      }
      ok(
        ctx.res,
        {
          chat: deps.ledger().chatsOf(projectId),
          ...(project.sessionId === undefined ? {} : { sessionId: project.sessionId }),
          added: added.length,
        },
        deps.ledger().revision,
      )
    })()
  }

  /**
   * Fold the model's spoken replies into the project's chat transcript.
   *
   * Idempotent by `(role, at, text)`: the session log is re-read on every poll, so
   * the only safe way to append is to first check whether that exact line is
   * already stored. Only `assistant/message` text blocks are taken — tool calls and
   * reasoning are machinery the user cannot act on.
   *
   * A project's session is the session the user already talks to the model in, so
   * most assistant messages there are answers to the user's own prompts, not to
   * the workbench. Only turns opened by one of our own markers are adopted: walk
   * the log in order, arm on a `[workbench-chat]` or `[workbench-action]` user
   * message, and take the next assistant message after it. Without that filter the
   * chat pane fills up with the entire conversation the user is having elsewhere.
   */
  async function ingestReplies(projectId: string): Promise<ForgeChatLine[]> {
    const project = deps.ledger().project(projectId)
    const sessionId = project?.sessionId
    if (sessionId === undefined) return []
    let events: readonly unknown[]
    try {
      const inspected = await deps.inspectSession(sessionId)
      if (inspected === undefined) return []
      events = inspected
    } catch {
      // Reading the log is best-effort: a session that is gone must not make the
      // chat pane unusable, it only means no new replies show up.
      return []
    }
    const known = new Set(
      deps.ledger().chatsOf(projectId).map((line) => `${line.role}\u0000${line.at}\u0000${line.text}`),
    )
    const added: ForgeChatLine[] = []
    // Newest last, and only the tail: a long session would otherwise be rescanned
    // in full on every poll for replies that are already stored.
    //
    // `armed` is only ever SET by a marked user message and only ever CLEARED by
    // consuming one assistant message. Injected user messages (runtime context,
    // skill catalog, time) arrive between the real prompt and the reply, so a
    // non-marked user message must leave the flag alone — clearing it there made
    // every chat reply unreachable, because the injections always come last.
    let armed = false
    for (const event of events.slice(-80)) {
      const asked = userText(event)
      if (asked !== undefined) {
        if (CHAT_MARKERS.some((marker) => asked.startsWith(marker))) armed = true
        continue
      }
      const text = assistantText(event)
      if (text === undefined) continue
      if (!armed) continue
      armed = false
      const outer = record(event)
      const at = typeof outer.time === 'number' && Number.isFinite(outer.time) ? outer.time : Date.now()
      const key = `model\u0000${Math.round(at)}\u0000${text}`
      if (known.has(key)) continue
      known.add(key)
      const line = deps.ledger().appendChat({ projectId, role: 'model', text, at })
      if (line !== undefined) added.push(line)
    }
    return added
  }

  /**
   * Send one chat message to the project's session.
   *
   * The workbench summary is prepended to the outbound text and also stored on the
   * transcript line, so the user can inspect exactly what the model was told about
   * their workbench. That summary is the whole reason this pane is useful: the
   * model sees the layout, the declared actions, the recent clicks and the build
   * contract without the user having to re-explain any of it.
   */
  function handleChatSend(ctx: RouteContext): Promise<void> | void {
    return (async () => {
      const body = record(await ctx.body())
      const projectId = requireString(body, 'projectId')
      const text = requireString(body, 'text')
      const project = deps.ledger().project(projectId)
      if (project === undefined) {
        fail(ctx.res, `no such project: ${projectId}`, 404, deps.ledger().revision)
        return
      }
      if (!deps.chatPane) {
        fail(ctx.res, 'the chat pane is turned off in this plugin\'s settings', 409, deps.ledger().revision)
        return
      }
      const summary = buildWorkbenchSummary(deps.ledger().file, projectId)
      // Record the user's line before delivering: if delivery fails, the pane must
      // still show what was typed, next to the reason it did not arrive.
      const line = deps.ledger().appendChat({ projectId, role: 'user', text, context: summary })
      if (line === undefined) {
        fail(ctx.res, 'the message was empty', 400, deps.ledger().revision)
        return
      }
      deps.hub.broadcast({ kind: 'chat', revision: deps.ledger().revision, projectId, line })
      let delivered = false
      let error: string | undefined
      try {
        const result = await deps.promptProject(projectId, chatTurn(summary, text))
        delivered = result.ok
        if (!result.ok) {
          error =
            result.reason === 'unbound'
              ? 'this project has no session yet — open the workbench once so the model can create one'
              : result.error
        }
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause)
      }
      deps.journal(
        delivered ? `chat message → session` : `chat message · not delivered: ${error ?? 'unknown reason'}`,
        delivered ? 'action' : 'warn',
      )
      ok(ctx.res, { line, delivered, ...(error === undefined ? {} : { error }) }, deps.ledger().revision)
    })()
  }

  function handleChatClear(ctx: RouteContext): Promise<void> | void {
    return (async () => {
      const body = record(await ctx.body())
      const projectId = requireString(body, 'projectId')
      const removed = deps.ledger().clearChat(projectId)
      deps.hub.broadcast({ kind: 'state', revision: deps.ledger().revision })
      ok(ctx.res, { removed }, deps.ledger().revision)
    })()
  }

  /**
   * Export one workbench as a portable file.
   *
   * The bundle inlines every text file, so the download works when the recipient
   * has never seen this machine, this folder, or this DSH profile.
   */
  function handleBundleExport(ctx: RouteContext): Promise<void> | void {
    return (async () => {
      const projectId = ctx.params.projectId ?? ''
      const windowId = ctx.query.get('windowId') ?? undefined
      const exported = await exportProject(deps.ledger().file, projectId, windowId)
      if (!exported.ok) {
        fail(ctx.res, exported.reason, 409, deps.ledger().revision)
        return
      }
      const project = deps.ledger().project(projectId)
      const base = slugify(project?.name ?? exported.bundle.name)
      ok(
        ctx.res,
        {
          bundle: exported.bundle,
          filename: `${base}${BUNDLE_EXTENSION}`,
          skipped: exported.skipped,
        },
        deps.ledger().revision,
      )
    })()
  }

  /**
   * Import a bundle the user picked from their disk.
   *
   * Every file lands in a fresh folder under the projects root, and the window is
   * created with the bundle's entry inlined as well, so it renders even if writing
   * the folder only partly succeeded.
   */
  function handleBundleImport(ctx: RouteContext): Promise<void> | void {
    return (async () => {
      const body = record(await ctx.body())
      const parsed = parseBundle(body.bundle ?? body)
      if (!parsed.ok) {
        fail(ctx.res, parsed.reason, 400, deps.ledger().revision)
        return
      }
      const imported = await importBundle(parsed.bundle, parsed.skipped)
      if (!imported.ok) {
        fail(ctx.res, imported.reason, 409, deps.ledger().revision)
        return
      }
      ok(ctx.res, imported, deps.ledger().revision)
    })()
  }

  /**
   * Import a workbench package by its market identity.
   *
   * Format-level compatibility, deliberately: this DSH build has no
   * `desktopWorkbenches` service, so the package's React client cannot be mounted.
   * What *can* be done honestly is unpack it, take its static entry if it has one
   * (or generate a descriptor page if it does not), and show that as a workbench
   * the user can look at and then ask the model to build out.
   */
  function handlePackageImport(ctx: RouteContext): Promise<void> | void {
    return (async () => {
      const body = record(await ctx.body())
      const id = requireString(body, 'id')
      const view = await catalogView(false)
      const entry = view.catalog?.workbenches.find((candidate) => candidate.id === id)
      if (entry === undefined) {
        fail(ctx.res, `the market catalog has no workbench called ${id}`, 404, deps.ledger().revision)
        return
      }
      const downloaded = await downloadWorkbench(entry, { proxy: deps.marketProxy })
      if (!downloaded.ok) {
        fail(
          ctx.res,
          `could not download ${entry.id}: ${downloaded.detail ?? downloaded.reason}`,
          502,
          deps.ledger().revision,
        )
        return
      }
      const packed = bundleFromPackage(downloaded.value, {
        id: entry.id,
        url: entry.url,
        version: entry.version,
      })
      if (!packed.ok) {
        fail(ctx.res, packed.reason, 422, deps.ledger().revision)
        return
      }
      const imported = await importBundle(packed.bundle, packed.skipped, packed.descriptorOnly)
      if (!imported.ok) {
        fail(ctx.res, imported.reason, 409, deps.ledger().revision)
        return
      }
      ok(ctx.res, { ...imported, descriptorOnly: packed.descriptorOnly }, deps.ledger().revision)
    })()
  }

  /**
   * Land a bundle as a project plus a window.
   *
   * The folder is made unique first: importing the same file twice must produce two
   * workbenches, not one silently overwritten one, and `createProject` dedupes by
   * folder by design.
   *
   * The one exception is a market item that is already installed: re-installing it
   * must reuse the existing project, otherwise the second copy lands in
   * `<name> 2` and the market badge points at one copy while the user opens the
   * other. `bundle.origin.id` is the stable identity of a market entry, so it is
   * what identifies "the same workbench".
   */
  async function importBundle(
    bundle: WorkbenchBundle,
    skipped: readonly string[],
    descriptorOnly = false,
  ): Promise<
    | {
        ok: true
        project: ForgeProject
        window: ForgeWindow
        written: string[]
        skipped: string[]
        descriptorOnly: boolean
        reused: boolean
      }
    | { ok: false; reason: string }
  > {
    const ledger = deps.ledger()
    const base = importFolderName(bundle)
    const existing =
      bundle.origin?.kind === 'dsh-desktop' && bundle.origin.id !== undefined
        ? ledger.projects.find(
            (project) =>
              project.origin?.kind === 'dsh-desktop' && project.origin?.id === bundle.origin?.id,
          )
        : undefined
    if (existing !== undefined) {
      // `overwrite` is the whole point of this branch: the user asked for a fresh
      // copy, so the files on disk are replaced. Without it every write is refused
      // as "already exists", `written` comes back empty, and `writeBundle` reports
      // "none of the files could be written" — an install that looks like a
      // permission problem instead of the update it actually is.
      const files = await writeBundle(existing.folder, bundle.files, { overwrite: true })
      if (!files.ok) {
        return { ok: false, reason: files.reason }
      }
      const window = ledger.createWindow({
        projectId: existing.id,
        ...importWindow(bundle),
        // Ready immediately: the entry document is inlined on the row, so there is
        // nothing left for the model to produce before the page can be shown.
        status: 'ready',
      })
      deps.journal(`updated ${existing.name} · ${files.written.length} file(s) re-written`, 'action')
      deps.hub.broadcast({ kind: 'state', revision: ledger.revision })
      return {
        ok: true,
        project: existing,
        window,
        written: files.written,
        skipped: [...skipped, ...files.skipped],
        descriptorOnly,
        reused: true,
      }
    }
    let name = base
    let folder = deps.defaultFolder(name)
    for (let attempt = 2; attempt <= 20; attempt += 1) {
      const taken = ledger.projects.some((project) => project.folder === folder)
      if (!taken) break
      name = `${base} ${attempt}`
      folder = deps.defaultFolder(name)
    }
    const { project } = ledger.createProject({
      name,
      folder,
      ...(bundle.request === undefined ? {} : { request: bundle.request }),
      ...(bundle.origin === undefined ? {} : { origin: bundle.origin }),
    })
    const written = await writeBundle(folder, bundle.files)
    const wrote = written.ok ? written.written : []
    const failures = written.ok ? written.skipped : [written.reason]
    const window = ledger.createWindow({
      projectId: project.id,
      ...importWindow(bundle),
      // Ready immediately: the entry document is inlined on the row, so there is
      // nothing left for the model to produce before the page can be shown.
      status: 'ready',
    })
    deps.journal(
      descriptorOnly
        ? `imported ${project.name} from a dsh-desktop package — it has no static page, so a descriptor was written instead`
        : `imported ${project.name} · ${wrote.length} file(s) written`,
      descriptorOnly ? 'warn' : 'success',
    )
    deps.hub.broadcast({ kind: 'state', revision: ledger.revision })
    return {
      ok: true,
      project,
      window,
      written: wrote,
      skipped: [...skipped, ...failures],
      descriptorOnly,
      reused: false,
    }
  }

  /**
   * The market list.
   *
   * Cached in memory for fifteen minutes, matching the catalog's own cache window:
   * a catalog is a few KiB but the panel refetches it every time it is opened, and
   * hammering someone else's server from a desktop app is rude.
   */
  async function catalogView(force: boolean): Promise<{ catalog?: MarketCatalog; error?: string; fetchedAt: number }> {
    const now = Date.now()
    if (!force && catalogCache !== undefined && now - catalogCache.fetchedAt < CATALOG_TTL_MS) {
      return catalogCache
    }
    const fetched = await fetchCatalog(deps.marketUrl)
    if (!fetched.ok) {
      const message = `${fetched.reason}${fetched.detail === undefined ? '' : `: ${fetched.detail}`}`
      // A failed refresh keeps the last good list: the market being unreachable
      // should not empty a panel the user was reading.
      if (catalogCache?.catalog !== undefined) return { ...catalogCache, error: message }
      return { error: message, fetchedAt: now }
    }
    const view = { catalog: fetched.value, fetchedAt: now }
    catalogCache = view
    return view
  }

  function handleMarket(ctx: RouteContext): Promise<void> | void {
    return (async () => {
      const force = (ctx.query.get('refresh') ?? '') !== ''
      const view = await catalogView(force)
      const ledger = deps.ledger()
      const entries: MarketEntry[] = []
      for (const item of view.catalog?.workbenches ?? []) {
        // Installed-ness is derived from the folder the import would use, so the
        // badge is right even for a package the user imported by hand.
        //
        // The origin check comes first: importing the same package twice lands it
        // in `<folder> 2`, which the exact-folder match can never recognise — the
        // row then keeps offering 「安装」 for a workbench that is already there,
        // and the user installs a third copy. `origin.id` is the market identity
        // recorded at import time, so it survives the rename.
        const folder = deps.defaultFolder(marketFolderName(item.id))
        const installed =
          ledger.projects.find(
            (project) => project.origin?.kind === 'dsh-desktop' && project.origin.id === item.id,
          ) ?? ledger.projects.find((project) => project.folder === folder)
        const description = item.description.zh ?? item.description.en ?? ''
        // "Runnable" would be a promise the Host cannot keep for a React-panel
        // package; the honest tier is "the descriptor page opens and the AI-build
        // button works". A package the user already imported gets the check for
        // real — its folder either holds a page or does not.
        const runnable =
          installed !== undefined &&
          (installed.origin?.kind === 'dsh-desktop'
            ? // An imported market package never had a root page to begin with;
              // the descriptor page ships inline, so "runnable" means the inline
              // document exists rather than a root index.html on disk.
              true
            : (await statArtifact(installed.folder, 'index.html')).ok)
        entries.push({
          id: item.id,
          name: item.name,
          description,
          version: item.version,
          ...(item.category === undefined ? {} : { category: item.category }),
          url: item.url,
          ...(item.license === undefined ? {} : { license: item.license }),
          // The market screenshot (if the catalog ships one) is shown on the card:
          // a user who cannot read code judges a workbench by its picture, and the
          // card is the only place a picture can live.
          ...(item.screenshots !== undefined && item.screenshots.length > 0
            ? { screenshot: (item.screenshots[0] as MarketScreenshot).url }
            : {}),
          // Not runnable natively: every catalog entry is a dsh-desktop package
          // whose panel is a React client registered through `desktopWorkbenches`,
          // a service this DSH build does not expose. Installing one still produces
          // a real, readable window — and its descriptor page carries a working
          // "let the AI build it" button, so the card says "AI-buildable" instead
          // of promising a running workbench.
          runnable,
          ...(installed === undefined ? {} : { installedProjectId: installed.id }),
        })
      }
      const payload: MarketView = {
        source: deps.marketUrl,
        fetchedAt: view.fetchedAt,
        ...(view.error === undefined ? {} : { error: view.error }),
        entries,
      }
      ok(ctx.res, { market: payload }, deps.ledger().revision)
    })()
  }

  /**
   * One-click install of a market workbench.
   *
   * The same operation as `/import/package` under the name the market panel calls
   * it by; delegating keeps one implementation, so the two endpoints cannot drift
   * into behaving differently.
   */
  function handleMarketInstall(ctx: RouteContext): Promise<void> | void {
    return handlePackageImport(ctx)
  }

  /**
   * Proxy one market screenshot.
   *
   * The card `<img>` cannot load `raw.githubusercontent.com` on the networks this
   * plugin targets — the host is DNS-poisoned to `0.0.0.0` on many of them — so
   * the panel points the tag here instead. The Host fetches with the same
   * proxy-fallback the tarball download uses and serves the bytes same-origin;
   * the browser then loads the image from itself, which always resolves.
   *
   * Only https URLs are relayed (an http request would leak browsing context),
   * and only image content types are answered — this endpoint is not a general
   * open proxy, it is a picture relay for the catalog the Host itself fetched.
   */
  function handleScreenshot(ctx: RouteContext): Promise<void> | void {
    return (async () => {
      const url = (ctx.query.get('url') ?? '').trim()
      if (!/^https:\/\/raw\.githubusercontent\.com\//.test(url)) {
        fail(ctx.res, 'only raw.githubusercontent.com images are relayed', 400, deps.ledger().revision)
        return
      }
      const fetched = await fetchImage(url, { proxy: deps.marketProxy })
      if (!fetched.ok) {
        fail(ctx.res, `the screenshot could not be fetched (${fetched.reason})`, 404, deps.ledger().revision)
        return
      }
      const bytes = Buffer.from(fetched.value)
      const ext = (url.split('?')[0]?.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase()
      const contentType =
        ext === 'png'
          ? 'image/png'
          : ext === 'jpg' || ext === 'jpeg'
            ? 'image/jpeg'
            : ext === 'webp'
              ? 'image/webp'
              : ext === 'gif'
                ? 'image/gif'
                : ext === 'svg'
                  ? 'image/svg+xml'
                  : 'application/octet-stream'
      if (ctx.res.headersSent) return
      ctx.res.writeHead(200, {
        'content-type': contentType,
        'content-length': bytes.byteLength,
        'cache-control': 'public, max-age=86400',
        'x-content-type-options': 'nosniff',
      })
      ctx.res.end(bytes)
    })()
  }

  function handleManifest(ctx: RouteContext): Promise<void> | void {
    return (async () => {
      const project = deps.ledger().project(ctx.params.projectId ?? '')
      if (project === undefined) {
        fail(ctx.res, 'no such project', 404, deps.ledger().revision)
        return
      }
      const manifest = await readManifest(project)
      ok(ctx.res, { manifest: manifest ?? null }, deps.ledger().revision)
    })()
  }

  function handleFolder(ctx: RouteContext): Promise<void> | void {
    return (async () => {
      const project = deps.ledger().project(ctx.params.projectId ?? '')
      if (project === undefined) {
        fail(ctx.res, 'no such project', 404, deps.ledger().revision)
        return
      }
      const relative = ctx.query.get('path') ?? ''
      const entries = await listFolder(project, relative)
      ok(ctx.res, { folder: project.folder, path: relative, entries }, deps.ledger().revision)
    })()
  }

  /**
   * Serve a generated artifact.
   *
   * This is the one endpoint that must answer without an envelope and without a
   * token: an iframe loads it as a document. Failures are rendered as a small
   * HTML page instead of JSON so the window shows something a non-coder can read.
   */
  function handleSite(ctx: RouteContext): Promise<void> | void {
    return (async () => {
      const project = deps.ledger().project(ctx.params.projectId ?? '')
      if (project === undefined) {
        serveSiteError(ctx.res, 404, '这个窗口对应的项目不存在了。')
        return
      }
      const relative = ctx.params['*'] ?? ''
      const windows = deps.ledger().windowsOf(project.id)
      const fallbackEntry = windows.find((window) => window.entry.length > 0)?.entry ?? ''
      let result = await readArtifact(project, relative, fallbackEntry)
      if (result.kind === 'file' && (result.contentType ?? '').startsWith('text/html')) {
        // The disk may still hold the v1 descriptor card: a package imported by
        // an older release, or an adoption that found no real page to serve. The
        // v1 card explains the package and stops — a user with no code vocabulary
        // reads it as "broken". Serve a freshly generated v2 page instead: same
        // identity block, plus the build button that actually starts the loop.
        // The folder is the user's, so it is never rewritten on disk.
        const entry = relative.length > 0 ? relative : fallbackEntry
        if (isDescriptorPath(entry) && result.bytes.includes(DESCRIPTOR_V1_MARK)) {
          // The manifest knows the title; the package.json (when the folder came
          // from a market package) knows version and description. Both are best
          // effort — the v2 page renders fine with any of them missing.
          const manifest = await readManifest(project)
          let pkg: { version?: unknown; description?: unknown } | undefined
          try {
            pkg = JSON.parse(await readFile(join(project.folder, 'package.json'), 'utf8')) as { version?: unknown; description?: unknown }
          } catch {
            pkg = undefined
          }
          const version = typeof pkg?.version === 'string' ? pkg.version : project.origin?.version ?? ''
          const description = typeof pkg?.description === 'string' ? pkg.description : manifest?.note ?? project.request ?? ''
          result = {
            kind: 'file',
            path: entry,
            contentType: 'text/html; charset=utf-8',
            bytes: Buffer.from(
              descriptorPage({
                title: manifest?.title ?? project.name,
                identity: project.folder,
                version,
                description,
                repository: project.origin?.url ?? '',
              }),
              'utf8',
            ),
          }
        }
      }
      if (result.kind === 'missing') {
        // An imported workbench may have no folder on this machine at all: the
        // bundle's entry is inlined on the window row precisely so the page still
        // renders. Only the entry document is served this way; a nested asset the
        // import never carried stays a genuine 404.
        const inline = windows.find((window) => (window.inlineHtml ?? '').length > 0)
        if (inline !== undefined) {
          const inlined = inlineArtifact(inline, relative.length > 0 ? relative : inline.entry)
          if (inlined.kind !== 'missing') result = inlined
        }
      }
      if (result.kind === 'forbidden') {
        serveSiteError(ctx.res, 403, result.reason)
        return
      }
      if (result.kind === 'missing') {
        serveSiteError(ctx.res, 404, result.reason)
        return
      }
      if ((result.contentType ?? '').startsWith('text/html')) {
        // The artifact iframe is sandboxed *without* `allow-same-origin`, so the
        // page runs in an opaque origin and touching `localStorage` throws a
        // SecurityError. An artifact that does it at the top level of its only
        // script dies on that line: the page stays half-drawn forever, which is
        // exactly the "installed but does not show" report. A memory-backed shim
        // keeps such a page alive; it is the same isolation, minus the crash.
        //
        // The shim is injected into *every* served document, not only the ones
        // that spell `localStorage` in their markup: the throw almost always
        // happens in a `<script type=module>` asset (the media workbench does it
        // in `analytics.js`, `daily-chart.js` and `dock.js`), where the entry
        // document itself mentions nothing. A one-line probe costs less than the
        // blank page it prevents.
        const original = result.bytes.toString('utf8')
        const patched = withStorageShim(original)
        if (patched !== original) {
          result = {
            kind: 'file',
            path: result.path,
            contentType: 'text/html; charset=utf-8',
            bytes: Buffer.from(patched, 'utf8'),
          }
        }
      }
      if (ctx.res.headersSent) return
      ctx.res.writeHead(200, {
        'content-type': result.contentType,
        'content-length': result.bytes.byteLength,
        // Generated artifacts are self-contained and rewritten in place; caching
        // them would show the user yesterday's build after the model updates it.
        'cache-control': 'no-store',
        // The artifact is framed with `allow-scripts` but *without*
        // `allow-same-origin`, so it runs in an opaque origin — the isolation
        // this route wants. The cost is that every subresource it loads is a
        // cross-origin request: `<script type="module" crossorigin>` (what every
        // Vite build emits) and `<link rel="stylesheet" crossorigin>` are
        // CORS-fetched, and an opaque origin sends `Origin: null`. Without this
        // header the browser blocks the page's own bundle and the window stays
        // blank even though every file is present and reachable. `*` is safe
        // here: these bytes are the user's own artifact, served to an opaque
        // origin that cannot read the app's cookies or storage.
        'access-control-allow-origin': '*',
        // The artifact runs in an iframe; it must not be able to navigate the app
        // or reach its origin. `allow-scripts` without `allow-same-origin` puts it
        // in an opaque origin, which is exactly the isolation wanted here.
        'content-security-policy': "default-src 'self' 'unsafe-inline' data: blob:; frame-ancestors *",
      })
      ctx.res.end(result.bytes)
    })()
  }

  /**
   * The standalone host page.
   *
   * `placement: 'standalone'` windows must keep working when the shell is not
   * the thing displaying them: the user pops one out into a browser tab, or
   * opens the URL directly. A bare artifact URL cannot do that — the artifact's
   * action bridge talks to `parent`, and a top-level tab has no parent. This
   * page *is* the parent: it hosts the artifact in an iframe, relays declared
   * actions to `POST /action` (the same endpoint the in-shell bridge uses, so
   * there is exactly one action path, one journal, one broadcast), and reloads
   * the artifact when the ledger says the model rewrote it.
   */
  function handleStandalone(ctx: RouteContext): Promise<void> | void {
    return (async () => {
      const windowId = ctx.params.windowId ?? ''
      const window = deps.ledger().window(windowId)
      if (window === undefined) {
        serveSiteError(ctx.res, 404, '这个窗口不存在了，可能已被删除。')
        return
      }
      const project = deps.ledger().project(window.projectId)
      if (project === undefined) {
        serveSiteError(ctx.res, 404, '这个窗口对应的项目不存在了。')
        return
      }
      // `url`-kind windows point at an external site; the artifact URL for them
      // is the URL itself, exactly as the in-shell bridge builds it.
      const siteUrl = window.kind === 'url' ? window.entry : `${ROUTE_SITE}/${project.id}/${window.entry}`
      const html = standalonePage({
        windowId,
        title: window.title.length > 0 ? window.title : project.name,
        siteUrl: `${siteUrl}?v=${window.updatedAt}`,
        actions: window.actions.map((decl) => decl.name),
        apiBase: ROUTE_API,
      })
      if (ctx.res.headersSent) return
      ctx.res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(html),
        'cache-control': 'no-store',
      })
      ctx.res.end(html)
    })()
  }

  /**
   * Build the standalone host page.
   *
   * One inline template with no build step and no external asset, so a
   * popped-out window comes up even if every other plugin failed. The script is
   * deliberately small: relay declared actions out, offer a reload, and hand the
   * user a link to the bare artifact. Undeclared actions are dropped here just
   * as the in-shell bridge drops them — the manifest stays the single gate
   * between a page's buttons and the model.
   */
  function standalonePage(input: {
    windowId: string
    title: string
    siteUrl: string
    actions: string[]
    apiBase: string
  }): string {
    const source = JSON.stringify(ACTION_SOURCE)
    const windowId = JSON.stringify(input.windowId)
    const actions = JSON.stringify(input.actions)
    const apiBase = JSON.stringify(input.apiBase)
    const siteUrl = JSON.stringify(input.siteUrl)
    const title = escapeHtml(input.title)
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · AI Workbench</title><style>
:root{color-scheme:light dark}
html,body{margin:0;height:100%}
body{display:flex;flex-direction:column;background:#1b1b1f;color:#c8c8ce;
font:13px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
header{display:flex;align-items:center;gap:10px;padding:6px 12px;
border-bottom:1px solid #333338;flex:none}
header strong{font-weight:600}
header span{opacity:.6}
#bar{margin-left:auto;display:flex;gap:6px}
button{font:inherit;padding:2px 10px;border-radius:6px;cursor:pointer;
border:1px solid #44444a;background:#2a2a30;color:inherit}
button:hover{background:#33333a}
iframe{flex:1;border:0;width:100%;background:#fff}
@media (prefers-color-scheme:light){
body{background:#f4f4f6;color:#4a4a50}header{border-color:#d8d8de}
button{border-color:#c8c8d0;background:#fff}}
</style></head><body>
<header><strong>${title}</strong><span id="status"></span>
<div id="bar"><button id="reload" type="button">重新加载</button>
<button id="openraw" type="button">打开原始页面</button></div></header>
<iframe id="frame" title="${title}"
sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"
referrerpolicy="no-referrer"></iframe>
<script>
(function(){
  var SOURCE=${source}, WINDOW_ID=${windowId}, ACTIONS=${actions};
  var API=${apiBase}, SITE=${siteUrl};
  var frame=document.getElementById('frame');
  var status=document.getElementById('status');
  var statusTimer;
  function flash(text){
    status.textContent=text;
    if(statusTimer)clearTimeout(statusTimer);
    statusTimer=setTimeout(function(){status.textContent=''},4000);
  }
  // Same contract as the in-shell bridge: { source, action, data } posted by
  // the artifact. Declared-only, authenticated by frame identity.
  window.addEventListener('message',function(event){
    var data=event.data;
    if(data===null||typeof data!=='object')return;
    if(data.source!==SOURCE)return;
    if(typeof data.action!=='string'||ACTIONS.indexOf(data.action)<0)return;
    if(event.source!==frame.contentWindow)return;
    send(data.action,data.data);
  });
  function send(action,data){
    flash('→ '+action);
    fetch(API+'/action',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({windowId:WINDOW_ID,action:action,data:data===undefined?null:data})
    }).then(function(r){return r.json()}).then(function(env){
      flash(env&&env.ok?'✓ 已送达模型':'⚠ 未送达'+(env&&env.error?'：'+env.error:''));
    }).catch(function(err){
      flash('⚠ 发送失败：'+err);
    });
  }
  // No SSE on a plain tab; the page is regenerated with the artifact's
  // updatedAt, so an explicit reload is the refresh path.
  function load(){frame.src=SITE+'&standalone=1'}
  document.getElementById('reload').addEventListener('click',load);
  document.getElementById('openraw').addEventListener('click',function(){
    window.open(SITE,'_blank','noopener');
  });
  load();
})();
</script></body></html>`
  }

  /**
   * Make an HTML document survive a sandbox with no storage.
   *
   * The artifact iframe has `allow-scripts` but not `allow-same-origin`, so it
   * runs in an opaque origin and `localStorage.getItem` throws a `SecurityError`
   * before it returns anything. A page that calls it at the top level of its only
   * script stops there and never draws the rest — reported as "installed but
   * nothing shows up". Running the shim first replaces the throwing objects with
   * memory-backed equivalents, so the page continues and its data lives for the
   * lifetime of the iframe (the same lifetime it would have had anyway).
   *
   * Only touched when the document actually mentions storage, so a page that
   * does not use it is served byte-for-byte unchanged.
   */
  function withStorageShim(html: string): string {
    const head = /<head[^>]*>/i.exec(html)
    const at = head === null ? 0 : head.index + head[0].length
    const script =
      '<script>(function(){var memory=function(){var data={};return{getItem:function(key){return Object.prototype.hasOwnProperty.call(data,key)?data[key]:null},setItem:function(key,value){data[key]=String(value)},removeItem:function(key){delete data[key]},clear:function(){data={}},key:function(index){var keys=Object.keys(data);return index>=0&&index<keys.length?keys[index]:null},get length(){return Object.keys(data).length}}};var patch=function(name){try{var live=window[name],probe="__dsh_probe__";live.setItem(probe,"1");live.removeItem(probe);return live}catch(error){Object.defineProperty(window,name,{value:memory(),writable:true,configurable:true})}};patch("localStorage");patch("sessionStorage")})();</script>'
    return `${html.slice(0, at)}${script}${html.slice(at)}`
  }

  function serveSiteError(res: ServerResponse, status: number, message: string): void {
    if (res.headersSent) return
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>AI Workbench</title><style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;
font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;
color:#6b6b70;background:transparent}
div{max-width:32rem;padding:2rem;text-align:center}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;opacity:.7}
</style></head><body><div><p>${escapeHtml(message)}</p><p><code>${status}</code></p></div></body></html>`
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(html),
      'cache-control': 'no-store',
    })
    res.end(html)
  }

  function escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  /** Match a pattern against a path, returning captured params or undefined. */
  function match(pattern: string, path: string): Record<string, string> | undefined {
    const patternParts = pattern.split('/').filter((part) => part.length > 0)
    const pathParts = path.split('/').filter((part) => part.length > 0)
    // A trailing `*` swallows the rest of the path, so the segment counts are not
    // required to be equal in that case.
    const splat = patternParts[patternParts.length - 1] === '*'
    if (!splat && patternParts.length !== pathParts.length) return undefined
    if (splat && pathParts.length < patternParts.length - 1) return undefined
    const params: Record<string, string> = {}
    for (let index = 0; index < patternParts.length; index += 1) {
      const token = patternParts[index]
      if (token === undefined) return undefined
      if (token === '*') {
        params['*'] = pathParts.slice(index).join('/')
        return params
      }
      const actual = pathParts[index]
      if (actual === undefined) return undefined
      if (token.startsWith(':')) {
        params[token.slice(1)] = actual
        continue
      }
      if (token !== actual) return undefined
    }
    return params
  }

  /** The registered handler. */
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      let path = url.pathname
      if (path.startsWith(prefix)) path = path.slice(prefix.length)
      if (path.length === 0) path = '/'
      const method = (req.method ?? 'GET').toUpperCase()
      let matchedPath = false
      for (const route of routes) {
        const params = match(route.pattern, path)
        if (params === undefined) continue
        matchedPath = true
        if (route.method !== method) continue
        const ctx: RouteContext = {
          req,
          res,
          params,
          query: url.searchParams,
          body: () => readJson(req),
        }
        await route.handle(ctx)
        return
      }
      if (matchedPath) {
        fail(res, `${method} is not allowed on ${path}`, 405, deps.ledger().revision)
        return
      }
      fail(res, `no such endpoint: ${path}`, 404, deps.ledger().revision)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      // A handler that threw may already have written; `fail` and `reply` both
      // check `headersSent`, so this is safe either way.
      fail(res, message, 400, deps.ledger().revision)
    }
  }
}

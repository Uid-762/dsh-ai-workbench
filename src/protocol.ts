/**
 * The wire contract shared by both halves of `dsh-ai-workbench`.
 *
 * Everything in this module is either a frozen constant or a type. The Host half
 * imports it for value; the Client half imports it with `import type` only, so
 * the constants are erased from the browser bundle and the two halves cannot
 * drift apart at runtime — a change here is a compile error on both sides.
 *
 * The shape of the product, in one paragraph: a **project** is a folder on disk
 * plus the DSH session that works in it. A **window** is one artifact (a
 * self-contained HTML file the model wrote) placed on the user's screen as a
 * floating panel, optionally with a chat pane bound to the same session. The
 * model writes files; the Host serves them; the client mounts them in an iframe
 * and forwards only the actions the artifact declares.
 *
 * Naming note: the *product* is "AI Workbench" and every identity string below
 * is `ai-workbench`. The internal type vocabulary keeps the verb *forge*
 * (`ForgeWindow`, `ForgeStore`) because that is what the plugin does — it forges
 * a window out of a sentence. Renaming those types would have touched every file
 * for no behavioural gain, and the two halves stay readable. The one thing that
 * is *not* internal — the tool name the model calls — is `workbench_window`,
 * because it is user-visible in transcripts.
 */

/** Bumped when the on-disk ledger layout changes in a way that needs migration. */
export const LEDGER_VERSION = 1

/** Bumped when the client/host message shapes change. */
export const PROTOCOL_VERSION = 2

/**
 * Every route lives under one prefix, registered as a single `prefix` route on
 * `ctx.webServer`. One registration means one duplicate-route failure mode
 * instead of one per endpoint.
 */
export const ROUTE_API = '/apps/ai-workbench/api'

/** The Server-Sent Events stream. Registered as an `exact` route. */
export const ROUTE_EVENTS = '/apps/ai-workbench/events'

/** Static hosting for generated artifacts. The iframe loads from here. */
export const ROUTE_SITE = `${ROUTE_API}/site`

/** Single-file ledger, resolved inside the DSH home directory. */
export const LEDGER_FILE_NAME = 'dsh-ai-workbench.json'

/**
 * The ledger name used before the rename. Read once on first start and then
 * migrated, so an existing user does not lose their windows to a package rename.
 */
export const LEGACY_LEDGER_FILE_NAME = 'dsh-window-forge.json'

/**
 * The manifest a generated artifact may ship next to itself.
 *
 * The model is asked to write this file after producing its HTML. It is the
 * declarative half of the contract: which file is the entry point, what the
 * window is called, and — the part that makes the loop bidirectional — which
 * actions the artifact is allowed to send back.
 */
export const MANIFEST_FILE = '_workbench.json'

/** The manifest name used before the rename; still read as a fallback. */
export const LEGACY_MANIFEST_FILE = '_forge.json'

/** `sidebar.panellist` cell id; also the `main` slot key it selects. */
export const PANEL_ID = 'ai-workbench'

/** `shell.overlay` seat id. A fresh id sits beside the shipped entries. */
export const SEAT_ID = 'ai-workbench'

/** Ordering among the sidebar panel icons. Shipped rows use 0..55. */
export const PANEL_ORDER = 56

/** Floating-window minimums, enforced on the client and in the ledger. */
export const MIN_WINDOW_W = 420
export const MIN_WINDOW_H = 280

/** Caps that keep a runaway model from filling the ledger. */
export const MAX_PROJECTS = 40
export const MAX_WINDOWS_PER_PROJECT = 24
export const MAX_LOG_LINES = 400
export const MAX_CHAT_LINES = 240

/** The `postMessage` tag an artifact must use for the Host to accept its action. */
export const ACTION_SOURCE = 'dsh-ai-workbench'

/**
 * The one action a descriptor page may send.
 *
 * A market package this Host cannot execute natively still gets a real button:
 * its descriptor page posts this action, and the Host answers by prompting the
 * project's session to rebuild `index.html` as a self-contained static page.
 * Declared here (not inline in the page) so the route and the page cannot drift.
 */
export const WORKBENCH_BUILD_ACTION = 'workbench.build'

/**
 * The label that travels with the build action.
 *
 * The descriptor page and the reconcile fallback both need the same button
 * text; declaring it once keeps the two surfaces from drifting apart.
 */
export const WORKBENCH_BUILD_LABEL = '让 AI 搭建这个工作台'

/**
 * The `id` of the build button every generated descriptor page carries.
 *
 * The v2 page script and the site route both look for this element: the page to
 * enable its click handler, the route to tell a healed page from the obsolete
 * v1 card. Declared once so page and route cannot drift.
 */
export const BUILD_BUTTON_ID = 'wb-build'

/**
 * A substring that only the first-generation descriptor page contains.
 *
 * v1 pages were written before this plugin could rebuild anything: they explain
 * that the package needs the dsh-desktop shell and stop there. Both reconcile
 * and the site route use this mark to recognise one and replace it with the
 * v2 page whose build button actually does something.
 */
export const DESCRIPTOR_V1_MARK = 'desktopWorkbenches'

/**
 * Whether a served relative path names a generated descriptor document.
 *
 * True for the bare entry and for any `index.html`, false for assets — a healed
 * page must only ever stand in for the entry itself, never for a stylesheet or
 * script the v1 page happened to reference.
 */
export function isDescriptorPath(entry: string): boolean {
  const normalized = entry.replace(/^\/+/, '').toLowerCase()
  return normalized.length === 0 || normalized === 'index.html' || normalized === 'index.htm'
}

/**
 * The tag used before the rename. Artifacts generated by the previous version
 * keep working: the client bridge accepts either tag and rewrites it to the
 * current one before the action reaches the Host.
 */
export const LEGACY_ACTION_SOURCE = 'dsh-window-forge'

/** Magic string identifying a native, self-contained workbench bundle file. */
export const BUNDLE_FORMAT = 'dsh-ai-workbench-bundle'

/** Bumped when the bundle layout changes. */
export const BUNDLE_VERSION = 1

/** Suffix the panel appends when offering an export for download. */
export const BUNDLE_EXTENSION = '.dshwb.json'

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

/**
 * How an artifact is presented.
 *
 * `html` is served from the project folder through `ROUTE_SITE`. `url` embeds a
 * page the user named directly; it is not sandboxed the same way and is offered
 * as an escape hatch, not the default.
 */
export type ArtifactKind = 'html' | 'url'

/** Lifecycle of a window while the model is working on it. */
export type WindowStatus = 'draft' | 'building' | 'ready' | 'error'

/**
 * Layout presets the panel can pin onto a window.
 *
 * Neither the Host nor the client renderer interprets the value — it travels
 * into the build prompt, where the model is told what shape of page to compose.
 * `auto` means the model decides from the requirement itself.
 */
export const WINDOW_LAYOUTS = [
  'auto',
  'single',
  'two-col',
  'three-col',
  'grid-2x2',
  'top-one',
  'dashboard',
] as const

export type WindowLayout = (typeof WINDOW_LAYOUTS)[number]

/** Where a window appears: inside the shell, or popped out on its own. */
export type WindowPlacement = 'embedded' | 'standalone'

/**
 * Which half of the two-step authoring flow a project is in.
 *
 * `intake` means the model has been asked to interview the user — it must not
 * write files yet. `build` means the requirement is settled and the model may
 * produce the artifact. Keeping this on the project rather than in the client
 * means a reload, a second window, or another device all agree on the phase.
 */
export type ProjectPhase = 'intake' | 'build'

/** Narrow a parsed-JSON value to a layout preset, or `undefined` when it is not one. */
export function windowLayout(value: unknown): WindowLayout | undefined {
  return typeof value === 'string' && (WINDOW_LAYOUTS as readonly string[]).includes(value)
    ? (value as WindowLayout)
    : undefined
}

/** Narrow a parsed-JSON value to a placement, or `undefined` when it is not one. */
export function windowPlacement(value: unknown): WindowPlacement | undefined {
  return value === 'embedded' || value === 'standalone' ? value : undefined
}

/** Narrow a parsed-JSON value to an authoring phase, or `undefined`. */
export function projectPhase(value: unknown): ProjectPhase | undefined {
  return value === 'intake' || value === 'build' ? value : undefined
}

/**
 * One action an artifact declares it will send back.
 *
 * Declaring is what keeps the loop quiet: an artifact that sends anything else
 * is ignored by the client bridge, so the model is not woken by every click.
 */
export interface ForgeActionDecl {
  /** Machine name, matched against the `action` field of the posted message. */
  name: string
  /** Human label, used in the panel and in the transcript line. */
  label?: string
  /** One line telling the model what the action means. */
  description?: string
}

/** A floating window the user sees. */
export interface ForgeWindow {
  id: string
  projectId: string
  title: string
  kind: ArtifactKind
  /** For `html`: path relative to the project folder. For `url`: the URL itself. */
  entry: string
  /** Declared key actions. Anything else posted by the artifact is dropped. */
  actions: ForgeActionDecl[]
  status: WindowStatus
  /** Free-form note from the model, shown when the window has nothing to show. */
  note?: string
  /** Layout preset written into the build prompt. Absent means `auto`. */
  layout?: WindowLayout
  /** Where the window opens. Absent means `embedded`. */
  placement?: WindowPlacement
  /**
   * Artifact source kept in the ledger for windows that did not come from a file
   * on disk — an import, a market download, or a template. The Host serves it
   * through `ROUTE_SITE` only when the project folder has no file at `entry`,
   * so a file on disk always wins over a stale inline copy.
   */
  inlineHtml?: string
  /** The chat pane is open beside this window. */
  chat?: boolean
  x: number
  y: number
  w: number
  h: number
  open: boolean
  minimized: boolean
  fullscreen: boolean
  z: number
  createdAt: number
  updatedAt: number
}

/** A folder plus the session that works in it. */
export interface ForgeProject {
  id: string
  name: string
  /** Absolute folder. Every artifact of this project is written inside it. */
  folder: string
  /** The DSH session the model uses for this project, once one is created. */
  sessionId?: string
  /** The requirement currently being built, kept so the panel can show it. */
  request?: string
  /**
   * `intake` while the model is interviewing the user, `build` once the user
   * confirmed the summary. Absent means `build` for ledgers written by older
   * versions, which had no interview step.
   */
  phase?: ProjectPhase
  /**
   * The user's answers to the interview questions, verbatim. Appended to the
   * build prompt so the artifact is built against what the user actually said
   * rather than against the model's memory of the conversation.
   */
  intake?: string
  /**
   * Set when the user deleted this project's window on purpose.
   *
   * Reconcile adopts a project that has a page on disk but no window row, which
   * is how an orphaned folder becomes visible again. Without this flag that
   * adoption would also undo a deletion: delete the window, and the next poll
   * puts it straight back. The flag records the user's intent so the recovery
   * path cannot fight the delete button. A new window created explicitly for the
   * project clears it again.
   */
  windowDismissed?: boolean
  /**
   * Where this project came from, when it came from an import.
   *
   * The market view uses it to decide what "runnable" means for an installed
   * entry: a dsh-desktop import ships its page inline (descriptor + build
   * button), while a hand-made or `.dshwb.json` project keeps its page on disk
   * and is runnable when that file exists.
   */
  origin?: BundleOrigin
  createdAt: number
  updatedAt: number
}

/** One console/journal line. */
export interface ForgeLogLine {
  id: string
  at: number
  level: 'info' | 'warn' | 'error' | 'action' | 'success'
  text: string
}

/**
 * One line in a window's chat pane.
 *
 * The pane is bound to the project's session, but the transcript lives in the
 * ledger: a window can be closed, the App can be reloaded, and the conversation
 * about *this* workbench must still be there. `context` records the summary of
 * the workbench that was prepended to an outbound message, so the user can see
 * exactly what the model was told.
 */
export interface ForgeChatLine {
  id: string
  projectId: string
  at: number
  role: 'user' | 'model' | 'system'
  text: string
  /** The workbench summary that accompanied an outbound user message. */
  context?: string
}

/** The whole on-disk ledger. */
export interface ForgeLedger {
  version: number
  revision: number
  projects: ForgeProject[]
  windows: ForgeWindow[]
  log: ForgeLogLine[]
  chats: ForgeChatLine[]
}

/** Every JSON response is wrapped so the client never parses an error as data. */
export interface ApiEnvelope<T> {
  ok: boolean
  data?: T
  error?: string
  revision?: number
}

/** The manifest written next to a generated artifact. All fields optional. */
export interface ForgeManifest {
  title?: string
  entry?: string
  actions?: ForgeActionDecl[]
  note?: string
  /** `true` when the model considers the window finished. */
  ready?: boolean
}

/** The message an artifact posts to its parent frame. */
export interface ArtifactAction {
  source: typeof ACTION_SOURCE | typeof LEGACY_ACTION_SOURCE
  action: string
  data?: JsonValue
}

/**
 * One file inside a portable bundle.
 *
 * Text only on purpose: every artifact this plugin produces is a single HTML
 * file with inline CSS and JS. A binary asset would need a different transport
 * and a much bigger trust surface for no product gain.
 */
export interface BundleFile {
  /** POSIX-style path relative to the project folder. */
  path: string
  text: string
}

/**
 * Where a bundle came from.
 *
 * `local` is something a user exported and is re-importing. `dsh-desktop` is a
 * workbench package downloaded from the dsh-desktop market: this Host can read
 * its descriptor and extract a static entry, but it cannot run its React client
 * because the `desktopWorkbenches` service does not exist in this DSH build.
 * Recording the origin lets the UI say that plainly instead of pretending.
 */
export interface BundleOrigin {
  kind: 'local' | 'dsh-desktop'
  /** Market identity, `owner/repository` lowercased, for `dsh-desktop`. */
  id?: string
  url?: string
  version?: string
}

/**
 * A self-contained, shareable workbench.
 *
 * This is the file a user downloads and sends to someone else. It inlines every
 * file, so importing it needs no access to the original folder and no network.
 */
export interface WorkbenchBundle {
  format: typeof BUNDLE_FORMAT
  bundleVersion: number
  name: string
  request?: string
  layout?: WindowLayout
  placement?: WindowPlacement
  /** Files that make up the artifact, entry first. */
  files: BundleFile[]
  /** The entry file path, always one of `files[].path`. */
  entry: string
  actions: ForgeActionDecl[]
  note?: string
  origin?: BundleOrigin
  exportedAt: number
}

/** A dsh-desktop market entry, as the panel renders it. */
export interface MarketEntry {
  id: string
  name: string
  description: string
  version: string
  category?: string
  url: string
  license?: string
  /** First screenshot URL from the catalog, when the entry ships one. */
  screenshot?: string
  /**
   * True when the installed package's page actually opens. A not-yet-installed
   * entry is always false here — the panel's card says "install" either way,
   * and the descriptor page's build button is what makes it usable.
   */
  runnable: boolean
  installedProjectId?: string
}

/** The market list the panel shows. */
export interface MarketView {
  source: string
  fetchedAt: number
  /** Why the list is empty, when it is. */
  error?: string
  entries: MarketEntry[]
}

/**
 * The SSE frame union.
 *
 * `hello` carries the revision the client should consider current; `state` is a
 * full resync; the rest are narrow invalidations. A client that receives a
 * revision gap simply refetches — the stream is a hint, not the source of truth.
 */
export type StreamEventPayload =
  | { kind: 'hello'; revision: number }
  | { kind: 'state'; revision: number }
  | { kind: 'project'; revision: number; projectId: string }
  | { kind: 'window'; revision: number; windowId: string }
  | { kind: 'action'; revision: number; record: ActionRecord }
  | { kind: 'log'; revision: number; line: ForgeLogLine }
  | { kind: 'chat'; revision: number; projectId: string; line: ForgeChatLine }
  | { kind: 'open'; revision: number; windowId?: string; projectId?: string }

/** What the Host did with an action an artifact sent back. */
export interface ActionRecord {
  id: string
  projectId: string
  windowId: string
  action: string
  data?: JsonValue
  timestamp: number
  /** `true` when the text reached a session. */
  delivered: boolean
  /** Why it did not, when `delivered` is false. */
  error?: string
}

/** Limits echoed to the client so the UI and the Host agree on the numbers. */
export interface ForgeLimits {
  minWindowW: number
  minWindowH: number
  maxProjects: number
  maxWindowsPerProject: number
  maxChatLines: number
  protocolVersion: number
}

/** The full snapshot `GET /state` returns. */
export interface ForgeState {
  ledger: ForgeLedger
  limits: ForgeLimits
  /** The session bound to the project the caller asked about, if any. */
  sessionId?: string
  /** The registered skill name, so the panel can offer to open it. */
  skillName?: string
  /**
   * Host-side switches the panel must respect.
   *
   * Reported rather than duplicated in the client: these come from the plugin's
   * Config, which the user edits on the shell's settings page, and a second copy
   * in the browser would drift the moment they change it.
   */
  features?: { interviewFirst: boolean; chatPane: boolean }
}

/** A short, collision-resistant id. Shared so both halves mint the same shape. */
export function newId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 10)
  const stamp = Date.now().toString(36).slice(-4)
  return `${prefix}-${stamp}${random}`
}

/** A filesystem-safe folder name derived from a user-supplied project name. */
export function slugify(name: string): string {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned.length > 0 ? cleaned.slice(0, 48) : 'project'
}

/** An empty ledger. Kept here so both the Host and tests build the same object. */
export function emptyLedger(): ForgeLedger {
  return { version: LEDGER_VERSION, revision: 0, projects: [], windows: [], log: [], chats: [] }
}

/** Clamp a window box to the ledger's invariants. */
export function clampWindowBox(box: {
  x: number
  y: number
  w: number
  h: number
}): { x: number; y: number; w: number; h: number } {
  return {
    x: Math.round(box.x),
    y: Math.round(box.y),
    w: Math.max(MIN_WINDOW_W, Math.round(box.w)),
    h: Math.max(MIN_WINDOW_H, Math.round(box.h)),
  }
}

/** The default project phase when a ledger predates the interview step. */
export function effectivePhase(project: ForgeProject): ProjectPhase {
  return project.phase ?? 'build'
}

/** True when `value` looks like a native bundle this plugin can import. */
export function isWorkbenchBundle(value: unknown): value is WorkbenchBundle {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<WorkbenchBundle>
  return (
    candidate.format === BUNDLE_FORMAT &&
    typeof candidate.name === 'string' &&
    typeof candidate.entry === 'string' &&
    Array.isArray(candidate.files) &&
    candidate.files.length > 0
  )
}

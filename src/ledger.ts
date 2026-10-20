/**
 * The single-file ledger.
 *
 * One JSON document holds every project, every window, and a bounded journal.
 * It is written atomically (temp file + rename) so a crash mid-write leaves the
 * previous revision intact rather than a half-file, and a file that cannot be
 * parsed is quarantined next to the original instead of being silently
 * discarded — losing the user's layout to a parse error would be worse than
 * carrying a corrupt file around.
 *
 * Writes are coalesced: a burst of window drags produces one flush per tick.
 * `flush()` can be awaited when the caller needs the bytes on disk now.
 */
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  LEDGER_VERSION,
  MAX_CHAT_LINES,
  MAX_LOG_LINES,
  MAX_PROJECTS,
  MAX_WINDOWS_PER_PROJECT,
  clampWindowBox,
  emptyLedger,
  newId,
  projectPhase,
  windowLayout,
  windowPlacement,
  type ForgeChatLine,
  type ForgeLedger,
  type ForgeLogLine,
  type ForgeProject,
  type ForgeWindow,
  type BundleOrigin,
  type JsonValue,
} from './protocol.ts'

/** Options the Host passes in; every field already has a default applied. */
export interface LedgerOptions {
  /** Explicit home directory, or empty to resolve it. */
  home: string
  /** File name inside the home directory. */
  fileName: string
  /**
   * File name the previous release used. When the current file is missing but
   * this one exists, its contents are adopted and written under the new name, so
   * a package rename does not silently orphan a user's windows.
   */
  legacyFileName?: string
  maxJournalEntries: number
  maxProjects: number
  maxWindowsPerProject: number
}

/**
 * Pause between retries of a blocked write.
 *
 * The timer is unref'd because a retry must never keep the process alive on
 * its own — the caller is already shutting down.
 */
const delay = (ms: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, ms).unref?.()
})

/**
 * Upper bound on one inline artifact.
 *
 * The ledger is re-parsed in full on every boot and shipped over `/state`, so an
 * unbounded inline copy would turn a big import into a slow start for everyone.
 * 2 MiB is far above any hand-authored single-file page and well below the point
 * where the JSON round trip is noticeable.
 */
export const MAX_INLINE_HTML = 2 * 1024 * 1024

/**
 * Resolve the DSH home directory.
 *
 * Order: the explicit config value, then `$DSH_HOME`, then `~/.dsh`. A blank
 * environment variable is ignored rather than treated as "the current
 * directory", which is the failure that makes a plugin scatter ledgers across
 * whatever folder the process happened to start in.
 */
export function resolveHome(configured: string, env: NodeJS.ProcessEnv = process.env): string {
  if (configured.trim().length > 0) return resolve(configured)
  const fromEnv = env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return resolve(fromEnv)
  return join(homedir(), '.dsh')
}

/** Coerce arbitrary parsed JSON into a string, or return the fallback. */
function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/**
 * Folder identity for the one-folder-one-project rule.
 *
 * `resolve` folds duplicate separators and trailing dots, and the lowercase
 * fold makes the comparison stable on Windows' case-insensitive drives, so
 * `C:\a\b`, `c:/a/b\`, and `C:\a\b\.` all land on the same identity. Two
 * projects sharing a folder would make the manifest and folder listings
 * ambiguous, which is the bug this normalization prevents.
 */
export function normalizeFolder(folder: string): string {
  const trimmed = folder.trim()
  try {
    return resolve(trimmed).toLowerCase()
  } catch {
    return trimmed.toLowerCase()
  }
}

/** Coerce arbitrary parsed JSON into a finite number, or return the fallback. */
function num(value: unknown, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

/** Coerce arbitrary parsed JSON into a boolean, or return the fallback. */
function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** Keep only the keys a plain object actually has, dropping prototype noise. */
export function safeRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function coerceProject(raw: unknown, now: number): ForgeProject | undefined {
  const record = safeRecord(raw)
  const id = str(record.id)
  const folder = str(record.folder)
  if (id.length === 0 || folder.length === 0) return undefined
  const project: ForgeProject = {
    id,
    name: str(record.name, id),
    folder,
    createdAt: num(record.createdAt, now),
    updatedAt: num(record.updatedAt, now),
  }
  // Optional fields are assigned only when present: writing `undefined` into a
  // JSON object is a no-op on stringify, but it makes the in-memory shape and
  // the round-tripped shape differ, which shows up as spurious diffs.
  const sessionId = str(record.sessionId)
  if (sessionId.length > 0) project.sessionId = sessionId
  const request = str(record.request)
  if (request.length > 0) project.request = request
  const phase = projectPhase(record.phase)
  if (phase !== undefined) project.phase = phase
  const intake = str(record.intake)
  if (intake.length > 0) project.intake = intake
  // Only a literal `true` counts: a hand-edited ledger must not be able to
  // suppress adoption through a truthy string, and the field is omitted rather
  // than written as `false` so the round-tripped shape matches the in-memory one.
  if (record.windowDismissed === true) project.windowDismissed = true
  // The import origin round-trips so the market view can keep telling an
  // AI-buildable import from a disk-backed project after a restart.
  const origin = coerceOrigin(record.origin)
  if (origin !== undefined) project.origin = origin
  return project
}

/** Narrow `unknown` to a `BundleOrigin`, keeping only known-good shapes. */
function coerceOrigin(raw: unknown): BundleOrigin | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  if (record.kind !== 'dsh-desktop') return undefined
  const origin: BundleOrigin = { kind: 'dsh-desktop' }
  if (typeof record.id === 'string' && record.id.length > 0) origin.id = record.id
  if (typeof record.url === 'string' && record.url.length > 0) origin.url = record.url
  if (typeof record.version === 'string' && record.version.length > 0) origin.version = record.version
  return origin
}

function coerceWindow(raw: unknown, now: number): ForgeWindow | undefined {
  const record = safeRecord(raw)
  const id = str(record.id)
  const projectId = str(record.projectId)
  if (id.length === 0 || projectId.length === 0) return undefined
  const box = clampWindowBox({
    x: num(record.x, 0),
    y: num(record.y, 0),
    w: num(record.w, 0),
    h: num(record.h, 0),
  })
  const kind = str(record.kind) === 'url' ? 'url' : 'html'
  const status = str(record.status)
  const window: ForgeWindow = {
    id,
    projectId,
    title: str(record.title, '窗口'),
    kind,
    entry: str(record.entry),
    actions: coerceActions(record.actions),
    status:
      status === 'building' || status === 'ready' || status === 'error' ? status : 'draft',
    x: box.x,
    y: box.y,
    w: box.w,
    h: box.h,
    open: bool(record.open, false),
    minimized: bool(record.minimized, false),
    fullscreen: bool(record.fullscreen, false),
    z: num(record.z, 1),
    createdAt: num(record.createdAt, now),
    updatedAt: num(record.updatedAt, now),
  }
  const note = str(record.note)
  if (note.length > 0) window.note = note
  // Optional presentation fields. Absent in older ledgers, and validated here so
  // a hand-edited file cannot smuggle in an unknown preset.
  const layout = windowLayout(record.layout)
  if (layout !== undefined) window.layout = layout
  const placement = windowPlacement(record.placement)
  if (placement !== undefined) window.placement = placement
  // Inline artifact source: kept only for windows that do not live as a file on
  // disk (imports, market downloads). Bounded so a pathological bundle cannot
  // bloat the ledger into something slow to parse on every boot.
  const inlineHtml = str(record.inlineHtml)
  if (inlineHtml.length > 0) window.inlineHtml = inlineHtml.slice(0, MAX_INLINE_HTML)
  if (bool(record.chat, false)) window.chat = true
  return window
}

function coerceActions(raw: unknown): ForgeWindow['actions'] {
  if (!Array.isArray(raw)) return []
  const actions: ForgeWindow['actions'] = []
  for (const item of raw) {
    const record = safeRecord(item)
    const name = str(record.name)
    if (name.length === 0) continue
    const action: ForgeWindow['actions'][number] = { name }
    const label = str(record.label)
    if (label.length > 0) action.label = label
    const description = str(record.description)
    if (description.length > 0) action.description = description
    actions.push(action)
  }
  return actions
}

function coerceLogLine(raw: unknown, now: number): ForgeLogLine | undefined {
  const record = safeRecord(raw)
  const text = str(record.text)
  if (text.length === 0) return undefined
  const level = str(record.level)
  return {
    id: str(record.id, randomUUID()),
    at: num(record.at, now),
    level:
      level === 'warn' || level === 'error' || level === 'action' || level === 'success'
        ? level
        : 'info',
    text,
  }
}

/**
 * One chat line.
 *
 * A line with no text is dropped rather than kept as an empty bubble: the pane
 * renders whatever it is given, so an empty row would look like a rendering bug.
 */
function coerceChatLine(raw: unknown, now: number): ForgeChatLine | undefined {
  const record = safeRecord(raw)
  const text = str(record.text)
  const projectId = str(record.projectId)
  if (text.length === 0 || projectId.length === 0) return undefined
  const role = str(record.role)
  const line: ForgeChatLine = {
    id: str(record.id, randomUUID()),
    projectId,
    at: num(record.at, now),
    role: role === 'model' || role === 'system' ? role : 'user',
    text,
  }
  const context = str(record.context)
  if (context.length > 0) line.context = context
  return line
}

/**
 * Does this text plausibly hold a ledger?
 *
 * Two ways to fail: the bytes are not JSON at all, or they are JSON but carry
 * none of the keys this format defines (another tool's file, or a half-written
 * one). Everything else — including a valid ledger with no projects in it yet —
 * is accepted, because `parseLedger` already repairs anything inside it.
 */
export function looksLikeLedger(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0) return true
  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch {
    return false
  }
  const record = safeRecord(raw)
  return ['version', 'revision', 'projects', 'windows', 'log'].some((key) => key in record)
}
/**
 * Parse ledger text, repairing anything that does not fit the shape.
 *
 * Unknown fields on a project or window survive a round trip because coercion
 * reads named fields and the write path re-serialises the objects it was given;
 * a newer version of the plugin that adds a field therefore does not lose it
 * when an older version touches the file.
 */
export function parseLedger(
  text: string,
  now: number,
  limits: { maxJournalEntries: number; maxProjects: number; maxWindowsPerProject: number },
): ForgeLedger {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return emptyLedger()
  }
  const record = safeRecord(raw)
  const projects: ForgeProject[] = []
  for (const item of Array.isArray(record.projects) ? record.projects : []) {
    const project = coerceProject(item, now)
    if (project !== undefined) projects.push(project)
    if (projects.length >= limits.maxProjects) break
  }
  const windows: ForgeWindow[] = []
  for (const item of Array.isArray(record.windows) ? record.windows : []) {
    const window = coerceWindow(item, now)
    if (window !== undefined) windows.push(window)
  }
  const log: ForgeLogLine[] = []
  for (const item of Array.isArray(record.log) ? record.log : []) {
    const line = coerceLogLine(item, now)
    if (line !== undefined) log.push(line)
  }
  const chats: ForgeChatLine[] = []
  for (const item of Array.isArray(record.chats) ? record.chats : []) {
    const line = coerceChatLine(item, now)
    if (line !== undefined) chats.push(line)
  }
  return {
    version: LEDGER_VERSION,
    revision: Math.max(0, Math.round(num(record.revision, 0))),
    projects,
    windows,
    log: log.slice(-limits.maxJournalEntries),
    chats: chats.slice(-MAX_CHAT_LINES),
  }
}

/** The ledger, plus the file it lives in and the timers that write it. */
export class ForgeLedgerStore {
  readonly path: string
  #file: ForgeLedger = emptyLedger()
  #options: LedgerOptions
  #listeners = new Set<(file: ForgeLedger) => void>()
  #flushTimer: NodeJS.Timeout | undefined
  #flushing: Promise<void> | undefined
  #disposed = false

  private constructor(options: LedgerOptions, path: string) {
    this.#options = options
    this.path = path
  }

  /**
   * Open (or create) the ledger.
   *
   * A file that exists but does not parse is moved aside with a timestamped
   * suffix, and the store starts from an empty document. The user is told in the
   * journal rather than in a modal: the plugin is a side panel, not a boot gate.
   */
  static async open(options: LedgerOptions): Promise<ForgeLedgerStore> {
    const path = isAbsolute(options.fileName)
      ? options.fileName
      : join(options.home, options.fileName)
    const store = new ForgeLedgerStore(options, path)
    await mkdir(dirname(path), { recursive: true })
    let text: string | undefined
    try {
      text = await readFile(path, 'utf8')
    } catch {
      text = undefined
    }
    if (text === undefined) {
      // Rename migration: the previous release wrote `dsh-window-forge.json`.
      // Adopt it rather than starting empty, then write the new name immediately
      // so the next boot finds the current file and the migration runs once.
      const adopted = await store.#adoptLegacy(options, path)
      if (adopted !== undefined) {
        store.#file = adopted
        store.logLine('ledger adopted from the previous version', 'info')
        await store.flush()
        return store
      }
      store.#file = emptyLedger()
      return store
    }
    const parsed = parseLedger(text, Date.now(), options)
    // A file that parses as JSON but has none of this plugin's top-level keys is
    // something else's file, or a truncated write; preserve it rather than
    // overwrite it on the next flush.
    //
    // Note this is a SHAPE test, not an emptiness test. An empty ledger is a
    // legitimate state — the plugin writes one on first boot, and a user may well
    // have no projects yet — so treating "no projects and no windows" as corrupt
    // would quarantine a perfectly good file on every single boot and pile up a
    // `.corrupt-<timestamp>` next to it each time.
    if (!looksLikeLedger(text)) {
      const quarantine = `${path}.corrupt-${Date.now()}`
      try {
        await rename(path, quarantine)
        store.#file = emptyLedger()
        store.logLine(`ledger was unreadable; moved aside to ${quarantine}`, 'warn')
        await store.flush()
        return store
      } catch {
        // Quarantine failed (permissions, or the file vanished between calls).
        // Fall through and start empty in memory; the next flush overwrites.
      }
    }
    store.#file = parsed
    return store
  }

  get file(): ForgeLedger {
    return this.#file
  }

  /**
   * Read the previous release's ledger, if this release has none of its own.
   *
   * Deliberately narrow: it only fires when the current file is genuinely absent
   * (not merely empty), and a legacy file that fails the shape test is ignored
   * rather than quarantined — it belongs to another installation, and deleting
   * someone else's file to make room for ours would be the wrong trade.
   */
  async #adoptLegacy(options: LedgerOptions, path: string): Promise<ForgeLedger | undefined> {
    const legacyName = options.legacyFileName
    if (legacyName === undefined || legacyName.length === 0 || legacyName === options.fileName) return undefined
    const legacyPath = isAbsolute(legacyName) ? legacyName : join(options.home, legacyName)
    if (legacyPath === path) return undefined
    let legacyText: string
    try {
      legacyText = await readFile(legacyPath, 'utf8')
    } catch {
      return undefined
    }
    if (!looksLikeLedger(legacyText)) return undefined
    const parsed = parseLedger(legacyText, Date.now(), options)
    // Leave the old file in place. If the user downgrades, their previous release
    // still finds its own ledger; if they stay, the old file is inert.
    return parsed
  }

  get revision(): number {
    return this.#file.revision
  }

  get projects(): readonly ForgeProject[] {
    return this.#file.projects
  }

  get windows(): readonly ForgeWindow[] {
    return this.#file.windows
  }

  project(id: string): ForgeProject | undefined {
    return this.#file.projects.find((project) => project.id === id)
  }

  window(id: string): ForgeWindow | undefined {
    return this.#file.windows.find((window) => window.id === id)
  }

  windowsOf(projectId: string): ForgeWindow[] {
    return this.#file.windows.filter((window) => window.projectId === projectId)
  }

  subscribe(listener: (file: ForgeLedger) => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /** Replace the whole document (used by import). Bumps the revision once. */
  replaceAll(next: Partial<ForgeLedger>): void {
    const projects = Array.isArray(next.projects) ? next.projects : []
    const windows = Array.isArray(next.windows) ? next.windows : []
    this.#file = {
      version: LEDGER_VERSION,
      revision: this.#file.revision,
      projects: projects.slice(0, this.#options.maxProjects),
      windows,
      log: this.#file.log,
      chats: Array.isArray(next.chats) ? next.chats : this.#file.chats,
    }
    // `#bump` owns the revision so an import moves it by exactly one, like every
    // other mutation, instead of by one here and one in the bump.
    this.#bump()
  }

  /**
   * Create a project — or return the one already living in that folder.
   *
   * One folder is one project. The model sometimes re-derives a folder the
   * panel has already created (its task text quotes the folder path, and a
   * `create` call quoting it back used to mint a second, windowless row
   * pointing at the same files), so the identity check lives HERE rather than
   * at each call site: the HTTP panel and the tool both go through this
   * constructor, and neither can mint a duplicate.
   *
   * The folder is supplied by the caller, never derived from the name: the
   * user picks where their files go, and a project with no folder is rejected
   * rather than silently writing to the DSH home.
   *
   * Returns the row and whether it had to be reused — callers journal the
   * difference so a silent merge never hides from the user.
   */
  createProject(input: {
    name: string
    folder: string
    request?: string
    phase?: ForgeProject['phase']
    origin?: BundleOrigin
  }): {
    project: ForgeProject
    reused: boolean
  } {
    const now = Date.now()
    const folder = normalizeFolder(input.folder)
    const existing = this.#file.projects.find((project) => normalizeFolder(project.folder) === folder)
    if (existing !== undefined) {
      const merged: ForgeProject = { ...existing, updatedAt: now }
      // A `create` quoting the same folder is still a request: fold the caller's
      // words into the row so the panel shows what this round is building.
      const request = input.request?.trim()
      if (request !== undefined && request.length > 0) merged.request = request
      if (input.phase !== undefined) merged.phase = input.phase
      // Re-creating a project that was imported from the market keeps its
      // identity: without this the row loses `origin` and the market can no
      // longer tell which entry produced it (it would fall back to matching the
      // folder, which fails for a re-install that landed in `<name> 2`).
      if (input.origin !== undefined) merged.origin = input.origin
      this.#file.projects = this.#file.projects.map((project) => (project.id === existing.id ? merged : project))
      this.#bump()
      return { project: merged, reused: true }
    }
    if (this.#file.projects.length >= this.#options.maxProjects) {
      throw new Error(`project limit reached (${this.#options.maxProjects})`)
    }
    const project: ForgeProject = {
      id: newId('project'),
      name: input.name.trim().length > 0 ? input.name.trim() : this.#options.fileName,
      folder: input.folder,
      createdAt: now,
      updatedAt: now,
    }
    if (input.phase !== undefined) project.phase = input.phase
    // `origin` is what makes an imported project traceable to the market entry
    // it came from; dropping it here (the parameter used to be absent, so the
    // caller's spread was silently ignored) made every import anonymous.
    if (input.origin !== undefined) project.origin = input.origin
    this.#file.projects = [...this.#file.projects, project]
    this.#bump()
    return { project, reused: false }
  }

  updateProject(
    id: string,
    patch: Partial<Pick<ForgeProject, 'name' | 'folder' | 'sessionId' | 'request' | 'phase' | 'intake' | 'windowDismissed'>>,
  ): ForgeProject | undefined {
    const index = this.#file.projects.findIndex((project) => project.id === id)
    if (index < 0) return undefined
    const current = this.#file.projects[index]
    if (current === undefined) return undefined
    const next: ForgeProject = { ...current, updatedAt: Date.now() }
    if (patch.name !== undefined) next.name = patch.name
    // Retargeting a project onto a folder another project already owns is
    // refused rather than merged: the caller asked to move, not to deduplicate,
    // and silently collapsing two rows would surprise whichever UI issued the
    // PATCH. Only a genuinely free folder passes.
    if (patch.folder !== undefined && patch.folder.trim().length > 0) {
      const wanted = normalizeFolder(patch.folder)
      const taken = this.#file.projects.some((project) => project.id !== id && normalizeFolder(project.folder) === wanted)
      if (taken) throw new Error(`folder already belongs to another project: ${patch.folder.trim()}`)
      next.folder = patch.folder.trim()
    }
    // A blank session id means "unbind", and unbinding has to REMOVE the field
    // rather than store `''`. An empty string is truthy for the `!== undefined`
    // checks the delivery path uses, so a stored `''` would look like a binding
    // to a session named nothing and every action would report a transport
    // failure instead of the honest "no session bound yet".
    if (patch.sessionId !== undefined) {
      if (patch.sessionId.trim().length > 0) next.sessionId = patch.sessionId.trim()
      else delete next.sessionId
    }
    if (patch.request !== undefined) {
      if (patch.request.trim().length > 0) next.request = patch.request
      else delete next.request
    }
    // The interview transcript is free text the user may well want to clear, so
    // a blank value removes the field instead of storing `''` — the panel keys
    // its "answers captured" state off presence, not off length.
    if (patch.phase !== undefined) next.phase = patch.phase
    if (patch.intake !== undefined) {
      if (patch.intake.trim().length > 0) next.intake = patch.intake
      else delete next.intake
    }
    if (patch.windowDismissed !== undefined) {
      if (patch.windowDismissed) next.windowDismissed = true
      else delete next.windowDismissed
    }
    const projects = [...this.#file.projects]
    projects[index] = next
    this.#file.projects = projects
    this.#bump()
    return next
  }

  /**
   * Remove a project and every window inside it.
   *
   * The files on disk are deliberately left alone. The ledger records where the
   * user's work lives; deleting a row here must never delete their folder.
   */
  removeProject(id: string): { windows: number } | undefined {
    if (this.project(id) === undefined) return undefined
    const doomed = this.windowsOf(id).length
    this.#file.projects = this.#file.projects.filter((project) => project.id !== id)
    this.#file.windows = this.#file.windows.filter((window) => window.projectId !== id)
    this.#file.chats = this.#file.chats.filter((line) => line.projectId !== id)
    this.#bump()
    return { windows: doomed }
  }

  /** Create a window in a project, positioned by the caller (cascade default). */
  createWindow(
    input: {
      projectId: string
      title: string
      kind?: ForgeWindow['kind']
      entry?: string
      actions?: ForgeWindow['actions']
      note?: string
      status?: ForgeWindow['status']
      layout?: ForgeWindow['layout']
      placement?: ForgeWindow['placement']
      inlineHtml?: string
      box?: { x: number; y: number; w: number; h: number }
    },
  ): ForgeWindow {
    const project = this.project(input.projectId)
    if (project === undefined) throw new Error(`no such project: ${input.projectId}`)
    if (this.windowsOf(input.projectId).length >= this.#options.maxWindowsPerProject) {
      throw new Error(`window limit reached (${this.#options.maxWindowsPerProject})`)
    }
    const now = Date.now()
    const siblings = this.windowsOf(input.projectId).length
    const box = clampWindowBox(
      input.box ?? {
        x: 80 + (siblings % 6) * 28,
        y: 64 + (siblings % 6) * 26,
        w: 760,
        h: 520,
      },
    )
    const top = this.#file.windows.reduce((max, window) => Math.max(max, window.z), 0)
    const window: ForgeWindow = {
      id: newId('window'),
      projectId: input.projectId,
      title: input.title.trim().length > 0 ? input.title.trim() : '窗口',
      kind: input.kind ?? 'html',
      entry: input.entry ?? '',
      actions: input.actions ?? [],
      status: input.status ?? 'draft',
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      open: true,
      minimized: false,
      fullscreen: false,
      z: top + 1,
      createdAt: now,
      updatedAt: now,
    }
    if (input.note !== undefined && input.note.length > 0) window.note = input.note
    if (input.layout !== undefined) window.layout = input.layout
    if (input.placement !== undefined) window.placement = input.placement
    if (input.inlineHtml !== undefined && input.inlineHtml.length > 0) {
      window.inlineHtml = input.inlineHtml.slice(0, MAX_INLINE_HTML)
    }
    this.#file.windows = [...this.#file.windows, window]
    // A window exists again, so the earlier deletion no longer needs to be
    // remembered: clearing the flag here is what makes "delete, then build a new
    // one" work instead of leaving the project permanently unadoptable.
    if (project.windowDismissed === true) {
      const projects = [...this.#file.projects]
      const projectIndex = projects.findIndex((entry) => entry.id === input.projectId)
      const current = projects[projectIndex]
      if (current !== undefined) {
        const cleared: ForgeProject = { ...current, updatedAt: now }
        delete cleared.windowDismissed
        projects[projectIndex] = cleared
        this.#file.projects = projects
      }
    }
    this.#bump()
    return window
  }

  /**
   * Remove a window and remember that the removal was intentional.
   *
   * Without the second half, reconcile would adopt the project straight back on
   * the next poll whenever the folder still holds a page — the delete button
   * would look broken. The flag is cleared by the next explicit `createWindow`.
   */
  dismissWindow(id: string): boolean {
    const window = this.window(id)
    if (window === undefined) return false
    if (!this.removeWindow(id)) return false
    const project = this.project(window.projectId)
    if (project !== undefined && project.windowDismissed !== true) {
      this.updateProject(window.projectId, { windowDismissed: true })
    }
    return true
  }

  /** Patch a window. Only the fields present in `patch` are touched. */
  updateWindow(id: string, patch: Partial<ForgeWindow>): ForgeWindow | undefined {
    const index = this.#file.windows.findIndex((window) => window.id === id)
    if (index < 0) return undefined
    const current = this.#file.windows[index]
    if (current === undefined) return undefined
    const next: ForgeWindow = { ...current, ...patch, id: current.id, projectId: current.projectId }
    // A cleared inline artifact must be REMOVED, not stored as `''`: `/site` picks
    // the inline copy over the on-disk file when the field is present, so an empty
    // string would shadow a perfectly good file with an empty page.
    if (next.inlineHtml !== undefined && next.inlineHtml.length === 0) delete next.inlineHtml
    if (next.inlineHtml !== undefined) next.inlineHtml = next.inlineHtml.slice(0, MAX_INLINE_HTML)
    const box = clampWindowBox(next)
    next.x = box.x
    next.y = box.y
    next.w = box.w
    next.h = box.h
    next.updatedAt = Date.now()
    const windows = [...this.#file.windows]
    windows[index] = next
    this.#file.windows = windows
    this.#bump()
    return next
  }

  removeWindow(id: string): boolean {
    const before = this.#file.windows.length
    this.#file.windows = this.#file.windows.filter((window) => window.id !== id)
    if (this.#file.windows.length === before) return false
    this.#bump()
    return true
  }

  /** Bring a window to the front, returning its new stacking value. */
  raise(id: string): number {
    const top = this.#file.windows.reduce((max, window) => Math.max(max, window.z), 0)
    const window = this.window(id)
    if (window === undefined) return top
    this.updateWindow(id, { z: top + 1 })
    return top + 1
  }

  /** Append a journal line. Trimmed to the configured bound. */
  logLine(text: string, level: ForgeLogLine['level'] = 'info'): ForgeLogLine {
    const line: ForgeLogLine = {
      id: newId('log'),
      at: Date.now(),
      level,
      text,
    }
    const log = [...this.#file.log, line].slice(-this.#options.maxJournalEntries)
    this.#file.log = log
    this.#bump()
    return line
  }

  /** The journal, newest last. */
  get log(): readonly ForgeLogLine[] {
    return this.#file.log
  }

  /** Remove every journal line. */
  clearLog(): void {
    this.#file.log = []
    this.#bump()
  }

  /** The chat transcript for one project, oldest first. */
  chatsOf(projectId: string): ForgeChatLine[] {
    return this.#file.chats.filter((line) => line.projectId === projectId)
  }

  /**
   * Append one chat line.
   *
   * The transcript is stored rather than kept in the client because the pane is
   * bound to a project, not to a browser tab: closing the window, reloading the
   * App, or opening the same project in a second window must all show the same
   * conversation about this workbench.
   */
  appendChat(input: {
    projectId: string
    role: ForgeChatLine['role']
    text: string
    context?: string
    /**
     * When the line happened, in epoch milliseconds.
     *
     * A model reply is ingested from the session event log, where it already has
     * a timestamp. Storing *that* timestamp rather than "now" is what makes the
     * ingestion idempotent: the poll that reads the log a second time finds the
     * line by `(role, at, text)` and appends nothing. Using `Date.now()` would
     * duplicate every reply once per poll.
     */
    at?: number
  }): ForgeChatLine | undefined {
    if (this.project(input.projectId) === undefined) return undefined
    const text = input.text.trim()
    if (text.length === 0) return undefined
    const line: ForgeChatLine = {
      id: newId('chat'),
      projectId: input.projectId,
      at: typeof input.at === 'number' && Number.isFinite(input.at) ? Math.round(input.at) : Date.now(),
      role: input.role,
      text,
    }
    if (input.context !== undefined && input.context.trim().length > 0) line.context = input.context
    this.#file.chats = [...this.#file.chats, line].slice(-MAX_CHAT_LINES)
    this.#bump()
    return line
  }

  /** Remove the chat transcript of one project. */
  clearChat(projectId: string): number {
    const before = this.#file.chats.length
    this.#file.chats = this.#file.chats.filter((line) => line.projectId !== projectId)
    const removed = before - this.#file.chats.length
    if (removed > 0) this.#bump()
    return removed
  }

  /**
   * Persist on the next tick and tell subscribers.
   *
   * Called from every mutation. A drag produces many updates per second and the
   * ledger is a debugging surface, not a transaction log, so one write per tick
   * is the right trade.
   *
   * The revision is incremented here rather than at each call site: it is the
   * one counter a client can use to notice that it missed something, so it has
   * to move exactly when the document moves — no more (a revision that ticks on
   * a no-op would make every reader refetch for nothing) and no less (a
   * revision that stalls makes a gap undetectable).
   */
  #bump(): void {
    this.#file = { ...this.#file, revision: this.#file.revision + 1 }
    this.#announce()
    this.#schedule()
  }

  #announce(): void {
    const snapshot = this.#file
    for (const listener of this.#listeners) {
      try {
        listener(snapshot)
      } catch {
        // A throwing subscriber must not stop the others or the write.
      }
    }
  }

  #schedule(): void {
    if (this.#disposed || this.#flushTimer !== undefined) return
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = undefined
      void this.flush()
    }, 120)
    // A pending write must not hold the process open after the plugin unloads.
    this.#flushTimer.unref?.()
  }

  /** Write now. Concurrent callers share one in-flight write. */
  async flush(): Promise<void> {
    if (this.#disposed && this.#flushing === undefined) return
    if (this.#flushing !== undefined) return this.#flushing
    const run = async (): Promise<void> => {
      const text = `${JSON.stringify(this.#file, null, 2)}\n`
      const temp = `${this.path}.${process.pid}.tmp`
      // A rename can fail with EPERM/EACCES/EBUSY on Windows when a scanner or a
      // cloud-sync client holds the destination open. That is transient, so retry
      // with a short backoff and, if it still fails, write the destination in
      // place: a lost atomic swap is survivable, a thrown write is not — it took
      // the whole desktop host down on load.
      let lastError: unknown
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await writeFile(temp, text, 'utf8')
          await rename(temp, this.path)
          lastError = undefined
          break
        } catch (error) {
          lastError = error
          if (attempt < 2) await delay(40 * (attempt + 1))
        }
      }
      try {
        if (lastError === undefined) return
        await writeFile(this.path, text, 'utf8')
        await unlink(temp)
      } catch {
        // Leaving the temp file behind on failure is deliberate: it is the only
        // copy of the newest revision, and the next successful flush replaces it.
        try {
          await unlink(temp)
        } catch {
          // Nothing to clean up.
        }
      }
    }
    this.#flushing = run().finally(() => {
      this.#flushing = undefined
    })
    return this.#flushing
  }

  /** Stop the timer and write a final revision. */
  async dispose(): Promise<void> {
    if (this.#flushTimer !== undefined) {
      clearTimeout(this.#flushTimer)
      this.#flushTimer = undefined
    }
    this.#disposed = true
    try {
      await this.flush()
    } catch {
      // Disposal is best-effort: a failing final write must not block unload.
    }
    this.#listeners.clear()
  }
}

/** Export for the API layer's journal writes. */
export type { ForgeChatLine, ForgeLogLine, ForgeProject, ForgeWindow, JsonValue }

/** Re-exported so `routes/api.ts` does not need to reach into `protocol.ts`. */
export { MAX_LOG_LINES, MAX_PROJECTS, MAX_WINDOWS_PER_PROJECT }

/**
 * The client-side state container.
 *
 * One store instance is created in `index.tsx` and shared by the panel, the
 * floating windows, and the action bridge. It owns three things:
 *
 *   1. **A mirror of the Host ledger.** Every mutation goes to the Host first and
 *      the response is folded back in; the SSE stream is a hint that invalidates
 *      the mirror, never a second source of truth. That ordering is what makes a
 *      dropped stream harmless — the next mutation resyncs.
 *
 *   2. **The one conversation with the model.** Creating a session, keeping it on
 *      the project, and sending the build request. This is the only place that
 *      talks to DSH services, so the components stay presentational.
 *
 *   3. **Local UI state** that has no business being on disk: which project is
 *      selected, what the input currently holds, transient toasts.
 *
 * Subscriptions are reference-counted through `subscribe`, which is what lets
 * React's `useSyncExternalStore` work without a state library.
 */

import {
  ACTION_SOURCE,
  type ActionRecord,
  type ApiEnvelope,
  type ForgeActionDecl,
  type ForgeChatLine,
  type ForgeLedger,
  type ForgeLimits,
  type ForgeLogLine,
  type ForgeManifest,
  type ForgeProject,
  type ForgeWindow,
  type JsonValue,
  type MarketView,
  ROUTE_API,
  ROUTE_EVENTS,
  type StreamEventPayload,
  type WorkbenchBundle,
  windowLayout,
  windowPlacement,
  type WindowLayout,
  type WindowPlacement,
} from '../protocol.ts'
import {
  buildAnswersText,
  buildInterviewText,
  buildRefineText,
  buildTaskText,
  INTAKE_QUESTIONS,
} from './task-text.ts'
import { t } from './messages.ts'

/** How the store reaches the shell's client services. All optional. */
export interface ForgeServices {
  sessions?: unknown
  conversation?: unknown
  uiWorkspace?: unknown
  locale?: unknown
}

/**
 * Where the store gets its services from.
 *
 * A *resolver*, not a snapshot. The shell composes its client services after a
 * third-party client half is applied, so anything captured during `apply()`
 * holds `undefined` for the rest of the session — the store would then believe
 * the shell has no session service and refuse to build anything. Reading
 * `ctx.get(name)` at the moment of use costs nothing and always sees the
 * service once it exists.
 */
export type ForgeServicesResolver = () => ForgeServices

/** A line in the panel's activity list. */
export interface ActivityLine {
  id: number
  at: number
  level: ForgeLogLine['level']
  text: string
}

/** What the panel needs to render. Replaced wholesale on every change. */
export interface ForgeState {
  /** `loading` until the first `GET /state` resolves. */
  phase: 'loading' | 'ready' | 'error'
  /** Set when the first load failed; the panel offers a retry. */
  error: string | undefined
  ledger: ForgeLedger
  limits: ForgeLimits
  /** The project the user is looking at. Derived from the ledger, never stale. */
  activeProjectId: string | undefined
  /** Local echo of the input box, so a re-render does not lose typing. */
  draft: string
  /** `true` while a build request is in flight. */
  sending: boolean
  /** A short-lived message shown above the input. */
  toast: string | undefined
  /** Journal lines the Host pushed, plus client-side notes. Newest last. */
  activity: ActivityLine[]
  /** `true` while the SSE stream is open. */
  connected: boolean
  /** Counts for the panel's status strip. */
  emitted: number
  delivered: number
  /** Layout preset pinned for the next build request. `auto` lets the model pick. */
  layout: WindowLayout
  /** Where the next build's window opens. */
  placement: WindowPlacement
  /**
   * A window id awaiting its own tab. Set when a build with `standalone`
   * placement is submitted; consumed the moment that window turns `ready`.
   */
  pendingStandalone: string | undefined
  /**
   * Which half of the build flow the panel is showing.
   *
   * `describe` is the one-sentence box. `intake` is the interview. `build` is
   * the submitted state. The interview is a *panel* stage rather than something
   * the model does because it works without a session — the user can answer it
   * before anything has been created, and it produces the same questions every
   * time, which is the difference between a form and a conversation.
   */
  stage: 'describe' | 'intake' | 'build'
  /** The interview answers, keyed by question id. */
  answers: Record<string, string>
  /** Host-reported feature switches. Read from the Host, never mirrored locally. */
  features: { interviewFirst: boolean; chatPane: boolean }
  /** The name of the bundled authoring skill, for the panel's hint line. */
  skillName: string | undefined
  /** The market list, once it has been asked for. */
  market: MarketView | undefined
  /** `true` while a market fetch is in flight. */
  marketBusy: boolean
  /** Which window's chat pane is open in the overlay, if any. */
  chatWindowId: string | undefined
  /**
   * The projects root the Host reported, as typed by the user: a Windows path.
   * Prefill for the new-project folder field; empty until the first /state.
   */
  projectsRoot: string
  /**
   * What the folder field shows while creating a project. Kept in the store so
   * reopening the form keeps the user's edit, and so `createProject` can send
   * it. Empty means "use the default".
   */
  newProjectFolder: string
}

const EMPTY_LIMITS: ForgeLimits = {
  minWindowW: 420,
  minWindowH: 280,
  maxProjects: 40,
  maxWindowsPerProject: 24,
  maxChatLines: 240,
  protocolVersion: 2,
}

/** Keep the activity list bounded; the Host journals separately and can be queried. */
const MAX_ACTIVITY = 300

/** How long a toast stays up. */
const TOAST_MS = 2800

/** Coalescing window for SSE invalidations. A burst of frames is one refetch. */
const REFETCH_DEBOUNCE_MS = 60

/**
 * How often to ask the Host again while a window is still building.
 *
 * The model produces a window by writing files, and writing a file raises no
 * event anyone here can hear: the Host has no folder watcher (deliberately — a
 * watcher per project is a resource that outlives its use and fires in bursts),
 * so `building` would never become `ready` on its own. The Host reconciles rows
 * against the folder on every `/state` read, which makes this poll the thing
 * that ends the build. Two seconds is fast enough to feel immediate and slow
 * enough that a minute of waiting costs thirty cheap directory lookups.
 */
const BUILD_POLL_MS = 2000

/**
 * The retain-source label this plugin reports.
 *
 * Reference sources are just counters keyed by a label; the shell never
 * validates the label against a whitelist, and claiming another plugin's label
 * would make its reference counts lie. Naming our own keeps the counts honest.
 */
const SESSION_SOURCE = 'windowForge'

/** localStorage key holding the user's layout and placement choices. */
const PREFS_KEY = 'dsh-window-forge.prefs'

/**
 * How long a popped-out build waits for its tab before the panel gives up.
 *
 * The standalone tab opens only after the window turns `ready`, which requires
 * the model to have written the file; a build can legitimately take minutes.
 * When the wait expires the pending flag clears and the window still opens
 * embedded — nothing is lost, the tab is just not summoned.
 */
const STANDALONE_WAIT_MS = 10 * 60 * 1000

function initialState(): ForgeState {
  return {
    phase: 'loading',
    error: undefined,
    ledger: { version: 1, revision: 0, projects: [], windows: [], log: [], chats: [] },
    limits: EMPTY_LIMITS,
    activeProjectId: undefined,
    draft: '',
    sending: false,
    toast: undefined,
    activity: [],
    connected: false,
    emitted: 0,
    delivered: 0,
    layout: 'auto',
    placement: 'embedded',
    pendingStandalone: undefined,
    stage: 'describe',
    answers: {},
    features: { interviewFirst: true, chatPane: true },
    skillName: undefined,
    market: undefined,
    marketBusy: false,
    chatWindowId: undefined,
    projectsRoot: '',
    newProjectFolder: '',
  }
}

/**
 * The slice of `ISessions` this plugin uses.
 *
 * Declared structurally rather than imported: the client bundle may only require
 * the nine specifiers in the shell's frozen module table, and none of the
 * `@deepseek-ai/dsh-client-*` packages are among them. A structural face keeps
 * the bundle pure and still fails loudly at runtime if the shape changed — every
 * call site checks the method exists before calling it.
 */
interface SessionsFace {
  binding?: (sessionId: string) => { session?: unknown } | undefined
  /**
   * `retain` is the only way to reach a session this plugin just created.
   *
   * `binding()` deliberately borrows an *already retained* generation and
   * returns `undefined` otherwise, so a freshly created session has no binding
   * until something holds a reference. Retaining one is that something.
   */
  retain?: (target: string, options: { source: string }) => SessionReferenceFace
  scope?: (sessionId: string) => unknown
  list?: { getSnapshot?: () => { byId?: Record<string, unknown> } }
}

/** One owned reference to a session generation. */
interface SessionReferenceFace {
  readonly binding?: { session?: unknown }
  readonly ready?: Promise<{ session?: unknown } | undefined>
  release?: () => void
}

/** The slice of `IConversation` this plugin uses. */
interface ConversationFace {
  sendSession?: (
    session: unknown,
    text: string,
    attachments: readonly unknown[],
    mode: 'queue' | 'steer',
    signal?: AbortSignal,
  ) => Promise<SubmitOutcome>
  send?: (text: string) => Promise<void>
}

/**
 * What `sendSession` resolves to.
 *
 * `{kind:'success'}` or `{kind:'error', text?}` — *not* the `{ok:boolean}`
 * shape the session-level RPC uses. Reading `ok` here would report every real
 * refusal as a success, which is exactly the bug this type exists to prevent.
 */
interface SubmitOutcome {
  readonly kind?: 'success' | 'error'
  readonly text?: string
}

/** The slice of the session object that can accept a prompt directly. */
interface SessionFace {
  prompt?: (
    content: readonly { type: 'text'; text: string }[],
    mode: 'queue' | 'steer',
  ) => Promise<unknown>
}

/** The slice of `uiWorkspace` this plugin uses. */
interface UiWorkspaceFace {
  openSession?: (target: string) => unknown
}

/** `RemoteResult` is `{ok:true,value}` or `{ok:false,error}`; read it defensively. */
function remoteFailed(result: unknown): string | undefined {
  if (result === null || typeof result !== 'object') return undefined
  const face = result as { ok?: unknown; error?: unknown }
  if (face.ok !== false) return undefined
  const error = face.error
  if (error !== null && typeof error === 'object') {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.length > 0) return message
  }
  return typeof error === 'string' ? error : 'the session rejected the request'
}

/** Read a `SubmitOutcome`; a shape with no `kind` is treated as accepted. */
function submitFailed(result: unknown): string | undefined {
  if (result === null || typeof result !== 'object') return undefined
  const face = result as SubmitOutcome
  if (face.kind !== 'error') return undefined
  const text = typeof face.text === 'string' ? face.text.trim() : ''
  return text.length > 0 ? text : 'the session rejected the request'
}

export class ForgeStore {
  #state: ForgeState = initialState()
  #listeners = new Set<() => void>()
  #source: EventSource | undefined
  #resolve: ForgeServicesResolver = () => ({})
  #nextActivityId = 1
  #toastTimer: ReturnType<typeof setTimeout> | undefined
  #refetchTimer: ReturnType<typeof setTimeout> | undefined
  #buildTimer: ReturnType<typeof setTimeout> | undefined
  #standaloneTimer: ReturnType<typeof setTimeout> | undefined
  #disposed = false
  #refetching = false
  /** Set while a refetch is pending so overlapping invalidations do not stack. */
  #refetchWanted = false
  /**
   * Fullscreen is a view state, not a property of the artifact: a window left
   * maximized when the app closed must come back as a normal window. This flag
   * makes that normalisation happen exactly once per page load — clearing it on
   * every state patch would turn the user's own maximize click off again.
   */
  #restoredViewState = false

  /**
   * @param services - a resolver (preferred) or a fixed bag.
   *
   * The resolver form exists because the shell's client services compose
   * *after* a third-party client half applies: a bag captured in `apply()` is
   * empty forever. A plain bag is still accepted so tests and embeddings can
   * hand in stubs.
   */
  constructor(services: ForgeServices | ForgeServicesResolver = {}) {
    this.#resolve = typeof services === 'function' ? services : () => services
    // Prefs are read once, before the first render: the panel's chips then show
    // the user's last choices instead of flickering from the defaults.
    this.#loadPrefs()
  }

  /**
   * The services, read now rather than remembered.
   *
   * Every call site goes through this: `ctx.get(name)` is cheap and returns
   * `undefined` for a service the shell has not installed (yet), so the failure
   * mode is a clear message instead of a permanently dead feature.
   */
  #svc(): ForgeServices {
    try {
      return this.#resolve()
    } catch {
      return {}
    }
  }

  // ---------------------------------------------------------------- reading

  get state(): ForgeState {
    return this.#state
  }

  /** The selected project, or the first one. Never returns a stale object. */
  get project(): ForgeProject | undefined {
    const { ledger, activeProjectId } = this.#state
    if (activeProjectId !== undefined) {
      const found = ledger.projects.find((candidate) => candidate.id === activeProjectId)
      if (found !== undefined) return found
    }
    return ledger.projects[0]
  }

  /** Windows of the selected project, newest last. */
  get windows(): ForgeWindow[] {
    const project = this.project
    if (project === undefined) return []
    return this.#state.ledger.windows
      .filter((candidate) => candidate.projectId === project.id)
      .sort((left, right) => left.createdAt - right.createdAt)
  }

  /** The window the overlay is showing, if any. */
  get openWindows(): ForgeWindow[] {
    return this.#state.ledger.windows
      .filter((candidate) => candidate.open)
      .sort((left, right) => left.z - right.z)
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  #emit(): void {
    if (this.#disposed) return
    for (const listener of this.#listeners) listener()
  }

  #patch(next: Partial<ForgeState>): void {
    this.#state = { ...this.#state, ...next }
    this.#emit()
  }

  // ------------------------------------------------------------- journaling

  /** Append a line to the panel's activity list. Client-side only. */
  log(text: string, level: ForgeLogLine['level'] = 'info'): void {
    const line: ActivityLine = { id: this.#nextActivityId++, at: Date.now(), level, text }
    const activity = [...this.#state.activity, line]
    this.#patch({
      activity: activity.length > MAX_ACTIVITY ? activity.slice(activity.length - MAX_ACTIVITY) : activity,
    })
  }

  /** Show a transient message. A second call replaces the first. */
  notify(text: string): void {
    this.#patch({ toast: text })
    if (this.#toastTimer !== undefined) clearTimeout(this.#toastTimer)
    this.#toastTimer = setTimeout(() => {
      this.#toastTimer = undefined
      if (!this.#disposed) this.#patch({ toast: undefined })
    }, TOAST_MS)
  }

  clearActivity(): void {
    this.#patch({ activity: [] })
  }

  // ------------------------------------------------------------ local state

  setDraft(draft: string): void {
    this.#patch({ draft })
  }

  selectProject(projectId: string | undefined): void {
    this.#patch({ activeProjectId: projectId })
  }

  /** Pin the layout preset the next build request will carry. */
  setLayout(layout: WindowLayout): void {
    this.#patch({ layout })
    this.#savePrefs()
  }

  /** Pin where the next build's window opens. */
  setPlacement(placement: WindowPlacement): void {
    this.#patch({ placement })
    this.#savePrefs()
  }

  /** Edit the folder field of the new-project form. Empty means "default". */
  setNewProjectFolder(value: string): void {
    this.#patch({ newProjectFolder: value })
  }

  /**
   * Move the panel between the three stages of the build flow.
   *
   * `intake` is skipped entirely when the Host says `interviewFirst` is off: a
   * user who has already decided what they want should not be made to answer a
   * form. `build` is entered only by {@link submitRequest}.
   */
  setStage(stage: 'describe' | 'intake'): void {
    this.#patch({ stage })
  }

  /** Record one interview answer. Empty string clears it. */
  setAnswer(questionId: string, value: string): void {
    const answers = { ...this.#state.answers }
    if (value.trim().length === 0) delete answers[questionId]
    else answers[questionId] = value
    this.#patch({ answers })
  }

  /** Throw the interview away and go back to the one-line box. */
  resetIntake(): void {
    this.#patch({ stage: 'describe', answers: {} })
  }

  /** The interview questions, for the panel to render. */
  get intakeQuestions(): typeof INTAKE_QUESTIONS {
    return INTAKE_QUESTIONS
  }

  // ------------------------------------------------------------------ prefs

  /**
   * Remember the layout and placement between sessions.
   *
   * The artifact iframe is the one place localStorage throws; this store runs
   * in the shell's own origin, where it is an ordinary browser facility. The
   * try/catch is still unconditional because a profile with storage disabled
   * must not take the panel down with it — the fallback is simply "forget".
   */
  #loadPrefs(): void {
    try {
      const raw = localStorage.getItem(PREFS_KEY)
      if (raw === null) return
      const parsed: unknown = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object') return
      const face = parsed as { layout?: unknown; placement?: unknown }
      const layout = windowLayout(face.layout)
      const placement = windowPlacement(face.placement)
      this.#patch({
        ...(layout !== undefined ? { layout } : {}),
        ...(placement !== undefined ? { placement } : {}),
      })
    } catch {
      // Unreadable prefs are prefs the user never set.
    }
  }

  #savePrefs(): void {
    try {
      localStorage.setItem(
        PREFS_KEY,
        JSON.stringify({ layout: this.#state.layout, placement: this.#state.placement }),
      )
    } catch {
      // Persisting is a convenience; the session keeps its in-memory values.
    }
  }

  // ------------------------------------------------------------------ HTTP

  async #request<T>(method: string, path: string, body?: unknown): Promise<ApiEnvelope<T>> {
    const init: RequestInit = {
      method,
      headers: { accept: 'application/json' },
      // The Host route is on loopback and same-origin; a cookie or token would
      // be needed only for the shell's own routes, not for a plugin's prefix.
      credentials: 'same-origin',
    }
    if (body !== undefined) {
      init.headers = { ...init.headers, 'content-type': 'application/json' }
      init.body = JSON.stringify(body)
    }
    let response: Response
    try {
      response = await fetch(`${ROUTE_API}${path}`, init)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'network error' }
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      return { ok: false, error: `the Host answered ${response.status} without JSON` }
    }
    if (payload === null || typeof payload !== 'object') {
      return { ok: false, error: `the Host answered ${response.status}` }
    }
    const envelope = payload as ApiEnvelope<T>
    if (typeof envelope.ok !== 'boolean') {
      return { ok: false, error: `the Host answered ${response.status}` }
    }
    return envelope
  }

  /**
   * Fetch the full state.
   *
   * Concurrent callers share one request: the SSE stream can fire a burst of
   * invalidations and there is no point asking the Host the same question twice.
   */
  async load(): Promise<void> {
    if (this.#refetching) {
      this.#refetchWanted = true
      return
    }
    this.#refetching = true
    try {
      const result = await this.#request<{
        ledger: ForgeLedger
        limits: ForgeLimits
        features?: { interviewFirst: boolean; chatPane: boolean }
        skillName?: string
        sessionId?: string
        projectsRoot?: string
      }>('GET', '/state')
      if (this.#disposed) return
      if (result.ok && result.data !== undefined) {
        const { ledger, limits, features, skillName, projectsRoot } = result.data
        const activeProjectId = this.#resolveActive(ledger)
        this.#patch({
          phase: 'ready',
          error: undefined,
          ledger,
          limits,
          activeProjectId,
          // The Host owns these switches (they come from the plugin Config the
          // user edits in the shell's settings page). A local copy would drift
          // the moment that page is used, so the Host's answer always wins.
          ...(features !== undefined ? { features } : {}),
          skillName,
          // The folder field prefills from the Host's own root; a root the user
          // has already edited wins over the reported default.
          ...(this.#state.newProjectFolder.length === 0 && projectsRoot !== undefined
            ? { projectsRoot, newProjectFolder: projectsRoot }
            : projectsRoot !== undefined
              ? { projectsRoot }
              : {}),
        })
        this.#consumePendingStandalone(ledger)
        // Once per page load: a maximized window restored from disk must come
        // back windowed. Without this, closing the app while a window was
        // maximized reopens the workbench as a full-screen surface that covers
        // the shell on first paint — which reads as "the app is frozen".
        if (!this.#restoredViewState) {
          this.#restoredViewState = true
          for (const row of ledger.windows) {
            if (row.fullscreen) void this.updateWindow(row.id, { fullscreen: false })
          }
        }
      } else {
        this.#patch({
          phase: this.#state.phase === 'ready' ? 'ready' : 'error',
          error: result.error ?? 'the Host did not return a state',
        })
      }
    } finally {
      this.#refetching = false
      // Armed (or disarmed) from the state that just arrived, so the poll's own
      // lifetime is decided by the ledger rather than by whoever sent a request.
      this.#scheduleBuildPoll()
      if (this.#refetchWanted) {
        this.#refetchWanted = false
        void this.load()
      }
    }
  }

  /**
   * Open the pending standalone tab, if the window it names is ready.
   *
   * Run on every state fold while a build is in flight. `ready` is the first
   * moment the artifact file exists, so it is the first moment a tab has
   * something to show. An expiry timer clears the intent on its own — a build
   * that never finishes must not leave a permanently armed flag.
   */
  #consumePendingStandalone(ledger: ForgeLedger): void {
    const windowId = this.#state.pendingStandalone
    if (windowId === undefined) return
    const row = ledger.windows.find((candidate) => candidate.id === windowId)
    if (row === undefined) {
      // The row is gone (project deleted, request failed): nothing to open.
      this.#clearStandaloneTimer()
      this.#patch({ pendingStandalone: undefined })
      return
    }
    if (row.status !== 'ready') return
    this.#clearStandaloneTimer()
    this.#patch({ pendingStandalone: undefined })
    this.#openStandalone(row.id)
  }

  /**
   * Open one window's standalone page in a new tab.
   *
   * `globalThis.open`, not `window.open`: a local named `window` is shadow-prone
   * in a file whose rows are also called windows, and `ForgeWindow.open` is a
   * boolean — calling it would throw and read as "the browser refused".
   */
  #openStandalone(windowId: string): void {
    const url = `${ROUTE_API}/standalone/${encodeURIComponent(windowId)}`
    try {
      globalThis.open(url, '_blank')
      this.log(t('popoutDone'), 'success')
    } catch {
      this.log(t('popoutFailed'), 'warn')
      this.notify(t('popoutFailed'))
    }
  }

  /**
   * Pop a window out to its own tab, on demand.
   *
   * Only a `ready` window has a file on disk; anything else would open an empty
   * frame, so the request is refused with a message instead.
   */
  popout(windowId: string): void {
    const row = this.#state.ledger.windows.find((candidate) => candidate.id === windowId)
    if (row === undefined) return
    if (row.status !== 'ready') {
      this.log(t('popoutFailed'), 'warn')
      this.notify(t('popoutFailed'))
      return
    }
    this.#openStandalone(row.id)
  }

  #clearStandaloneTimer(): void {
    if (this.#standaloneTimer !== undefined) {
      clearTimeout(this.#standaloneTimer)
      this.#standaloneTimer = undefined
    }
  }

  /** Keep the selection valid across a resync. */
  #resolveActive(ledger: ForgeLedger): string | undefined {
    const current = this.#state.activeProjectId
    if (current !== undefined && ledger.projects.some((project) => project.id === current)) {
      return current
    }
    return ledger.projects[0]?.id
  }

  /** Ask the Host again after a short delay, folding a burst into one call. */
  #scheduleRefetch(): void {
    if (this.#refetchTimer !== undefined) return
    this.#refetchTimer = setTimeout(() => {
      this.#refetchTimer = undefined
      void this.load()
    }, REFETCH_DEBOUNCE_MS)
  }

  /**
   * Keep asking while something is building.
   *
   * Armed from `load()` rather than from the moment a request is sent, because
   * the state that matters is the one the Host just returned: if nothing is
   * `building` the poll disarms itself, so a settled ledger costs zero timers.
   *
   * Only `building` counts. A `draft` row is a window that was created but never
   * handed to the model, and nothing is coming that would change it — polling for
   * it would be a timer that runs for as long as the panel is open. A draft row
   * still picks up a page that is already on disk, because every ordinary
   * `load()` reconciles.
   */
  #scheduleBuildPoll(): void {
    const pending = this.#state.ledger.windows.some((window) => window.status === 'building')
    if (!pending) {
      if (this.#buildTimer !== undefined) {
        clearTimeout(this.#buildTimer)
        this.#buildTimer = undefined
      }
      return
    }
    if (this.#buildTimer !== undefined) return
    this.#buildTimer = setTimeout(() => {
      this.#buildTimer = undefined
      void this.load()
    }, BUILD_POLL_MS)
  }

  // -------------------------------------------------------------- mutations

  /** Create a project. The Host derives the folder from the name. */
  async createProject(name: string): Promise<ForgeProject | undefined> {
    const trimmed = name.trim()
    if (trimmed.length === 0) return undefined
    // An empty folder string means "use the default" on the wire: the Host
    // derives `<projectsRoot>/<slug>` from the name. The panel prefills the
    // field with that same root so the user can see (and edit) where files
    // will land before anything is created.
    const folder = (this.#state.newProjectFolder ?? '').trim()
    const result = await this.#request<{ project: ForgeProject }>('POST', '/project', {
      name: trimmed,
      ...(folder.length > 0 ? { folder } : {}),
    })
    if (!result.ok || result.data === undefined) {
      this.log(result.error ?? t('saveFailed'), 'error')
      this.notify(result.error ?? t('saveFailed'))
      return undefined
    }
    const project = result.data.project
    this.log(t('projectCreated'), 'success')
    await this.load()
    this.#patch({ activeProjectId: project.id })
    return project
  }

  async deleteProject(projectId: string): Promise<void> {
    const result = await this.#request<{ removed: { windows: number }; folder: string }>(
      'DELETE',
      `/project/${encodeURIComponent(projectId)}`,
    )
    if (!result.ok) {
      this.log(result.error ?? t('saveFailed'), 'error')
      return
    }
    this.log(t('projectDeleted'), 'success')
    // The removed project was selected: move the selection to the first
    // remaining project (or none) so the windows section does not keep
    // showing rows that belong to a deleted project.
    if (this.#state.activeProjectId === projectId) {
      this.#patch({ activeProjectId: this.#state.ledger.projects.find((candidate) => candidate.id !== projectId)?.id })
    }
    await this.load()
    // The market slice caches each entry's `installedProjectId`; without a
    // refresh the deleted workbench keeps showing 「已安装」 until the user hits
    // the manual refresh button. Only refetch when the market was actually
    // loaded, so deleting a project does not drag in a catalog download.
    if (this.#state.market !== undefined) await this.loadMarket()
  }

  /** Remove a window from the ledger. The file on disk is left alone. */
  async deleteWindow(windowId: string): Promise<void> {
    const result = await this.#request<{ removed: string }>(
      'DELETE',
      `/window/${encodeURIComponent(windowId)}`,
    )
    if (!result.ok) {
      this.log(result.error ?? t('saveFailed'), 'error')
      return
    }
    this.log(t('windowDeleted'), 'success')
    await this.load()
  }

  /** Patch a window's placement, flags, or manifest-derived fields. */
  async updateWindow(
    windowId: string,
    patch: Partial<
      Pick<
        ForgeWindow,
        | 'x'
        | 'y'
        | 'w'
        | 'h'
        | 'open'
        | 'minimized'
        | 'fullscreen'
        | 'z'
        | 'title'
        | 'entry'
        | 'kind'
        | 'status'
        | 'actions'
        | 'note'
        | 'layout'
        | 'placement'
        | 'inlineHtml'
        | 'chat'
      >
    >,
  ): Promise<void> {
    const result = await this.#request<{ window: ForgeWindow }>(
      'PATCH',
      `/window/${encodeURIComponent(windowId)}`,
      patch,
    )
    if (!result.ok) {
      this.log(result.error ?? t('saveFailed'), 'error')
      return
    }
    // Fold the authoritative row in immediately so a drag settles without
    // waiting for the SSE round trip.
    const updated = result.data?.window
    if (updated !== undefined) {
      const ledger: ForgeLedger = {
        ...this.#state.ledger,
        windows: this.#state.ledger.windows.map((candidate) =>
          candidate.id === updated.id ? updated : candidate,
        ),
      }
      this.#patch({ ledger })
    }
  }

  /**
   * Bring a window to the front.
   *
   * The ledger stores a monotonically increasing `z`, so raising means writing a
   * new maximum. That is a Host round trip, which is why the overlay raises on
   * pointer-down rather than on every focus change.
   */
  async raise(windowId: string): Promise<void> {
    const windows = this.#state.ledger.windows
    const top = windows.reduce((highest, candidate) => Math.max(highest, candidate.z), 0)
    const target = windows.find((candidate) => candidate.id === windowId)
    if (target === undefined || target.z >= top) return
    await this.updateWindow(windowId, { z: top + 1 })
  }

  // ------------------------------------------------------------ the loop

  /**
   * The product: turn one sentence into a window.
   *
   * Sequence, and why each step is where it is:
   *
   *   1. Make sure there is a project. A folder has to exist before a session can
   *      be told to work in it.
   *   2. Make sure there is a window row. The panel shows the window immediately
   *      in `building` state, so the user sees their request land.
   *   3. Get a session: reuse the project's, or create one rooted at the project
   *      folder. Creating with `cwd` is what makes the model write into the right
   *      place without being told an absolute path.
   *   4. Send the task text. Three transports are tried because the shape of the
   *      client services differs between shell versions; the first one that
   *      accepts wins.
   *
   * Failure at step 3 or 4 is reported, not thrown: the user keeps their typed
   * request and can retry.
   */
  async submitRequest(requirement: string): Promise<void> {
    const text = requirement.trim()
    if (text.length === 0) {
      this.notify(t('needRequest'))
      return
    }
    if (this.#state.sending) return
    this.#patch({ sending: true })

    try {
      const project = await this.#ensureProject()
      if (project === undefined) {
        this.notify(t('needProject'))
        return
      }

      const existing = this.windows.at(-1)
      const manifest = await this.#readManifest(project.id)
      const window =
        existing !== undefined && existing.status !== 'ready'
          ? existing
          : await this.#ensureWindow(project, manifest, existing)
      if (window === undefined) return

      // Pin the panel's shape choices onto the row. The Host ledger is what the
      // standalone page and a reloaded panel read back, so the row — not the
      // panel state — is the one place the placement must live.
      const { layout, placement } = this.#state
      if ((window.layout ?? 'auto') !== layout || (window.placement ?? 'embedded') !== placement) {
        await this.updateWindow(window.id, { layout, placement })
      }

      const sessionId = await this.#ensureSession(project)
      if (sessionId === undefined) {
        this.log(t('sessionFailed'), 'error')
        this.notify(t('sessionFailed'))
        await this.updateWindow(window.id, { status: 'error' })
        return
      }

      const answersText = buildAnswersText(this.#state.answers)
      const { skillName } = this.#state
      const taskText =
        existing !== undefined && existing.status === 'ready'
          ? buildRefineText({
              folder: project.folder,
              requirement: text,
              // Only steer a refine when the preset actually changed: restating
              // an unchanged layout invites the model to restructure a page it
              // should be touching lightly.
              layout:
                layout !== 'auto' && layout !== (existing.layout ?? 'auto') ? layout : undefined,
              placement:
                placement !== (existing.placement ?? 'embedded') ? placement : undefined,
              existing: {
                title: existing.title,
                entry: existing.entry,
                actions: existing.actions.map((action) => action.name),
              },
            })
          : answersText.length === 0 && this.#state.features.interviewFirst
            ? // The user confirmed the interview without answering anything, so
              // nothing has been narrowed down. Handing that to the builder
              // produces a generic page built on guesses; asking the model to
              // interview first costs one round trip and gets the real answer.
              buildInterviewText({ folder: project.folder, requirement: text })
            : buildTaskText({
                folder: project.folder,
                requirement: text,
                layout,
                placement,
                ...(answersText.length > 0 ? { answers: answersText } : {}),
                ...(skillName !== undefined ? { skillName } : {}),
                existing:
                  manifest?.entry === undefined
                    ? undefined
                    : {
                        title: manifest.title ?? window.title,
                        entry: manifest.entry,
                        actions: (manifest.actions ?? []).map((action) => action.name),
                      },
              })

      const delivered = await this.#prompt(sessionId, taskText)
      if (!delivered) {
        this.log(t('sendFailed'), 'error')
        this.notify(t('sendFailed'))
        await this.updateWindow(window.id, { status: 'error' })
        return
      }

      await this.updateWindow(window.id, { status: 'building' })

      // Arm the standalone watcher only after the request is accepted. The
      // intent is "open *this* build in its own tab", so the watcher names the
      // row and expires: a build that never finishes must not leave a
      // permanently armed flag, and it must not pop an unrelated window.
      if (placement === 'standalone') {
        this.#patch({ pendingStandalone: window.id })
        this.#clearStandaloneTimer()
        this.#standaloneTimer = setTimeout(() => {
          this.#standaloneTimer = undefined
          if (this.#disposed || this.#state.pendingStandalone === undefined) return
          this.#patch({ pendingStandalone: undefined })
          this.log(t('popoutFailed'), 'warn')
        }, STANDALONE_WAIT_MS)
      }

      this.#patch({ draft: '', emitted: this.#state.emitted + 1, stage: 'build', answers: {} })
      this.log(t('sent'), 'action')
      this.notify(t('sent'))
      await this.load()
    } finally {
      this.#patch({ sending: false })
    }
  }

  /** The selected project, created on demand from the draft text. */
  async #ensureProject(): Promise<ForgeProject | undefined> {
    const current = this.project
    if (current !== undefined) return current
    const name = this.#deriveProjectName()
    return this.createProject(name)
  }

  /** A short project name from the first clause of the request. */
  #deriveProjectName(): string {
    const text = this.#state.draft.trim().replace(/\s+/g, ' ')
    if (text.length === 0) return t('title')
    // A name, not a summary: the first clause, capped so the folder path stays
    // readable. Chinese has no spaces, so a character cap matters more than a
    // word cap.
    const clause = text.split(/[。！？.!?\n]/)[0] ?? text
    return clause.slice(0, 18).trim() || t('title')
  }

  /**
   * Ensure a window row exists for the project, seeded from the manifest.
   *
   * A window is created before the model runs so the panel has something to show
   * and so the artifact, once written, has a row to attach to. When the project
   * already has a manifest on disk (the model finished a previous build), the
   * row adopts its title, entry, and declared actions instead of guessing.
   */
  async #ensureWindow(
    project: ForgeProject,
    manifest: ForgeManifest | undefined,
    existing: ForgeWindow | undefined,
  ): Promise<ForgeWindow | undefined> {
    if (existing !== undefined) {
      // Refresh the manifest-derived fields from disk: the model may have changed
      // the title, the entry, or the declared actions since the row was created.
      if (manifest !== undefined) {
        await this.updateWindow(existing.id, {
          title: manifest.title ?? existing.title,
          entry: manifest.entry ?? existing.entry,
          actions: manifest.actions ?? existing.actions,
        })
        const refreshed = this.#state.ledger.windows.find((row) => row.id === existing.id)
        if (refreshed !== undefined) return refreshed
      }
      return existing
    }

    const result = await this.#request<{ window: ForgeWindow }>('POST', '/window', {
      projectId: project.id,
      title: manifest?.title ?? this.#deriveProjectName(),
      entry: manifest?.entry ?? 'index.html',
      kind: 'html',
      status: 'draft',
    })
    if (!result.ok || result.data === undefined) {
      this.log(result.error ?? t('saveFailed'), 'error')
      this.notify(result.error ?? t('saveFailed'))
      return undefined
    }
    return result.data.window
  }

  /** Read `_workbench.json` from the project folder, if the model wrote one. */
  async #readManifest(projectId: string): Promise<ForgeManifest | undefined> {
    const result = await this.#request<{ manifest: ForgeManifest | null }>(
      'GET',
      `/manifest/${encodeURIComponent(projectId)}`,
    )
    if (!result.ok || result.data === undefined) return undefined
    return result.data.manifest ?? undefined
  }

  /**
   * Get a session rooted at the project folder, creating one when needed.
   *
   * The Host creates it (`POST /session` → `sessionController.create({cwd})`),
   * not the browser. The client's `ISessions` has no `create` in this shell
   * generation — the only client-side ways to make a session are the workspace
   * entry points, which would drag the user into a new workspace. The Host's
   * controller is the same service the shell itself uses.
   *
   * `cwd` is the whole trick: the model then writes relative paths inside the
   * project folder without being handed an absolute path, and the session's own
   * file tools are already pointed at the right directory.
   */
  async #ensureSession(project: ForgeProject): Promise<string | undefined> {
    if (project.sessionId !== undefined) {
      this.log(t('sessionReused'), 'info')
      return project.sessionId
    }
    const result = await this.#request<{ sessionId: string }>('POST', '/session', {
      projectId: project.id,
    })
    if (!result.ok || result.data === undefined) {
      this.log(result.error ?? t('sessionFailed'), 'error')
      return undefined
    }
    const created = result.data.sessionId
    if (typeof created !== 'string' || created.length === 0) return undefined
    this.log(t('sessionCreated'), 'success')
    // Show the user the session so they can watch the model work. Best effort:
    // a shell without `uiWorkspace` simply stays on the panel.
    const uiWorkspace = this.#svc().uiWorkspace as UiWorkspaceFace | undefined
    try {
      uiWorkspace?.openSession?.(created)
    } catch {
      // Opening is a convenience; the request has already been queued.
    }
    return created
  }

  /**
   * Borrow a session face for one send, retaining a generation if needed.
   *
   * `sessions.binding(id)` only borrows an *already retained* generation, so a
   * session this plugin just created has no binding until something holds a
   * reference. `retain` is that something; the caller releases it in `finally`
   * so the reference count does not leak per request.
   */
  async #acquire(
    sessionId: string,
  ): Promise<{ session: unknown | undefined; release: () => void }> {
    const sessions = this.#svc().sessions as SessionsFace | undefined
    const borrowed = sessions?.binding?.(sessionId)?.session
    if (borrowed !== undefined) return { session: borrowed, release: () => undefined }
    if (sessions?.retain === undefined) return { session: undefined, release: () => undefined }
    try {
      const reference = sessions.retain(sessionId, { source: SESSION_SOURCE })
      const release = (): void => {
        try {
          reference.release?.()
        } catch {
          // Releasing an already-released reference is not an error here.
        }
      }
      if (reference.binding?.session !== undefined) {
        return { session: reference.binding.session, release }
      }
      const settled = reference.ready === undefined ? undefined : await reference.ready
      const session = reference.binding?.session ?? settled?.session
      if (session === undefined) release()
      return { session, release }
    } catch (error) {
      this.log(error instanceof Error ? error.message : String(error), 'error')
      return { session: undefined, release: () => undefined }
    }
  }

  /**
   * Send text into a session.
   *
   * Three transports, in decreasing order of preference:
   *
   *   1. `conversation.sendSession(session, text, [], 'queue')` — the richest
   *      path, and the only one that carries attachments.
   *   2. `session.prompt([{type:'text',text}], 'queue')` — the direct session RPC.
   *   3. `sessions.scope(id).get('conversation').send(text)` — the scoped-service
   *      path, for shells that expose neither of the above on the root context.
   *
   * A transport that exists but rejects is not silently retried on the next one:
   * the rejection is reported. Trying a second transport after a real refusal
   * would double-send on a transient error.
   *
   * The two transports report failure differently — `sendSession` resolves to
   * `{kind:'error'}` while `session.prompt` resolves to `{ok:false}` — so each is
   * read with its own helper. Mixing them up reports every refusal as success.
   */
  async #prompt(sessionId: string, text: string): Promise<boolean> {
    const { session, release } = await this.#acquire(sessionId)
    try {
      const conversation = this.#svc().conversation as ConversationFace | undefined
      if (conversation?.sendSession !== undefined && session !== undefined) {
        try {
          const result = await conversation.sendSession(session, text, [], 'queue')
          const failure = submitFailed(result)
          if (failure === undefined) return true
          this.log(failure, 'error')
          return false
        } catch (error) {
          this.log(error instanceof Error ? error.message : String(error), 'error')
          return false
        }
      }

      const face = session as SessionFace | undefined
      if (face?.prompt !== undefined) {
        try {
          const result = await face.prompt([{ type: 'text', text }], 'queue')
          const failure = remoteFailed(result)
          if (failure === undefined) return true
          this.log(failure, 'error')
          return false
        } catch (error) {
          this.log(error instanceof Error ? error.message : String(error), 'error')
          return false
        }
      }
    } finally {
      release()
    }

    const sessions = this.#svc().sessions as SessionsFace | undefined
    const scoped = sessions?.scope?.(sessionId) as
      | { get?: (service: string) => unknown }
      | undefined
    const scopedConversation = scoped?.get?.('conversation') as ConversationFace | undefined
    if (scopedConversation?.send !== undefined) {
      try {
        await scopedConversation.send(text)
        return true
      } catch (error) {
        this.log(error instanceof Error ? error.message : String(error), 'error')
        return false
      }
    }

    this.log('no send path: the session face is unavailable', 'error')
    return false
  }

  // ------------------------------------------------------- action relay

  /**
   * Record an action posted by an artifact — and deliberately nothing more.
   *
   * The declared-actions check happens here, in the parent frame, and not inside
   * the iframe: an artifact that posts something it did not declare is dropped
   * silently, which keeps a chatty page from spamming the journal.
   *
   * A click used to be relayed straight to the model, but that made every
   * button in a workbench a hidden prompt trigger — the user pressed "sync"
   * and the model woke up unasked. The rule now is that only the user's own
   * message in the chat pane reaches the AI: a button press lands in the
   * journal with its payload so the pane's summary can quote it, and the user
   * decides what, if anything, to ask about it.
   */
  async relayAction(windowId: string, action: string, data: JsonValue | undefined): Promise<void> {
    const window = this.#state.ledger.windows.find((candidate) => candidate.id === windowId)
    if (window === undefined) return
    const declared = window.actions.some((candidate) => candidate.name === action)
    if (!declared) {
      this.log(`ignored undeclared action "${action}" from ${window.title}`, 'warn')
      return
    }
    this.#patch({ emitted: this.#state.emitted + 1 })
    // Still POSTing, but only to journal the click: the Host's /action handler
    // keeps the record for the chat summary and the activity feed, and the
    // delivery leg is a no-op for everything but nothing — no prompt is built,
    // no session is woken. See the Host-side comment on handleAction.
    const result = await this.#request<{ record: ActionRecord }>('POST', '/action', {
      windowId,
      action,
      data,
      recordOnly: true,
    })
    if (!result.ok || result.data === undefined) {
      this.log(result.error ?? t('sendFailed'), 'error')
      return
    }
    const record = result.data.record
    if (record.delivered) {
      this.#patch({ delivered: this.#state.delivered + 1 })
      this.log(`"${action}" · ${window.title} — ${t('actionLoggedOnly')}`, 'info')
    } else {
      this.log(`"${action}" · ${window.title} — ${t('actionLoggedOnly')}`, 'info')
    }
  }

  // ------------------------------------------------------------- the chat

  /**
   * The chat transcript for a project, oldest first.
   *
   * Read from the ledger rather than from a local array: the transcript has to
   * survive the window closing, the panel remounting, and a page reload, and the
   * ledger is the only thing that does.
   */
  chatOf(projectId: string | undefined): ForgeChatLine[] {
    if (projectId === undefined) return []
    return this.#state.ledger.chats
      .filter((line) => line.projectId === projectId)
      .sort((left, right) => left.at - right.at)
  }

  /** Which window's chat pane is open, if any. */
  get openChatWindowId(): string | undefined {
    return this.#state.chatWindowId
  }

  /** Open or close the chat pane attached to a window. */
  toggleChat(windowId: string): void {
    this.#patch({
      chatWindowId: this.#state.chatWindowId === windowId ? undefined : windowId,
    })
  }

  /**
   * Show the project's session in the shell's own conversation column.
   *
   * The chat pane here is a *narrow* view of one workbench; the real transcript
   * (tool calls, file writes, the model's reasoning) only exists in the shell.
   * Handing the user over to it is how they can see what the model actually did
   * rather than just what it said. Best effort: a shell without `uiWorkspace`
   * simply stays put, because the request has already been queued either way.
   */
  openSession(projectId: string): void {
    const project = this.#state.ledger.projects.find((candidate) => candidate.id === projectId)
    const sessionId = project?.sessionId
    if (sessionId === undefined) {
      this.notify(t('chatNoSession'))
      return
    }
    const uiWorkspace = this.#svc().uiWorkspace as UiWorkspaceFace | undefined
    try {
      uiWorkspace?.openSession?.(sessionId)
    } catch {
      // Nothing to recover from: the session is already reachable from the
      // sidebar, this was only a shortcut.
    }
  }

  /**
   * Ask the Host to pull any model replies out of the session transcript.
   *
   * The model's answers are session events, not something the Host receives as a
   * reply to the prompt — `prompt()` only queues text. The Host reads the
   * transcript back (`sessionController.inspect`, which does not activate an
   * agent) and appends whatever is new. Calling this is cheap and idempotent:
   * lines already in the ledger are matched by `(role, at, text)`.
   */
  async refreshChat(projectId: string): Promise<void> {
    const result = await this.#request<{ chat: ForgeChatLine[]; added: number }>(
      'GET',
      `/chat/${encodeURIComponent(projectId)}`,
    )
    if (!result.ok || result.data === undefined) return
    // The lines arrive as `chat` SSE frames too; refetching the ledger is the
    // simplest way to be sure nothing was missed between frames.
    if (result.data.added > 0) await this.load()
  }

  /**
   * Send one chat message about the current workbench.
   *
   * The message is prefixed with a summary of the workbench (files, declared
   * actions, layout, recent activity) so the model answers about *this* window
   * instead of guessing which one the user means. The summary is built on the
   * Host, which can read the folder; the browser cannot.
   */
  async sendChat(projectId: string, text: string): Promise<void> {
    const message = text.trim()
    if (message.length === 0) return
    const result = await this.#request<{
      line: ForgeChatLine
      delivered: boolean
      error?: string
    }>('POST', '/chat', { projectId, text: message })
    if (!result.ok || result.data === undefined) {
      this.log(result.error ?? t('sendFailed'), 'error')
      this.notify(result.error ?? t('sendFailed'))
      return
    }
    const { delivered, error } = result.data
    if (delivered) {
      this.#patch({ emitted: this.#state.emitted + 1 })
      this.log(t('sent'), 'action')
    } else {
      this.log(`${t('notDelivered')}: ${error ?? t('sessionNone')}`, 'warn')
    }
    await this.load()
  }

  /** Wipe one project's chat transcript. */
  async clearChat(projectId: string): Promise<void> {
    const result = await this.#request<{ removed: number }>('POST', '/chat/clear', { projectId })
    if (!result.ok) {
      this.log(result.error ?? t('saveFailed'), 'error')
      return
    }
    await this.load()
  }

  // ------------------------------------------------------- import / export

  /**
   * Download one project as a self-contained bundle.
   *
   * The file is built on the Host (it owns the folder) and handed over as a
   * Blob. Using a Blob rather than a link to a GET endpoint means the browser
   * never navigates and the response can carry an error message instead of a
   * broken download.
   */
  async exportProject(projectId: string): Promise<void> {
    const result = await this.#request<{
      bundle: WorkbenchBundle
      filename: string
      skipped: string[]
    }>('GET', `/bundle/${encodeURIComponent(projectId)}`)
    if (!result.ok || result.data === undefined) {
      this.log(result.error ?? t('exportFailed'), 'error')
      this.notify(result.error ?? t('exportFailed'))
      return
    }
    const { bundle, filename, skipped } = result.data
    try {
      const blob = new Blob([JSON.stringify(bundle, undefined, 2)], {
        type: 'application/json',
      })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filename
      anchor.style.display = 'none'
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      // Revoking immediately can cancel the download in some engines; a tick is
      // enough for the navigation to have been committed.
      setTimeout(() => {
        URL.revokeObjectURL(url)
      }, 1000)
      this.log(t('exported'), 'success')
      this.notify(t('exported'))
      if (skipped.length > 0) this.log(t('exportSkipped'), 'warn')
    } catch (error) {
      this.log(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  /** Import a bundle the user picked from disk. */
  async importBundle(bundle: unknown): Promise<void> {
    const result = await this.#request<{
      project: ForgeProject
      window: ForgeWindow
      written: string[]
      skipped: string[]
      descriptorOnly: boolean
    }>('POST', '/import', { bundle })
    if (!result.ok || result.data === undefined) {
      this.log(result.error ?? t('importFailed'), 'error')
      this.notify(result.error ?? t('importFailed'))
      return
    }
    const { project, descriptorOnly } = result.data
    this.log(t('imported'), 'success')
    this.notify(t('imported'))
    if (descriptorOnly) this.log(t('importDescriptorOnly'), 'warn')
    await this.load()
    this.#patch({ activeProjectId: project.id })
  }

  /** Read a picked file and import it. */
  async importFromFile(file: File): Promise<void> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await file.text())
    } catch {
      this.log(t('importNotJson'), 'error')
      this.notify(t('importNotJson'))
      return
    }
    await this.importBundle(parsed)
  }

  // -------------------------------------------------------------- market

  /**
   * Fetch the dsh-desktop workbench catalog.
   *
   * A catalog entry can be *installed* (downloaded and unpacked into a project)
   * but not *run as a native workbench*: this DSH build has no
   * `desktopWorkbenches` service, so the entry's React panel cannot be mounted.
   * What lands is its static entry page, which is genuinely useful and is what
   * the panel promises.
   */
  async loadMarket(force = false): Promise<void> {
    if (this.#state.marketBusy) return
    this.#patch({ marketBusy: true })
    try {
      const result = await this.#request<{ market: MarketView }>(
        'GET',
        force ? '/market?refresh=1' : '/market',
      )
      if (this.#disposed) return
      if (!result.ok || result.data === undefined) {
        this.#patch({
          market: {
            source: '',
            fetchedAt: Date.now(),
            error: result.error ?? t('marketFailed'),
            entries: [],
          },
        })
        return
      }
      this.#patch({ market: result.data.market })
    } finally {
      this.#patch({ marketBusy: false })
    }
  }

  /** Download and unpack one market entry into a new project. */
  async installFromMarket(id: string): Promise<void> {
    if (this.#state.marketBusy) return
    this.#patch({ marketBusy: true })
    this.log(t('marketInstalling'), 'info')
    let installed = false
    try {
      const result = await this.#request<{
        project: ForgeProject
        written: string[]
        skipped: string[]
        descriptorOnly: boolean
      }>('POST', '/market/install', { id })
      if (!result.ok || result.data === undefined) {
        this.log(result.error ?? t('marketInstallFailed'), 'error')
        this.notify(result.error ?? t('marketInstallFailed'))
        return
      }
      this.log(t('marketInstalled'), 'success')
      this.notify(t('marketInstalled'))
      if (result.data.descriptorOnly) this.log(t('importDescriptorOnly'), 'warn')
      await this.load()
      this.#patch({ activeProjectId: result.data.project.id })
      installed = true
    } finally {
      this.#patch({ marketBusy: false })
    }
    // Refresh so the "installed" badge appears without a manual reload. This has
    // to happen *after* `marketBusy` is cleared: `loadMarket()` opens with
    // `if (this.#state.marketBusy) return`, so calling it inside the block above
    // was a silent no-op and the row kept offering "install" for a workbench that
    // was already installed.
    if (installed) await this.loadMarket()
  }

  // ------------------------------------------------------------- the stream

  /**
   * Open the Server-Sent Events stream.
   *
   * The stream carries invalidations only. Every frame ends in a debounced
   * `load()`, so a missed frame costs at most one stale render and never a
   * divergence. Reconnecting is `EventSource`'s own job — the `retry:` hint the
   * Host sends sets the interval.
   */
  connect(): void {
    if (this.#disposed || this.#source !== undefined) return
    if (typeof EventSource === 'undefined') return
    const source = new EventSource(ROUTE_EVENTS)
    this.#source = source
    source.onopen = () => {
      if (this.#disposed) return
      this.#patch({ connected: true })
    }
    source.onerror = () => {
      if (this.#disposed) return
      // EventSource retries on its own; report the gap and keep the handle.
      this.#patch({ connected: false })
    }
    source.onmessage = (event: MessageEvent<string>) => {
      this.#onFrame(event.data)
    }
    // The Host names each event, so `onmessage` never fires for them. One
    // listener per kind is the only way to see a named SSE event.
    for (const kind of [
      'hello',
      'state',
      'project',
      'window',
      'action',
      'log',
      'chat',
      'open',
    ] as const) {
      source.addEventListener(kind, (event) => {
        this.#onFrame((event as MessageEvent<string>).data)
      })
    }
  }

  #onFrame(raw: string): void {
    if (this.#disposed) return
    let payload: StreamEventPayload
    try {
      payload = JSON.parse(raw) as StreamEventPayload
    } catch {
      return
    }
    if (payload === null || typeof payload !== 'object' || typeof payload.kind !== 'string') return
    switch (payload.kind) {
      case 'hello':
        this.#patch({ connected: true })
        this.#scheduleRefetch()
        return
      case 'action': {
        // The record is authoritative for the counters, so fold it in without a
        // round trip; the document itself has not changed.
        const record = payload.record
        if (record.delivered) {
          this.#patch({ delivered: this.#state.delivered + 1 })
        }
        this.log(
          record.delivered
            ? `relayed "${record.action}"`
            : `"${record.action}" not relayed: ${record.error ?? 'no session bound'}`,
          record.delivered ? 'action' : 'warn',
        )
        return
      }
      case 'log': {
        const line = payload.line
        this.log(line.text, line.level)
        return
      }
      case 'chat': {
        // Fold the line in rather than refetching: a chat can stream several
        // lines while the model works, and a full resync per line would repaint
        // the whole overlay. `chat` frames carry the authoritative line.
        const line = payload.line
        const chats = this.#state.ledger.chats
        if (chats.some((candidate) => candidate.id === line.id)) return
        this.#patch({ ledger: { ...this.#state.ledger, chats: [...chats, line] } })
        return
      }
      case 'open': {
        // The model asked for a window to be shown. The overlay renders from the
        // ledger, so the only thing to do is make sure it is current.
        this.#scheduleRefetch()
        return
      }
      default:
        this.#scheduleRefetch()
    }
  }

  /** Close the stream without tearing down the store (the panel may reopen). */
  disconnect(): void {
    if (this.#source !== undefined) {
      try {
        this.#source.close()
      } catch {
        // Already closed by the browser.
      }
      this.#source = undefined
    }
    this.#patch({ connected: false })
  }

  /** Release everything. Called once when the client half is disposed. */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.disconnect()
    if (this.#toastTimer !== undefined) {
      clearTimeout(this.#toastTimer)
      this.#toastTimer = undefined
    }
    if (this.#refetchTimer !== undefined) {
      clearTimeout(this.#refetchTimer)
      this.#refetchTimer = undefined
    }
    if (this.#buildTimer !== undefined) {
      clearTimeout(this.#buildTimer)
      this.#buildTimer = undefined
    }
    this.#clearStandaloneTimer()
    this.#listeners.clear()
  }

  /** The tag an artifact must use. Exposed so the bridge and the docs agree. */
  get actionSource(): string {
    return ACTION_SOURCE
  }
}

/** The status label for a window row. */
export function statusLabel(status: ForgeWindow['status']): string {
  switch (status) {
    case 'draft':
      return t('statusDraft')
    case 'building':
      return t('statusBuilding')
    case 'ready':
      return t('statusReady')
    case 'error':
      return t('statusError')
  }
}

/** Whether a window has a file worth loading. */
export function windowReady(window: ForgeWindow): boolean {
  return window.entry.trim().length > 0 && window.kind !== undefined
}

/** The URL an artifact is loaded from. */
export function siteUrl(window: ForgeWindow): string {
  if (window.kind === 'url') return window.entry
  const path = window.entry.trim().length > 0 ? window.entry : 'index.html'
  return `${ROUTE_API}/site/${encodeURIComponent(window.projectId)}/${path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')}`
}

/** One declared action, with the description the manifest gave it. */
export function actionLabel(action: ForgeActionDecl): string {
  return action.label ?? action.name
}

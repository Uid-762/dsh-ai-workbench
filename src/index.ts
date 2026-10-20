/**
 * The Host half of `dsh-ai-workbench`.
 *
 * ## What this plugin is
 *
 * A non-coder types one sentence into a sidebar panel ("帮我做一个记账的小窗口"),
 * the model asks a few plain-language questions, then writes a self-contained
 * HTML file into a project folder, and the plugin mounts that file as a live
 * window on the user's screen. Buttons inside the window that the artifact
 * *declares* can send an action back into the session, so the loop closes:
 * describe → interview → build → click → the model reacts.
 *
 * ## Why the Host is thin
 *
 * The Host owns exactly five things: the ledger file, the HTTP surface, the
 * event stream, the model channel, and the authoring skill. It does not render,
 * does not hold a canvas, and never inspects the artifact's contents. A generated
 * window is the user's file on the user's disk — the plugin serves it and gets
 * out of the way, which is what makes the artifact editable by hand and
 * survivable across a plugin reload.
 *
 * ## `inject` is empty on purpose
 *
 * A hard inject is an activation gate: a declared-but-unprovided service parks
 * the fiber in `waiting` forever and `apply()` never runs. Every service used
 * here has a documented degraded mode — no `webServer` means no routes but the
 * tool still works; no `sessionController` means actions are journalled and
 * shown but not delivered; no `skills` means the guide is still appended to the
 * build prompt. So the plugin activates everywhere and degrades loudly in its own
 * journal instead of silently failing to start.
 */
import { randomUUID } from 'node:crypto'
import type { Context, Events } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Config, normalizeConfig, type ForgeConfig } from './config.ts'
import { exportProject } from './bundle.ts'
import { ForgeLedgerStore, resolveHome } from './ledger.ts'
import {
  BUNDLE_EXTENSION,
  LEGACY_LEDGER_FILE_NAME,
  MIN_WINDOW_H,
  MIN_WINDOW_W,
  PROTOCOL_VERSION,
  ROUTE_API,
  ROUTE_EVENTS,
  WORKBENCH_BUILD_ACTION,
  WORKBENCH_BUILD_LABEL,
  slugify,
  type ForgeProject,
  type ForgeWindow,
  type JsonValue,
} from './protocol.ts'
import { createApiHandler, type ApiDeps, type ForwardResult } from './routes/api.ts'
import { EventHub } from './routes/sse.ts'
import { createWorkbenchWindowTool, type ForgeToolLedgerFace } from './tools/workbench_window.ts'
import {
  WORKBENCH_SKILL_CONTENT,
  WORKBENCH_SKILL_DESCRIPTION,
  WORKBENCH_SKILL_NAME,
  WORKBENCH_SKILL_WHEN,
} from './skill.ts'

export { Config }
export type { ForgeConfig }

/** Bundle row id and settings namespace, kept in step with `cordis.patch.yml`. */
export const name = 'dsh-ai-workbench'

/** Settings namespace shown on the plugin's settings page. */
export const NAMESPACE = 'dsh-ai-workbench'

/** The skill this plugin contributes, for the panel to cite and the tool to name. */
export const SKILL_NAME = WORKBENCH_SKILL_NAME

/**
 * Hard dependencies. Empty on purpose — see the module doc.
 *
 * The brief for an earlier version of this plugin asked for `installSection()`,
 * which does not exist in this DSH generation: the settings page is generated
 * from the plugin's own exported `Config` schema, so no service has to be
 * injected for it.
 */
export const inject: string[] = []

/** The `sessionController` face, as this plugin uses it. */
interface SessionControllerFace {
  prompt(
    request: {
      requestId: string
      sessionId: string
      mode: 'queue' | 'steer'
      content: readonly { type: 'text'; text: string }[]
    },
    signal?: AbortSignal,
  ): Promise<unknown>
  create?(request: { cwd?: string; workspaceId?: string }): Promise<{ sessionId?: unknown }>
}

/** The `settings` face, as this plugin uses it. */
interface SettingsFace {
  /** Present in DSH generations that expose per-plugin sections directly. */
  installSection?: (namespace: string, options?: unknown) => () => void
  /** The current generation: a schema projected into the settings UI. */
  configure?: (presentation: { auto?: boolean }, owner?: unknown) => () => void
}

/** The `skills` face, as this plugin uses it. */
interface SkillsFace {
  register(skill: {
    name: string
    description: string
    content: string
    whenToUse?: string
  }): () => void
}

/** Options the tool passes to {@link ForgeHost.summon}. */
interface SummonRequest {
  projectId?: string
  windowId?: string
}

/** A reference to the fiber, used as the settings owner. */
interface FiberLike {
  readonly fiber?: unknown
}

/** Why a prompt could not be delivered. Mirrors the API's `ForwardResult`. */
type DeliveryResult =
  | { ok: true; sessionId: string }
  | { ok: false; reason: 'unbound' }
  | { ok: false; reason: 'failed'; error: string }

/**
 * Everything the plugin owns at runtime, assembled once per `apply`.
 *
 * A class rather than a bag of closures because the lifecycle matters: the
 * ledger open is asynchronous while `apply` is synchronous, so every entry point
 * awaits {@link ForgeHost.ready} and reports a real error instead of racing it.
 */
class ForgeHost {
  readonly config: ForgeConfig
  readonly hub = new EventHub()
  readonly ledgerPath: string
  readonly ready: Promise<ForgeLedgerStore>
  /** Root folder new projects are created under. */
  readonly projectsRoot: string
  /** Session the panel is bound to; the model's tool call is what sets it. */
  #sessionId: string | undefined
  #ledger: ForgeLedgerStore | undefined
  #ctx: Context | undefined
  #disposed = false

  constructor(config: ForgeConfig) {
    this.config = config
    // `config.dshHome` defaults to the empty string, which means "use the DSH
    // home". Resolving it here (rather than joining the raw value) is what keeps
    // the ledger out of the process working directory: `join('', name)` is a
    // *relative* path, and a relative path lands wherever the harness happened to
    // be started from. `resolveHome` implements the harness precedence —
    // explicit config, then `$DSH_HOME` (blank ignored), then `~/.dsh`.
    const home = resolveHome(config.dshHome)
    this.projectsRoot = join(home, 'ai-workbench')
    this.ledgerPath = join(home, config.ledgerFile)
    this.ready = ForgeLedgerStore.open({
      home,
      fileName: config.ledgerFile,
      // Only adopt the previous release's ledger when the new one is absent, so
      // a user who installs this build keeps every project they already made.
      legacyFileName: LEGACY_LEDGER_FILE_NAME,
      maxJournalEntries: config.journalActions ? config.maxJournalEntries : 0,
      maxProjects: config.maxProjects,
      maxWindowsPerProject: config.maxWindowsPerProject,
    }).then((ledger) => {
      this.#ledger = ledger
      this.hub.attach(ledger)
      ledger.logLine(`ledger ready at ${ledger.path} (revision ${ledger.revision})`, 'info')
      return ledger
    })
    // A failed open must not become an unhandled rejection; the first request
    // that awaits `ready` reports it to the caller instead.
    this.ready.catch(() => undefined)
  }

  /** The open ledger, or `undefined` while {@link ready} has not settled. */
  get ledger(): ForgeLedgerStore | undefined {
    return this.#ledger
  }

  /** Session artifact actions are delivered to, when one is bound. */
  get sessionId(): string | undefined {
    return this.#sessionId
  }

  /** Attach the context so late lookups can reach optional services. */
  attachContext(ctx: Context): void {
    this.#ctx = ctx
  }

  /**
   * Bind the panel to a session.
   *
   * Called from the tool, where the caller is known. The browser cannot supply
   * this: `sidebar.panellist` and `shell.overlay` are root-scope seats with no
   * session context, and no `activeSessionId` accessor exists in the shipped
   * client types. The model's own tool call is the only reliable signal.
   */
  bind(sessionId: string | undefined): void {
    if (sessionId === undefined || sessionId === '') return
    this.#sessionId = sessionId
    void this.#ledger?.logLine(`bound to session ${sessionId}`, 'info')
  }

  /**
   * Ask every open panel to come forward.
   *
   * Returns the number of live subscribers, which is the honest answer to "did
   * anyone hear this": `0` means the panel is not open in this browser, and the
   * tool reports that rather than pretending the window appeared.
   */
  summon(request: SummonRequest): number {
    const listeners = this.hub.size
    this.hub.broadcast({
      kind: 'open',
      revision: this.#ledger?.revision ?? 0,
      ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
      ...(request.windowId === undefined ? {} : { windowId: request.windowId }),
    })
    return listeners
  }

  /**
   * The default folder for a project the model did not place itself.
   *
   * Slugging happens here rather than in the tool so the Host owns every path
   * join: the tool never concatenates separators, and a project name with
   * slashes or dots cannot escape the root.
   */
  defaultFolder(projectName: string): string {
    return join(this.projectsRoot, slugify(projectName))
  }

  /**
   * Put a line from the model into one project's chat pane.
   *
   * This is what makes the workbench conversational rather than one-shot: the
   * model can ask its question where the artifact is, and the user answers next
   * to the thing they are looking at. The line goes through the ledger (so it
   * survives a reload) and over SSE (so an open pane shows it immediately).
   */
  ask(projectId: string, text: string): void {
    const ledger = this.#ledger
    if (ledger === undefined) return
    const line = ledger.appendChat({ projectId, role: 'model', text })
    if (line === undefined) return
    this.hub.broadcast({ kind: 'chat', revision: ledger.revision, projectId, line })
  }

  /**
   * Write a project's portable bundle next to its files.
   *
   * Used by the tool's `export` action. It writes to `<folder>/<slug>.dshwb.json`
   * rather than returning the bundle, because a bundle inlines every page: the
   * model has no use for that text and it would cost it the whole context window.
   */
  async exportBundle(projectId: string): Promise<{ path: string; files: number; skipped: number } | undefined> {
    const ledger = this.#ledger
    if (ledger === undefined) return undefined
    const project = ledger.project(projectId)
    if (project === undefined) return undefined
    const exported = await exportProject(ledger.file, projectId)
    if (!exported.ok) return undefined
    const path = join(project.folder, `${slugify(project.name)}${BUNDLE_EXTENSION}`)
    try {
      await writeFile(path, JSON.stringify(exported.bundle, undefined, 2), 'utf8')
    } catch {
      return undefined
    }
    return {
      path,
      files: exported.bundle.files.length,
      skipped: exported.skipped.length,
    }
  }

  /**
   * Make sure a project has a session, creating one when it does not.
   *
   * The session's `cwd` is the project folder, and that is the whole point: the
   * model then writes `index.html` as a *relative* path and the file lands in the
   * folder this plugin serves. Creating the session anywhere else would make the
   * model write into the harness's working directory and the window would stay
   * empty while the model reported success.
   */
  async ensureSession(projectId: string): Promise<{ sessionId?: string; error?: string }> {
    const ledger = this.#ledger
    if (ledger === undefined) return { error: 'the ledger is not open yet' }
    const project = ledger.project(projectId)
    if (project === undefined) return { error: `no such project: ${projectId}` }
    if (project.sessionId !== undefined && project.sessionId !== '') {
      return { sessionId: project.sessionId }
    }
    const controller = this.#sessionController()
    if (controller === undefined) return { error: 'this DSH build exposes no session controller' }
    if (typeof controller.create !== 'function') {
      // Older hosts can create a session but not through this service. The tool
      // path still binds a session the model already has, so report the limit
      // rather than inventing an id.
      return { error: 'this DSH build cannot create sessions from a plugin' }
    }
    try {
      const created = await controller.create({ cwd: project.folder })
      const id = typeof created.sessionId === 'string' ? created.sessionId : undefined
      if (id === undefined || id === '') return { error: 'the session controller returned no id' }
      ledger.updateProject(projectId, { sessionId: id })
      void ledger.logLine(`created session ${id} for ${project.name}`, 'info')
      return { sessionId: id }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      void ledger.logLine(`could not create a session: ${message}`, 'error')
      return { error: message }
    }
  }

  /**
   * Build the prompt handed to the session for one artifact action.
   *
   * The wording matters more than it looks. The model sees this as a user turn,
   * so it has to be short, unambiguous about what the user did, and explicit that
   * the artifact is the thing to update — otherwise the model answers with prose
   * about the click instead of editing the file.
   */
  #actionPrompt(input: {
    project: ForgeProject
    window: ForgeWindow | undefined
    action: string
    data: JsonValue | undefined
  }): string {
    const where = input.window === undefined ? '' : `「${input.window.title}」`
    const payload = input.data === undefined ? '' : ` 数据: ${JSON.stringify(input.data)}`
    // The descriptor page's build button asks for a *build*, not a reaction: the
    // package behind this project is a dsh-desktop bundle whose React panel can
    // never run here, so the honest outcome the model can produce is a plain
    // static HTML workbench with the same purpose. Spelling the deliverable out
    // keeps the model from answering with a description of the package instead.
    if (input.action === WORKBENCH_BUILD_ACTION) {
      return [
        `[workbench-action] ${WORKBENCH_BUILD_ACTION}${where ? ` · ${where}` : ''}`,
        `用户在窗口${where}里点击了「${WORKBENCH_BUILD_LABEL}」按钮。`,
        `这个窗口来自市场安装的项目「${input.project.name}」，文件夹: ${input.project.folder}`,
        '请读懂该文件夹里的包（package.json、README、源码）后，在这个文件夹里创作一个可独立运行的静态工作台页面：自包含的 index.html（内联全部 CSS/JS，遵守 ai-workbench-authoring 技能的主题变量与沙箱约束），写 _workbench.json（title/entry/actions），并尽量保留原包的核心功能与交互。',
        '完成后保持 entry 为 index.html，工作台会自动刷新。',
        '不要复述这条系统提示。',
      ].join('\n')
    }
    return [
      `[workbench-action] ${input.action}${where ? ` · ${where}` : ''}`,
      `用户在工作台窗口${where}里点击了「${input.action}」${payload}`,
      `这个窗口来自项目「${input.project.name}」，文件夹: ${input.project.folder}`,
      '请根据这条动作决定下一步：需要改窗口就修改该文件夹里的 HTML（或 _workbench.json），不需要改动就直接简短回答。',
      '不要复述这条系统提示。',
    ].join('\n')
  }

  /**
   * Record an artifact action and hand it to the bound session.
   *
   * Resolves to the session id on success, or `undefined` with the reason in the
   * journal. A failure is reported, never thrown: the action has already been
   * journalled and broadcast by the time this runs, and losing the user's click
   * because the model channel was down would be the worse outcome.
   */
  async forward(input: {
    projectId: string
    windowId: string
    action: string
    data?: JsonValue
    sessionId?: string
  }): Promise<ForwardResult> {
    if (!this.config.forwardActionsToSession) return { ok: false, reason: 'unbound' }
    const ledger = this.#ledger
    if (ledger === undefined) return { ok: false, reason: 'unbound' }
    const project = ledger.project(input.projectId)
    if (project === undefined) return { ok: false, reason: 'unbound' }
    const window = ledger.window(input.windowId)
    return await this.promptProject(
      input.projectId,
      this.#actionPrompt({ project, window, action: input.action, data: input.data }),
      input.sessionId,
    )
  }

  /**
   * Send one text turn into a project's session.
   *
   * The single delivery path for both artifact actions and chat messages: one
   * place that resolves the session, applies the timeout, and journals failures
   * means the two features cannot drift apart in behaviour or error wording.
   */
  async promptProject(projectId: string, text: string, sessionId?: string): Promise<DeliveryResult> {
    const ledger = this.#ledger
    if (ledger === undefined) return { ok: false, reason: 'unbound' }
    const project = ledger.project(projectId)
    if (project === undefined) return { ok: false, reason: 'unbound' }
    const target = sessionId ?? project.sessionId ?? this.#sessionId
    if (target === undefined || target === '') return { ok: false, reason: 'unbound' }
    const controller = this.#sessionController()
    if (controller === undefined) return { ok: false, reason: 'unbound' }
    if (text.trim().length === 0) return { ok: false, reason: 'unbound' }

    const abort = new AbortController()
    const timer = setTimeout(() => {
      abort.abort()
    }, 10_000)
    timer.unref?.()
    try {
      await controller.prompt(
        {
          requestId: `workbench-${randomUUID()}`,
          sessionId: target,
          mode: 'queue',
          content: [{ type: 'text', text }],
        },
        abort.signal,
      )
      return { ok: true, sessionId: target }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      void ledger.logLine(`delivery to ${target} failed: ${message}`, 'error')
      return { ok: false, reason: 'failed', error: message }
    } finally {
      clearTimeout(timer)
    }
  }

  /** Probe for the session controller without making it an activation gate. */
  #sessionController(): SessionControllerFace | undefined {
    const probe = this.#ctx?.get('sessionController') as SessionControllerFace | undefined
    if (probe !== undefined && typeof probe.prompt === 'function') return probe
    return undefined
  }

  /**
   * Read a session's event log.
   *
   * The chat pane needs the model's *reply*, and a reply only exists as session
   * events — it never comes back through the API that sent the prompt. Inspecting
   * rather than following is deliberate: `inspect` does not activate the agent, so
   * reading a transcript cannot start a turn or spend tokens.
   *
   * Returns `undefined` when this build exposes no readable log; the caller treats
   * that as "no new replies" rather than as an error, because a pane that cannot
   * see replies is still useful for sending them.
   */
  async inspectSession(sessionId: string): Promise<readonly unknown[] | undefined> {
    const probe = this.#ctx?.get('sessionController') as
      | { inspect?: (id: string, signal?: AbortSignal) => Promise<unknown> }
      | undefined
    if (probe === undefined || typeof probe.inspect !== 'function') return undefined
    const abort = new AbortController()
    const timer = setTimeout(() => {
      abort.abort()
    }, 5_000)
    timer.unref?.()
    try {
      const inspected = (await probe.inspect(sessionId, abort.signal)) as { events?: unknown } | undefined
      const events = inspected?.events
      return Array.isArray(events) ? (events as readonly unknown[]) : undefined
    } catch {
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }

  /** The ledger, or a thrown error naming the reason it is unavailable. */
  #requireLedger(): ForgeLedgerStore {
    if (this.#ledger === undefined) throw new Error('the ai-workbench ledger is not open yet')
    return this.#ledger
  }

  /** The ledger face the HTTP routes talk to. */
  ledgerFace(): ForgeLedgerStore {
    return this.#requireLedger()
  }

  /** The narrower ledger face the tool talks to. */
  toolLedgerFace(): ForgeToolLedgerFace {
    const require = (): ForgeLedgerStore => this.#requireLedger()
    return {
      get path() {
        return require().path
      },
      get revision() {
        return require().revision
      },
      get projects() {
        return require().projects
      },
      project: (id) => require().project(id),
      createProject: (input) => require().createProject(input),
      updateProject: (id, patch) => require().updateProject(id, patch),
      createWindow: (input) => require().createWindow(input),
      updateWindow: (id, patch) => require().updateWindow(id, patch),
      windowsOf: (projectId) => require().windowsOf(projectId),
      logLine: (text, level) => {
        require().logLine(text, level ?? 'info')
      },
      flush: () => require().flush(),
    }
  }

  /** Release every resource. Safe to call twice. */
  async close(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.hub.closeAll()
    try {
      const ledger = await this.ready
      await ledger.flush()
      await ledger.dispose()
    } catch {
      // Nothing left to do: the ledger never opened, or the disk is gone.
    }
  }
}

/**
 * Register a settings surface for this plugin.
 *
 * No `installSection()` exists in this DSH generation: the settings page is
 * generated from the plugin's own `Config` schema, and this helper prefers the
 * explicit call when a host does provide it (so the intent survives an upgrade)
 * and otherwise asks the current settings service to project the schema, which
 * is what actually puts these fields on the settings page today.
 */
function installSettingsSection(ctx: Context, owner: unknown): void {
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.get('settings') as SettingsFace | undefined
    if (settings === undefined) return
    settingsCtx.effect(() => {
      try {
        if (typeof settings.installSection === 'function') {
          return settings.installSection(NAMESPACE, { schema: Config })
        }
        if (typeof settings.configure === 'function') {
          return settings.configure({ auto: true }, owner)
        }
      } catch {
        // `configure` throws when this instance already registered a policy —
        // exactly what a second mount of this plugin would do. Losing the
        // settings page is survivable; taking the composition down is not.
      }
      return () => undefined
    }, `${name}: settings section`)
  })
}

/**
 * Contribute the authoring guide as a real skill.
 *
 * The guide ships inside the plugin rather than as a directory the user has to
 * install: the product promise is "type a sentence and get a window", and asking
 * a non-coder to install a skill first would break it. The skill is registered
 * through the harness registry so the model can load the full text on demand,
 * while the build prompt carries only the condensed digest.
 */
function installSkill(ctx: Context): void {
  ctx.inject(['skills'], (skillCtx) => {
    const skills = skillCtx.get('skills') as SkillsFace | undefined
    if (skills === undefined || typeof skills.register !== 'function') return
    skillCtx.effect(
      () =>
        skills.register({
          name: WORKBENCH_SKILL_NAME,
          description: WORKBENCH_SKILL_DESCRIPTION,
          whenToUse: WORKBENCH_SKILL_WHEN,
          content: WORKBENCH_SKILL_CONTENT,
        }),
      `${name}: authoring skill`,
    )
  })
}

/**
 * Run a registration that a *composition* contract may reject.
 *
 * `webServer.register` throws on a duplicate `(kind, path)` and `tools.register`
 * can reject a duplicate tool name. Both are composition-level collisions: they
 * mean another plugin (or a second mount of this one) already claimed the name.
 * A plugin that throws here is a plugin that can take down the whole tree, so the
 * collision is absorbed and logged instead — the other half of this plugin, and
 * every other plugin, keeps working.
 */
function guardRegistration(label: string, register: () => () => void): () => void {
  try {
    return register()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.emitWarning(`${label} is already taken; this plugin stood down for that surface (${message})`, {
      code: 'DSH_AI_WORKBENCH_COLLISION',
    })
    return () => undefined
  }
}

/**
 * Plugin entry point.
 *
 * Cordis calls this once per bundle row with the row's validated `config`.
 */
export function apply(ctx: Context, config?: Partial<ForgeConfig>): void {
  const resolved = normalizeConfig(config)
  const host = new ForgeHost(resolved)
  host.attachContext(ctx)

  ctx.effect(
    () => () => {
      void host.close()
    },
    `${name}: ledger and event hub`,
  )

  // ---- loopback HTTP: JSON API, artifact host, event stream ----------------
  if (resolved.serveHttp) {
    ctx.inject(['webServer'], (webCtx) => {
      const webServer = webCtx.get('webServer') as
        | {
            register(route: {
              kind: 'exact' | 'prefix'
              path: string
              handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
            }): () => void
          }
        | undefined
      if (webServer === undefined) return

      const deps: ApiDeps = {
        // Deferred on purpose: this object is built synchronously during boot,
        // while the ledger finishes opening later. See `ApiDeps.ledger`.
        ledger: () => host.ledgerFace(),
        hub: host.hub,
        limits: {
          minWindowW: MIN_WINDOW_W,
          minWindowH: MIN_WINDOW_H,
          maxProjects: resolved.maxProjects,
          maxWindowsPerProject: resolved.maxWindowsPerProject,
          maxChatLines: 240,
          protocolVersion: PROTOCOL_VERSION,
        },
        forward: (input) => host.forward(input),
        promptProject: (projectId, text, sessionId) => host.promptProject(projectId, text, sessionId),
        ensureSession: (projectId) => host.ensureSession(projectId),
        journal: (text, level) => {
          void host.ledger?.logLine(text, level)
        },
        defaultFolder: (projectName) => host.defaultFolder(projectName),
        projectsRoot: host.projectsRoot,
        marketUrl: resolved.marketUrl,
        marketProxy: resolved.marketProxy,
        skillName: resolved.registerSkill ? WORKBENCH_SKILL_NAME : undefined,
        inspectSession: (sessionId) => host.inspectSession(sessionId),
        interviewFirst: resolved.interviewFirst,
        chatPane: resolved.chatPane,
      }
      const api = createApiHandler(deps, ROUTE_API)

      webCtx.effect(
        () =>
          guardRegistration(`${name}: route ${ROUTE_API}`, () =>
            webServer.register({
              kind: 'prefix',
              path: ROUTE_API,
              handler: async (req, res) => {
                try {
                  await host.ready
                } catch (error) {
                  const message = error instanceof Error ? error.message : String(error)
                  res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
                  res.end(JSON.stringify({ ok: false, error: `ledger unavailable: ${message}`, revision: 0 }))
                  return
                }
                await api(req, res)
              },
            }),
          ),
        `${name}: api route`,
      )

      webCtx.effect(
        () =>
          guardRegistration(`${name}: route ${ROUTE_EVENTS}`, () =>
            webServer.register({
              kind: 'exact',
              path: ROUTE_EVENTS,
              handler: async (req, res) => {
                if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
                  res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET' })
                  res.end('the event stream is GET-only')
                  return
                }
                let revision = 0
                try {
                  const ledger = await host.ready
                  revision = ledger.revision
                } catch {
                  // An unopened ledger still gets a stream: the panel shows the
                  // error and stays alive so the user can retry.
                }
                host.hub.adopt(res, revision)
              },
            }),
          ),
        `${name}: event route`,
      )
    })
  }

  // ---- the model-facing tool ---------------------------------------------
  if (resolved.registerTool) {
    ctx.inject(['tools'], (toolsCtx) => {
      const tools = toolsCtx.get('tools') as { register(definition: unknown): () => void } | undefined
      if (tools === undefined) return
      toolsCtx.effect(
        () =>
          guardRegistration(`${name}: tool workbench_window`, () =>
            tools.register(
              createWorkbenchWindowTool({
                ledger: host.toolLedgerFace(),
                defaultFolder: (projectName) => host.defaultFolder(projectName),
                summon: (request) => host.summon(request),
                bind: (sessionId) => {
                  host.bind(sessionId)
                },
                ask: (projectId, text) => {
                  host.ask(projectId, text)
                },
                exportBundle: (projectId) => host.exportBundle(projectId),
              }),
            ),
          ),
        `${name}: workbench_window tool`,
      )
    })
  }

  // ---- the authoring skill ------------------------------------------------
  if (resolved.registerSkill) installSkill(ctx)

  // ---- settings surface ---------------------------------------------------
  installSettingsSection(ctx, (ctx as unknown as FiberLike).fiber)

  // ---- teardown -----------------------------------------------------------
  ctx.on('dispose' as keyof Events, () => {
    void host.close()
  })
}

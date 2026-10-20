/**
 * The `workbench_window` tool.
 *
 * This is the model's half of the contract. It does a few things and no more:
 * bind the calling session to a project (so artifact actions have somewhere to
 * go), make sure that project exists on disk, bring the panel forward, and —
 * through the extra actions below — speak to the user inside the workbench
 * instead of only in the conversation column.
 *
 * Everything the model *produces* it produces by writing files. That is the
 * whole design: a generated window is an HTML file in a folder, not an API call,
 * so the artifact survives the plugin being reloaded, can be opened by hand, and
 * can be edited by the user or by the model with ordinary file tools.
 *
 * The tool deliberately does NOT accept the artifact's contents as an argument.
 * A window is often tens of kilobytes; routing that through a tool call would
 * burn the model's context twice (once to write it, once to read it back) and
 * would make the file the plugin's private property instead of the user's. The
 * same reasoning is why `export` writes the bundle to disk and returns its path
 * rather than returning the bundle itself.
 */
import type { GenericCallView, GenericResultView, JsonSchemaNode, ToolDefinition } from '@deepseek-ai/dsh-tools'
import { MANIFEST_FILE, type ForgeProject, type ForgeWindow, type JsonValue } from '../protocol.ts'

/** Structural stand-ins for the harness types, kept local on purpose. */
interface ContentBlock {
  type: 'text'
  text: string
}

/**
 * The ledger surface the tool needs.
 *
 * Structural rather than imported so the tool can be unit-tested without a
 * ledger, and so the set of operations the model can reach is readable in one
 * screen — that is the security boundary worth being able to audit.
 */
export interface ForgeToolLedgerFace {
  readonly path: string
  readonly revision: number
  readonly projects: readonly ForgeProject[]
  project(id: string): ForgeProject | undefined
  createProject(input: { name: string; folder: string; request?: string }): { project: ForgeProject; reused: boolean }
  updateProject(id: string, patch: { sessionId?: string; request?: string }): ForgeProject | undefined
  createWindow(input: {
    projectId: string
    title: string
    kind: 'html' | 'url'
    entry?: string
    note?: string
  }): ForgeWindow
  updateWindow(id: string, patch: { status?: ForgeWindow['status'] }): ForgeWindow | undefined
  windowsOf(projectId: string): ForgeWindow[]
  logLine(text: string, level?: 'info' | 'warn' | 'error' | 'action' | 'success'): void
  flush(): Promise<void>
}

export interface ForgeToolDeps {
  ledger: ForgeToolLedgerFace
  /** Remember which session the caller is in. */
  bind(sessionId: string | undefined): void
  /** Bring the panel forward; returns how many browsers heard it. */
  summon(request: { projectId?: string; windowId?: string }): number
  /**
   * The folder a new project gets when the model names none.
   *
   * A function rather than a root path so the Host keeps ownership of path
   * joining and slugging; the tool never concatenates separators itself.
   */
  defaultFolder(name: string): string
  /**
   * Put one line into the workbench's own chat pane, as the model.
   *
   * This is the difference between a tool that opens a window and one the user
   * can hold a conversation with: the question appears next to the artifact,
   * where the user is looking, and their answer comes back as an action or as a
   * chat message — both of which land in this same session.
   */
  ask(projectId: string, text: string): void
  /**
   * Write the project's portable bundle next to its files and return the path.
   *
   * On disk rather than in the response because a bundle inlines every page and
   * asset: handing it back through a tool result would fill the model's context
   * with a file it has no use for.
   */
  exportBundle(projectId: string): Promise<{ path: string; files: number; skipped: number } | undefined>
}

/**
 * The tool's argument schema.
 *
 * `satisfies` rather than a type annotation: `JsonSchemaNode` is a union, and a
 * union is not assignable to the `Record<string, unknown>` that `ToolSchema`
 * wants for `parameters`. Checking the literal against `JsonSchemaNode` keeps the
 * validation while the declared type stays the concrete object shape, which the
 * registry accepts.
 */
const PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['open', 'create', 'ask', 'building', 'export'],
      description: [
        'open: bring the panel forward for an existing project (the default).',
        'create: make a new project folder first.',
        'ask: put a question to the user inside the workbench chat pane and open it — use this instead of asking in the conversation when the answer only matters to this window.',
        'building: mark the project\'s window as still being written, so the panel shows progress while you edit files.',
        'export: write a shareable .dshwb.json bundle next to the project files and return its path.',
      ].join(' '),
    },
    projectId: {
      type: 'string',
      description: 'Project to act on. Omit to use the project bound to this session, or the most recent one.',
    },
    name: {
      type: 'string',
      description: 'Project name, used for `create` and for the folder when `folder` is omitted.',
    },
    folder: {
      type: 'string',
      description:
        'Absolute folder for the project. Every generated artifact must be written inside it. Omit to place it under the plugin default root.',
    },
    requirement: {
      type: 'string',
      description: "The user's own words, stored on the project so the panel can show what is being built.",
    },
    question: {
      type: 'string',
      description: 'For action=ask: the question to show in the workbench chat pane. Plain language, one or two sentences.',
    },
    note: {
      type: 'string',
      description: 'One short line for the panel journal, explaining why the window was opened.',
    },
  },
  required: [],
  additionalProperties: false,
} satisfies JsonSchemaNode

const OUTPUT_SCHEMA: JsonSchemaNode = {
  type: 'string',
  description: 'Field protocol describing the project, its folder, and the artifact contract.',
}

/** Pull a non-empty string out of untrusted tool arguments. */
function pick(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Guarantee the project has a window row, and return it.
 *
 * Without this the model's own path is invisible: the panel creates the row when
 * *the user* submits a request, but a model that calls this tool first (the
 * documented order) writes a page and a manifest into a project that has no row
 * at all. `reconcileWindows` then skips the project entirely — it only walks
 * projects that already have windows — so nothing ever mounts and the model
 * reports success over an empty panel.
 *
 * The row is created with an empty `entry` on purpose: the folder may not have a
 * file yet, and reconcile adopts the real name once one resolves. Claiming
 * `index.html` up front would show a broken frame if the model picks another name.
 */
function ensureWindow(ledger: ForgeToolLedgerFace, project: ForgeProject, note: string | undefined): ForgeWindow {
  const existing = ledger.windowsOf(project.id)
  const newest = existing[existing.length - 1]
  if (newest !== undefined) return newest
  return ledger.createWindow({
    projectId: project.id,
    title: project.name,
    kind: 'html',
    ...(note === undefined ? {} : { note }),
  })
}

/** Coerce untrusted tool arguments into a record. */
function argsOf(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return raw as Record<string, unknown>
}

/**
 * Build the tool definition.
 *
 * Nothing here runs until the model calls it, and nothing here writes an
 * artifact: the model writes files with its own file tools once this returns the
 * folder and the contract.
 */
export function createWorkbenchWindowTool(deps: ForgeToolDeps): ToolDefinition {
  return {
    name: 'workbench_window',
    description: [
      'Open the AI Workbench: a panel where a non-coder describes the window they want in plain words, and the artifact you build is mounted as a live window beside a chat pane bound to that same workbench.',
      'Call this FIRST, before writing anything. It returns the project folder and the artifact contract.',
      'Then write a self-contained HTML file into that folder, and optionally a _workbench.json manifest next to it naming the entry file and the actions the window may send back.',
      'The panel mounts the file automatically; no further tool call is needed to make it appear.',
      'Use action=ask to put a question to the user inside the workbench when the answer only concerns this window.',
      'Use it whenever the user asks for a window, a panel, a dashboard, a form, a board, or any small interactive tool inside DSH.',
    ].join(' '),
    parameters: PARAMETERS,

    output: {
      schema: OUTPUT_SCHEMA,
      render(_args: unknown, value: JsonValue): ContentBlock[] {
        return [{ type: 'text', text: String(value) }]
      },
      presentationMeta(_args: unknown, value: JsonValue): JsonValue {
        return { route: '/apps/ai-workbench', report: String(value) } as unknown as JsonValue
      },
    },

    async execute(rawArgs: unknown, exec?: { agent?: { id?: unknown } }): Promise<string> {
      const args = argsOf(rawArgs)
      const { ledger } = deps

      // Bind before anything else. A call that fails to find a project has still
      // told us which session the user is looking at, and that binding is what
      // makes later artifact actions deliverable.
      const caller = exec?.agent?.id
      const boundSession = typeof caller === 'string' && caller !== '' ? caller : undefined
      deps.bind(boundSession)

      const action = pick(args, 'action') ?? 'open'
      const wantCreate = action === 'create'
      const requestedId = pick(args, 'projectId')
      const name = pick(args, 'name')
      const folder = pick(args, 'folder')
      const requirement = pick(args, 'requirement')

      let project: ForgeProject | undefined
      // Set when the create path folded into an existing row: the returned
      // protocol then tells the model it is editing, not minting.
      let reusedFolder = false
      if (requestedId !== undefined) {
        project = ledger.project(requestedId)
        if (project === undefined) {
          return [
            '[workbench-window]',
            'status=error',
            `error=no project with id ${requestedId}`,
            `known=${ledger.projects.map((entry) => entry.id).join(',') || 'none'}`,
            'next=Call again with action=create and a name to make one.',
          ].join('\n')
        }
      } else if (wantCreate || ledger.projects.length === 0) {
        const projectName = name ?? '未命名工作台'
        // Blank is absent, same as the HTTP route: an empty folder would make the
        // session's `cwd` the harness process directory.
        const explicit = folder !== undefined && folder.trim().length > 0 ? folder.trim() : undefined
        // The ledger deduplicates by folder, so a `create` quoting a path the
        // panel already created (the task text quotes it, and the model reads its
        // own mail) folds into the existing row instead of minting a second,
        // windowless project over the same files. The requirement rides along so
        // the fold still records what this round is building.
        const created = ledger.createProject({
          name: projectName,
          folder: explicit ?? deps.defaultFolder(projectName),
          request: requirement,
        })
        project = created.project
        reusedFolder = created.reused
      } else {
        // Reuse the project already bound to this session when there is one:
        // a second call in the same conversation should not spawn a new folder.
        project = ledger.projects.find((entry) => entry.sessionId !== undefined) ?? ledger.projects[0]
      }

      if (project === undefined) {
        return ['[workbench-window]', 'status=error', 'error=the ledger has no project to open'].join('\n')
      }

      if (requirement !== undefined) {
        ledger.updateProject(project.id, { request: requirement })
      }
      // Stamp the project with the calling session. This is the durable half of
      // the binding: artifact actions look it up per project, long after this
      // tool call has returned, and the ledger survives a reload.
      if (boundSession !== undefined) {
        ledger.updateProject(project.id, { sessionId: boundSession })
      }
      await ledger.flush()

      const note = pick(args, 'note')
      if (note !== undefined) ledger.logLine(note, 'info')

      // ---- the extra actions, before the common summon ---------------------

      if (action === 'ask') {
        const question = pick(args, 'question') ?? note
        if (question === undefined) {
          return [
            '[workbench-window]',
            'status=error',
            'error=action=ask needs a `question` argument',
            `projectId=${project.id}`,
          ].join('\n')
        }
        deps.ask(project.id, question)
        const row = ensureWindow(ledger, project, note)
        const listeners = deps.summon({ projectId: project.id, windowId: row.id })
        await ledger.flush()
        return [
          '[workbench-window]',
          'status=asked',
          `projectId=${project.id}`,
          `windowId=${row.id}`,
          `project=${project.name}`,
          `listeners=${listeners}`,
          'next=The question is now in the workbench chat pane. Stop here and wait for the user\'s answer; do not write files on a guess.',
        ].join('\n')
      }

      if (action === 'building') {
        // A refine started from the chat pane has no panel-side row update, so
        // without this the window would keep claiming `ready` while its file is
        // being rewritten. The panel's own build path sets this itself; this is
        // the equivalent for edits the model initiates.
        const row = ensureWindow(ledger, project, note)
        ledger.updateWindow(row.id, { status: 'building' })
        const listeners = deps.summon({ projectId: project.id, windowId: row.id })
        await ledger.flush()
        return [
          '[workbench-window]',
          'status=building',
          `projectId=${project.id}`,
          `windowId=${row.id}`,
          `listeners=${listeners}`,
          'next=Edit the files in the folder, then stop. The panel flips the window back to ready by itself once the entry file resolves.',
        ].join('\n')
      }

      if (action === 'export') {
        const written = await deps.exportBundle(project.id)
        if (written === undefined) {
          return [
            '[workbench-window]',
            'status=error',
            `error=could not write a bundle for ${project.id}`,
            `folder=${project.folder}`,
            'next=Tell the user to use the Export button in the panel instead.',
          ].join('\n')
        }
        await ledger.flush()
        return [
          '[workbench-window]',
          'status=exported',
          `projectId=${project.id}`,
          `bundle=${written.path}`,
          `files=${written.files}`,
          `skipped=${written.skipped}`,
          'next=Tell the user where the file is in one sentence. Do not paste its contents.',
        ].join('\n')
      }

      // ---- open / create ---------------------------------------------------

      // The row exists before the model writes anything, so the panel can show
      // "building" from the first poll instead of staying empty until a file
      // happens to resolve.
      const row = ensureWindow(ledger, project, note)
      await ledger.flush()
      const listeners = deps.summon({ projectId: project.id, windowId: row.id })
      const existing = ledger.windowsOf(project.id)

      return [
        '[workbench-window]',
        'status=opened',
        `projectId=${project.id}`,
        `windowId=${row.id}`,
        `project=${project.name}`,
        `folder=${project.folder}`,
        reusedFolder ? 'reused=true (the folder was already a project; edit its files in place)' : 'reused=false',
        `windows=${existing.length}`,
        `listeners=${listeners}`,
        `manifest=${MANIFEST_FILE}`,
        `ledger=${ledger.path}`,
        `revision=${ledger.revision}`,
        '',
        'next=Write a single self-contained HTML file inside the folder above (inline <style> and <script>; no build step, no CDN that needs a network).',
        `next=Optionally write ${MANIFEST_FILE} in the same folder: {"title":"...","entry":"index.html","actions":[{"name":"submit","label":"提交","description":"..."}]}. The panel reads it and mounts the window automatically.`,
        'next=Only the action names you list there are relayed back to you when the user triggers them. The artifact sends one with: parent.postMessage({source:"dsh-ai-workbench",action:"submit",data:{...}},"*").',
        'next=Style with the host theme variables (--dsw-alias-bg-base, --dsw-alias-label-primary, --dsw-alias-border-l1, --dsw-alias-brand-primary) so the window matches the app.',
        'next=The user can also talk to you about this workbench in its own chat pane; those messages arrive with a summary of the project attached.',
      ].join('\n')
    },

    presentCall(rawArgs: unknown): GenericCallView {
      const args = argsOf(rawArgs)
      return {
        card: 'generic',
        title: `AI Workbench — ${pick(args, 'name') ?? pick(args, 'projectId') ?? 'workbench'}`,
        kind: 'other',
        rawInput: args,
      }
    },

    presentResult(_args: unknown, result: unknown): GenericResultView {
      return {
        card: 'generic',
        title: 'AI Workbench',
        content: [{ type: 'text', text: String(result) }],
      }
    },
  }
}

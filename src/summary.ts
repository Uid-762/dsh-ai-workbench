/**
 * The workbench summary prepended to every chat-pane message.
 *
 * ## Why this module exists
 *
 * The chat pane talks to the *same* session that built the artifact, but a
 * session is a long conversation: by the time the user asks "把金额那列加个合计",
 * the turn where the window was built may be thousands of tokens back, or the
 * session may have been created fresh for this project. A model that has to
 * reconstruct "which window am I looking at, what can its buttons send, what did
 * the user just click" from history will guess, and a guess here means editing
 * the wrong file.
 *
 * So every message carries a compact, factual description of the workbench: the
 * folder, the windows, their declared actions, the layout preset, and the last
 * few things the user did inside the artifact. It is generated from the ledger
 * and the journal — never from the model's memory — so it cannot drift from what
 * is actually on screen.
 *
 * ## Why it is a separate module
 *
 * It is pure: a ledger in, a string out. No I/O, no clock beyond the timestamps
 * already recorded, no cordis context. That keeps it testable and keeps the
 * wording of "what the model is told about this workbench" in one place instead
 * of scattered through the routes.
 */
import {
  effectivePhase,
  type ForgeLedger,
  type ForgeLogLine,
  type ForgeProject,
  type ForgeWindow,
} from './protocol.ts'

/** How many journal lines are quoted back to the model. */
const RECENT_ACTIONS = 8

/** How many windows are described before the list is truncated. */
const MAX_WINDOWS = 6

/** One line describing what a window is and what it can send back. */
function describeWindow(window: ForgeWindow, entryBytes: number | undefined): string[] {
  const parts: string[] = []
  const state = window.status === 'ready' ? '已就绪' : window.status === 'building' ? '生成中' : window.status === 'error' ? '出错' : '草稿'
  const kind = window.kind === 'url' ? `外部页面 ${window.entry}` : `文件 ${window.entry.length > 0 ? window.entry : '(未定)'}`
  const size = entryBytes === undefined ? '' : ` · ${formatBytes(entryBytes)}`
  parts.push(`- 「${window.title}」· ${state} · ${kind}${size}`)
  const presentation: string[] = []
  if (window.layout !== undefined && window.layout !== 'auto') presentation.push(`版式 ${window.layout}`)
  if (window.placement === 'standalone') presentation.push('弹出到独立窗口')
  if (window.chat === true) presentation.push('右侧对话窗打开')
  if (presentation.length > 0) parts.push(`  ${presentation.join(' · ')}`)
  if (window.actions.length === 0) {
    parts.push('  声明动作: 无（页面里的按钮不会回传）')
  } else {
    const names = window.actions.map((action) => {
      const label = action.label !== undefined && action.label.length > 0 ? `（${action.label}）` : ''
      const why = action.description !== undefined && action.description.length > 0 ? ` — ${action.description}` : ''
      return `${action.name}${label}${why}`
    })
    parts.push(`  声明动作: ${names.join('; ')}`)
  }
  if (window.note !== undefined && window.note.trim().length > 0) {
    parts.push(`  备注: ${window.note.trim()}`)
  }
  if (window.inlineHtml !== undefined && window.inlineHtml.length > 0 && window.entry.length === 0) {
    parts.push('  来源: 导入/市场下载（HTML 存在账本里，还没有写到磁盘）')
  }
  return parts
}

/** The journal lines that belong to one project, newest last. */
function projectActions(ledger: ForgeLedger, project: ForgeProject): ForgeLogLine[] {
  const windowIds = new Set(ledger.windows.filter((window) => window.projectId === project.id).map((window) => window.id))
  const relevant = ledger.log.filter((line) => {
    if (line.level !== 'action' && line.level !== 'warn') return false
    if (line.text.includes(project.name)) return true
    for (const id of windowIds) {
      if (line.text.includes(id)) return true
    }
    return false
  })
  return relevant.slice(-RECENT_ACTIONS)
}

/** A clock the model can read without knowing the machine's locale rules. */
function clock(at: number): string {
  const date = new Date(at)
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Options for {@link buildWorkbenchSummary}. */
export interface SummaryOptions {
  /** Sizes of each window's entry file, keyed by window id. Host reads these. */
  sizes?: ReadonlyMap<string, number>
}

/**
 * Build the summary block.
 *
 * Returns an empty string when the project does not exist, so a caller can
 * concatenate it unconditionally.
 */
export function buildWorkbenchSummary(
  ledger: ForgeLedger,
  projectId: string,
  options: SummaryOptions = {},
): string {
  const project = ledger.projects.find((candidate) => candidate.id === projectId)
  if (project === undefined) return ''
  const windows = ledger.windows.filter((window) => window.projectId === projectId)
  const phase = effectivePhase(project)
  const lines: string[] = []
  lines.push('【工作台摘要】')
  lines.push(`项目: ${project.name}（${project.id}）`)
  lines.push(`文件夹: ${project.folder}`)
  lines.push(`会话: ${project.sessionId ?? '尚未创建'}`)
  lines.push(`阶段: ${phase === 'intake' ? '需求访谈中（还没开始写页面）' : '已进入构建/迭代'}`)
  if (project.request !== undefined && project.request.trim().length > 0) {
    lines.push(`用户最初的需求: ${project.request.trim()}`)
  }
  if (project.intake !== undefined && project.intake.trim().length > 0) {
    lines.push(`访谈确认: ${project.intake.trim()}`)
  }
  lines.push(`窗口数: ${windows.length}`)
  for (const window of windows.slice(0, MAX_WINDOWS)) {
    lines.push(...describeWindow(window, options.sizes?.get(window.id)))
  }
  if (windows.length > MAX_WINDOWS) lines.push(`- 另有 ${windows.length - MAX_WINDOWS} 个窗口未列出`)
  const actions = projectActions(ledger, project)
  if (actions.length > 0) {
    lines.push('最近的交互:')
    for (const line of actions) lines.push(`- ${clock(line.at)} ${line.text}`)
  }
  lines.push('这个工作台是一个自包含单文件 HTML（内联 CSS/JS），在沙箱 iframe 里运行：没有同源权限，localStorage 会抛错。')
  lines.push('页面只能回传 _workbench.json 里声明过的动作，其他点击不会到达你这里。')
  lines.push('需要改界面就修改上面文件夹里的 HTML 和 _workbench.json；只回答问题就不用改文件。')
  return lines.join('\n')
}

/**
 * Wrap a user message for the chat pane.
 *
 * The summary goes first and the user's own words last, because the last thing
 * before the model's turn is what it reads most carefully.
 */
export function chatTurn(summary: string, message: string): string {
  const text = message.trim()
  if (summary.trim().length === 0) return text
  return [
    '[workbench-chat] 用户在工作台右侧的对话窗里说话。',
    '',
    summary,
    '',
    '【用户这句话】',
    text,
  ].join('\n')
}

/**
 * Pull the assistant's plain text out of one session event.
 *
 * The event shape is the harness's `assistant/message`: `data.message.content`
 * is an array of content blocks and only `text` blocks are spoken prose. Tool
 * calls and reasoning blocks are skipped — quoting a tool call back into a chat
 * bubble would show the user machinery they cannot act on.
 */
export function assistantText(event: unknown): string | undefined {
  const outer = asRecord(event)
  if (outer.type !== 'assistant/message') return undefined
  const data = asRecord(outer.data)
  const message = asRecord(data.message)
  return blocksText(message.content)
}

/**
 * Pull the user's plain text out of one session event.
 *
 * Needed to tell the chat pane's own turns apart from the user's ordinary
 * conversation: a project's session is the session the user already talks to the
 * model in, so every assistant message in it is not a workbench reply.
 */
export function userText(event: unknown): string | undefined {
  const outer = asRecord(event)
  if (outer.type !== 'user/message') return undefined
  return blocksText(asRecord(outer.data).content)
}

function blocksText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    const item = asRecord(block)
    if (item.type !== 'text') continue
    if (typeof item.text !== 'string') continue
    const text = item.text.trim()
    if (text.length > 0) parts.push(text)
  }
  if (parts.length === 0) return undefined
  return parts.join('\n\n')
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

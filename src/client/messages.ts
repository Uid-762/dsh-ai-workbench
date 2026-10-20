/**
 * Runtime UI copy.
 *
 * `locale/*.json` is read by the installer only — it looks at `meta.title` and
 * `meta.description` and nothing else. Anything the running UI renders has to
 * travel inside the client bundle, so the dictionaries live here.
 *
 * English is the source of truth: `MessageKey` is derived from the `en` object,
 * and `zh` is typed as a total map over it. Adding a key to one dictionary and
 * forgetting the other is therefore a compile error, not a blank label that only
 * shows up in production.
 */

import { useSyncExternalStore } from 'react'

/** Namespace the dictionaries are registered under with the shell's locale service. */
export const LOCALE_NS = 'ai-workbench'

const en = {
  title: 'AI Workbench',
  panelHint: 'Describe a window in plain language and the model builds it',

  // --- project chrome -----------------------------------------------------
  projects: 'Projects',
  newProject: 'New project',
  createTitle: 'Create a new workbench',
  createSubtitle: 'Describe it in plain language — the model builds the page for you',
  projectNamePlaceholder: 'Project name',
  create: 'Create',
  cancel: 'Cancel',
  remove: 'Remove',
  folder: 'Folder',
  noProjects: 'No project yet — describe a window below and one is created for you.',
  openFolder: 'Show folder path',

  // --- the one input ------------------------------------------------------
  requestTitle: 'What window do you want?',
  requestPlaceholder:
    'Say it in your own words, for example: a check-in sheet that tracks how much water I drink each day',
  submit: 'Build this window',
  submitting: 'Sending to the model…',
  needRequest: 'Describe the window first.',

  // --- window list --------------------------------------------------------
  windows: 'Windows',
  noWindows: 'No window yet.',
  statusDraft: 'Draft',
  statusBuilding: 'Building',
  statusReady: 'Ready',
  statusError: 'Failed',
  open: 'Open',
  close: 'Close',
  minimize: 'Minimize',
  restore: 'Restore',
  fullscreen: 'Fullscreen',
  exitFullscreen: 'Exit fullscreen',
  refresh: 'Reload',
  removeWindow: 'Delete this window',
  resize: 'Resize',
  actions: 'Relayed actions',
  noActions: 'No actions declared',
  actionsHint:
    'Only the actions listed in _workbench.json are sent to the model. Everything else the page does stays local.',

  // --- layout & placement --------------------------------------------------
  layout: 'Layout',
  layoutHint: 'Tell the model how to structure the page',
  layoutAuto: 'Auto',
  layoutSingle: 'Single column',
  layoutTwoCol: 'Two columns',
  layoutThreeCol: 'Three columns',
  layoutGrid: '2×2 grid',
  layoutTopOne: 'Top block',
  layoutDashboard: 'Dashboard',
  layoutDesc_auto: 'The model picks a structure that fits the request',
  layoutDesc_single: 'One column, stacked top to bottom',
  layoutDesc_twoCol: 'A wide main pane beside a side pane',
  layoutDesc_threeCol: 'Three panes side by side',
  layoutDesc_grid2x2: 'Four equal panes in a 2×2 grid',
  layoutDesc_topOne: 'One full-width block over two half-width ones',
  layoutDesc_dashboard: 'An uneven mosaic of stat cards and panes',
  folderHint: 'Where the workbench files live; the default already points into the DSH home',
  deleteProjectHint: 'Remove this project and delete its files',
  confirmDelete: 'Delete',
  marketZoomHint: 'Click to view the full screenshot',
  placement: 'Opens in',
  placementEmbedded: 'In-app overlay',
  placementStandalone: 'Its own tab',
  placementEmbeddedHint: 'Floats over this panel; best for a workbench you glance at while you keep chatting',
  placementStandaloneHint: 'Gets its own browser tab; best for a workbench you use full-screen for a while',
  popout: 'Pop out',
  popoutDone: 'Opened in its own tab.',
  popoutFailed: 'Could not open a tab.',

  // --- console ------------------------------------------------------------
  log: 'Activity',
  clearLog: 'Clear',
  noLog: 'Nothing yet.',

  // --- states -------------------------------------------------------------
  waitingForModel: 'Waiting for the model to write the page…',
  windowEmpty: 'This window has no page yet.',
  windowEmptyHint: 'Ask for one in the composer above, or reopen this project and build again.',
  fullscreenActive: 'Maximised',
  windowBlocked: 'This page refused to load. The file may be missing from the project folder.',
  sessionNone: 'No session yet — one is created with the first request.',
  sessionCreated: 'Started a session for this project.',
  sessionReused: 'Reusing this project’s session.',
  sessionFailed: 'Could not reach a session. Open a chat and ask the model to open the workbench.',
  sent: 'Sent to the model. It will write the page into the project folder.',
  sendFailed: 'Could not send the request.',
  projectCreated: 'Project created.',
  projectDeleted: 'Project removed.',
  windowDeleted: 'Window removed.',
  saved: 'Saved.',
  saveFailed: 'The Host refused that change.',
  copied: 'Copied.',
  needProject: 'Create a project first.',
  commandPlaceholder: 'Type a command and press Enter (try: help)',
  help: 'Commands: help · projects · windows · log · refresh · clear',

  // --- intake (the interview before building) ------------------------------
  intakeTitle: 'A few questions first',
  intakeHint:
    'Answer in your own words — this is what the model builds against. Nothing is built until you confirm.',
  intakeStart: 'Answer a few questions first',
  intakeSkip: 'Just build it from my description',
  intakeNext: 'Next',
  intakeBack: 'Back',
  intakeConfirm: 'Looks right, build it',
  intakeRestart: 'Start over',
  intakeSummary: 'This is what I understood',
  intakeOptional: 'optional',
  intakeChooseMany: 'pick any that apply',
  intakeAnswers: 'Your answers',
  intakeNothingAnswered: 'You did not answer anything, so the model will ask you first.',

  // --- chat pane ----------------------------------------------------------
  chat: 'Chat',
  chatTitle: 'Talk about this workbench',
  chatHint:
    'The model sees a summary of this workbench — its files, its buttons, its layout — before every message, so it knows what you are looking at.',
  chatPlaceholder: 'Ask for a change, or ask how this workbench works',
  chatSend: 'Send',
  chatClear: 'Clear chat',
  chatEmpty: 'No messages yet.',
  chatNoSession: 'This workbench has no session yet. Build it once first.',
  chatDisabled: 'The chat pane is turned off in this plugin’s settings.',
  chatContext: 'What the model was told',
  chatOpenSession: 'Open the session',
  chatRefresh: 'Check for replies',
  notDelivered: 'Not delivered',

  // --- import / export ----------------------------------------------------
  export: 'Export',
  exportHint: 'Download this workbench as one file you can share',
  exported: 'Exported. The file is in your downloads.',
  exportFailed: 'Could not export this workbench.',
  exportSkipped: 'Some files were left out because they are too large or binary.',
  import: 'Import',
  importHint: 'Open a workbench file someone shared with you',
  imported: 'Imported. It is open now.',
  importFailed: 'Could not import that file.',
  importNotJson: 'That file is not a workbench file.',
  importDescriptorOnly:
    'This is a dsh-desktop workbench: its README and source were imported, but its native panel cannot run in this DSH build.',

  // --- market -------------------------------------------------------------
  market: 'Market',
  marketHint: 'Workbenches shared by other people',
  marketRefresh: 'Refresh',
  marketLoading: 'Loading the catalog…',
  marketEmpty: 'The catalog is empty.',
  marketFailed: 'Could not reach the catalog.',
  marketInstall: 'Install',
  marketInstalled: 'Installed',
  marketInstalling: 'Downloading…',
  marketInstallFailed: 'Could not install that workbench.',
  marketSource: 'Catalog',
  marketRunnable: 'Runs here',
  marketDescriptorOnly: 'Info page only',
  marketFetched: 'Fetched {time}',
  marketShowAll: 'Show all {count} more',
  marketShowLess: 'Show fewer',
  actionLoggedOnly: 'recorded — ask the AI in the chat pane when you want something done',

  // --- misc ---------------------------------------------------------------
  editMode: 'Editing',
  templates: 'Templates',
  closeChat: 'Close chat',
} as const

/** Every key the UI can ask for. Derived, so it cannot drift from `en`. */
export type MessageKey = keyof typeof en

const zh: Record<MessageKey, string> = {
  title: '工作台',
  panelHint: '用大白话描述你要的窗口，模型会把它做出来',

  projects: '项目',
  newProject: '新建项目',
  createTitle: '新建工作台',
  createSubtitle: '用大白话描述你要什么，模型会帮你把页面做出来',
  projectNamePlaceholder: '项目名称',
  create: '创建',
  cancel: '取消',
  remove: '删除',
  folder: '文件夹',
  noProjects: '还没有项目——在下面描述一个窗口，会自动建一个。',
  openFolder: '查看文件夹路径',

  requestTitle: '你想要一个什么样的窗口？',
  requestPlaceholder: '用自己的话说就行，例如：一个记录我每天喝多少水的打卡表',
  submit: '生成这个窗口',
  submitting: '正在发给模型…',
  needRequest: '请先描述你要的窗口。',

  windows: '窗口',
  noWindows: '还没有窗口。',
  statusDraft: '草稿',
  statusBuilding: '生成中',
  statusReady: '就绪',
  statusError: '失败',
  open: '打开',
  close: '关闭',
  minimize: '最小化',
  restore: '还原',
  fullscreen: '全屏',
  exitFullscreen: '退出全屏',
  refresh: '重新加载',
  removeWindow: '删除这个窗口',
  resize: '调整大小',
  actions: '回传动作',
  noActions: '未声明动作',
  actionsHint: '只有在 _forge.json 里声明过的动作才会发给模型，页面里的其他操作都留在本地。',

  layout: '布局',
  layoutHint: '告诉模型页面按什么结构组织',
  layoutAuto: '自动',
  layoutSingle: '单栏',
  layoutTwoCol: '两栏',
  layoutThreeCol: '三栏',
  layoutGrid: '四宫格',
  layoutTopOne: '顶部大块',
  layoutDashboard: '仪表盘',
  layoutDesc_auto: '由模型按需求挑一个合适的结构',
  layoutDesc_single: '一栏，从上到下排布',
  layoutDesc_twoCol: '宽主栏 + 侧栏',
  layoutDesc_threeCol: '三栏并排',
  layoutDesc_grid2x2: '四个等分的 2×2 网格',
  layoutDesc_topOne: '上方一整块，下方左右两块',
  layoutDesc_dashboard: '大小不一的卡片拼成的仪表盘',
  folderHint: '工作台文件存放的位置；默认已指向 DSH 主目录',
  deleteProjectHint: '删除这个项目，并删除它的文件',
  confirmDelete: '删除',
  marketZoomHint: '点击查看完整截图',
  placement: '打开方式',
  placementEmbedded: '应用内浮层',
  placementStandalone: '独立标签页',
  placementEmbeddedHint: '浮在本面板上方显示；适合边聊边看的窗口',
  placementStandaloneHint: '在浏览器独立标签页打开；适合要全屏用一阵的窗口',
  popout: '弹出窗口',
  popoutDone: '已在独立标签页打开。',
  popoutFailed: '没能打开独立标签页。',

  log: '动态',
  clearLog: '清空',
  noLog: '暂无记录。',

  waitingForModel: '正在等模型写页面…',
  windowEmpty: '这个窗口还没有页面。',
  windowEmptyHint: '在上面的输入框里描述一下，或者重新打开这个项目再生成一次。',
  fullscreenActive: '已最大化',
  windowBlocked: '页面加载失败，项目文件夹里可能还没有这个文件。',
  sessionNone: '还没有会话——第一次提需求时会自动创建。',
  sessionCreated: '已为这个项目启动会话。',
  sessionReused: '正在复用这个项目的会话。',
  sessionFailed: '没能连上会话。请打开一个对话，让模型打开工作台。',
  sent: '已发给模型，它会把页面写进项目文件夹。',
  sendFailed: '发送失败。',
  projectCreated: '项目已创建。',
  projectDeleted: '项目已删除。',
  windowDeleted: '窗口已删除。',
  saved: '已保存。',
  saveFailed: 'Host 拒绝了这次修改。',
  copied: '已复制。',
  needProject: '请先创建一个项目。',
  commandPlaceholder: '输入命令后回车（试试：help）',
  help: '命令：help · projects · windows · log · refresh · clear',

  intakeTitle: '先问你几个问题',
  intakeHint: '用你自己的话说就行——模型会照着这些做。确认之前不会动手。',
  intakeStart: '先回答几个问题',
  intakeSkip: '就按我这句描述做',
  intakeNext: '下一步',
  intakeBack: '上一步',
  intakeConfirm: '没问题，开始做',
  intakeRestart: '重新回答',
  intakeSummary: '我理解到的需求',
  intakeOptional: '可留空',
  intakeChooseMany: '可以多选',
  intakeAnswers: '你的回答',
  intakeNothingAnswered: '你什么都没填，模型会先来问你。',

  chat: '对话',
  chatTitle: '聊聊这个工作台',
  chatHint: '每条消息发出前，模型都会先看到这个工作台的摘要——有哪些文件、哪些按钮、什么布局，所以它知道你在看什么。',
  chatPlaceholder: '让模型改点什么，或者问它这个工作台是怎么运作的',
  chatSend: '发送',
  chatClear: '清空对话',
  chatEmpty: '还没有消息。',
  chatNoSession: '这个工作台还没有会话，先让它生成一次。',
  chatDisabled: '对话窗已在插件设置里关闭。',
  chatContext: '模型看到的摘要',
  chatOpenSession: '打开会话',
  chatRefresh: '查看回复',
  notDelivered: '未送达',

  export: '导出',
  exportHint: '把这个工作台存成一个文件，可以发给别人',
  exported: '已导出，文件在下载目录里。',
  exportFailed: '导出失败。',
  exportSkipped: '有些文件太大或不是文本，没有包含进去。',
  import: '导入',
  importHint: '打开别人分享给你的工作台文件',
  imported: '已导入，已经打开了。',
  importFailed: '导入失败。',
  importNotJson: '这个文件不是工作台文件。',
  importDescriptorOnly: '这是 dsh-desktop 的工作台：它的说明和源码已导入，但它的原生面板在这个 DSH 版本里跑不起来。',

  market: '市场',
  marketHint: '别人分享的工作台',
  marketRefresh: '刷新',
  marketLoading: '正在加载目录…',
  marketEmpty: '目录是空的。',
  marketFailed: '连不上目录。',
  marketInstall: '安装',
  marketInstalled: '已安装',
  marketInstalling: '正在下载…',
  marketInstallFailed: '安装失败。',
  marketSource: '目录',
  marketRunnable: '可直接运行',
  marketDescriptorOnly: '仅说明页',
  marketFetched: '{time} 获取',
  marketShowAll: '展开剩余 {count} 个',
  marketShowLess: '收起',
  actionLoggedOnly: '已记录——需要处理时在对话里告诉 AI',

  editMode: '编辑中',
  templates: '模板',
  closeChat: '关闭对话',
}

interface LocaleFace {
  register?: (ns: string, dicts: Record<string, Record<string, string>>) => unknown
  registerFor?: (ns: string, locale: string, dict: Record<string, string>) => unknown
  bind?: (ns: string) => unknown
  subscribe?: (listener: () => void) => unknown
}

let service: LocaleFace | undefined
let bound: ((key: string, params?: Record<string, string | number>) => string) | undefined
let version = 0
const listeners = new Set<() => void>()

function notify(): void {
  version += 1
  for (const listener of listeners) listener()
}

/** Substitute `{name}` placeholders. Missing params are left as written. */
function fill(template: string, params?: Record<string, string | number>): string {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => {
    const value = params[key]
    return value === undefined ? whole : String(value)
  })
}

function prefersChinese(): boolean {
  const language =
    typeof navigator === 'undefined' ? '' : (navigator.language || navigator.languages?.[0] || '')
  return language.toLowerCase().startsWith('zh')
}

/** The dictionary to use when the shell's locale service is not answering. */
function fallbackDictionary(): Record<MessageKey, string> {
  return prefersChinese() ? zh : en
}

/**
 * Translate a key.
 *
 * Usable outside React (the store and the command runner call it), which is why
 * it is a module function rather than a hook. The shell's binding wins when it
 * has one; a miss falls back to the bundled dictionary so the UI never renders a
 * raw key.
 */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  if (bound !== undefined) {
    const translated = bound(key, params)
    // A binding that echoes the key or returns empty has no entry for us.
    if (translated.length > 0 && translated !== key) return translated
  }
  const dictionary = fallbackDictionary()
  return fill(dictionary[key] ?? en[key] ?? key, params)
}

/**
 * Register the dictionaries with the shell's locale service, when there is one.
 *
 * Reached optionally: a deployment without the locale service still renders, in
 * the language the browser asks for. Returns an idempotent disposer.
 */
export function attachLocale(candidate: unknown): () => void {
  if (candidate === null || typeof candidate !== 'object') return () => undefined
  const face = candidate as LocaleFace
  if (typeof face.register !== 'function' && typeof face.registerFor !== 'function') {
    return () => undefined
  }
  service = face

  const dicts = { en, zh }
  try {
    if (typeof face.register === 'function') face.register(LOCALE_NS, dicts)
    else if (typeof face.registerFor === 'function') {
      face.registerFor(LOCALE_NS, 'en', en)
      face.registerFor(LOCALE_NS, 'zh', zh)
    }
  } catch {
    // A namespace already registered by a previous instance is not fatal: the
    // bundled dictionaries still translate.
  }

  let unsubscribe: (() => void) | undefined
  try {
    if (typeof face.bind === 'function') {
      const result = face.bind(LOCALE_NS)
      // `bind` may hand back its own translator; prefer it when it does.
      if (typeof result === 'function') {
        bound = result as (key: string, params?: Record<string, string | number>) => string
      }
    }
    if (typeof face.subscribe === 'function') {
      const result = face.subscribe(notify)
      if (typeof result === 'function') unsubscribe = result as () => void
    }
  } catch {
    // Same reasoning: translation degrades to the bundled dictionary.
  }

  notify()

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    bound = undefined
    service = undefined
    if (unsubscribe !== undefined) {
      try {
        unsubscribe()
      } catch {
        // Nothing useful to do; the listener set is dropped anyway.
      }
    }
    listeners.clear()
  }
}

/** The locale service, if the caller found one. Kept for diagnostics. */
export function localeService(): unknown {
  return service
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function snapshot(): number {
  return version
}

/**
 * A component-level `t` that re-renders on a language switch.
 *
 * Subscribing rather than reading once matters because the shell can change
 * language while the panel is open, and a `label` thunk on a sidebar row is
 * re-read on every projection — a component that cached its strings would drift
 * out of step with the row that opened it.
 */
export function useLocale(): (key: MessageKey, params?: Record<string, string | number>) => string {
  useSyncExternalStore(subscribe, snapshot, snapshot)
  return t
}

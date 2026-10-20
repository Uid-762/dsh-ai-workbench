/**
 * The prompt the panel sends into a session when the user describes a window.
 *
 * This text IS the product. A non-coder types one sentence; everything the model
 * needs in order to produce a working window has to be in here, because the
 * model gets no other context about the workbench.
 *
 * Three rules shaped it:
 *
 *   1. **Say where to write.** The session is created with the project folder as
 *      its working directory, but a model that is not told so will happily
 *      scatter files. The folder is repeated in the text as well.
 *
 *   2. **Say what "a window" means technically.** A self-contained single file,
 *      no build step, no CDN, no external network — because the artifact is
 *      served from a loopback route and loaded in a sandboxed iframe.
 *
 *   3. **Say what comes back.** Only declared actions are relayed. Stating the
 *      `postMessage` shape and the manifest here is what makes the loop work
 *      without the model having to guess our protocol.
 */

import {
  ACTION_SOURCE,
  MANIFEST_FILE,
  WINDOW_LAYOUTS,
  type WindowLayout,
  type WindowPlacement,
} from '../protocol.ts'

/** The subset of the project the prompt needs. */
export interface TaskContext {
  /** Absolute project folder. */
  folder: string
  /** What the user asked for, in their own words. */
  requirement: string
  /**
   * The layout preset the user pinned in the panel. Passed only when it should
   * steer the page — `undefined` or `'auto'` leaves the shape to the model, and
   * during a refine it is passed only when the preset actually changed.
   */
  layout?: WindowLayout
  /** Where the window opens. Changes how much room the page may assume. */
  placement?: WindowPlacement
  /** Set when the model already produced a window and the user is refining it. */
  existing?: {
    title: string
    entry: string
    actions: readonly string[]
  }
  /**
   * The confirmed intake, when the interview ran.
   *
   * This is the transcript of the questions and the user's answers, handed over
   * verbatim. It is not summarized on the way in: the user's own wording about
   * what they want is the highest-signal part of the whole prompt, and a summary
   * written by the browser would be the worst possible place to lose it.
   */
  answers?: string
  /**
   * The built-in authoring skill, when the Host registered one.
   *
   * Named rather than inlined: the skill is a few thousand words and the model can
   * load it on demand. Mentioning it is what makes the reference discoverable
   * without spending the context on every single build.
   */
  skillName?: string
}

/** One-line human label per layout preset, keyed by the preset id. */
const LAYOUT_LABELS: Record<WindowLayout, string> = {
  auto: '自动',
  single: '单栏',
  'two-col': '两栏',
  'three-col': '三栏',
  'grid-2x2': '四宫格',
  'top-one': '顶部大块',
  dashboard: '仪表盘',
}

/**
 * What each layout preset means, in words a page-composing model can follow.
 *
 * These briefs are the whole reason the presets work: the Host never renders
 * anything, so the only place a preset can take effect is inside this prompt.
 */
const LAYOUT_BRIEFS: Record<WindowLayout, string> = {
  auto: '由你根据需求选择最合适的一种',
  single: '一列纵向排到底——适合清单、笔记、计时器这类单一主体',
  'two-col': '左右两列（窄屏自动上下叠）——适合「主内容 + 侧栏列表」',
  'three-col': '左中右三列（窄屏逐级收叠）——适合「导航 + 内容 + 详情」',
  'grid-2x2': '2×2 卡片网格——适合四个地位并列的模块',
  'top-one': '上方一个主区域，下方若干条目——适合「一块主视图 + 列表」',
  dashboard: '顶部摘要卡 + 下方多模块混排——适合统计、看板类',
}

/** The layout instruction for a build prompt. */
function layoutInstruction(layout: WindowLayout | undefined): string {
  if (layout === undefined || layout === 'auto') {
    const choices = WINDOW_LAYOUTS.filter((id) => id !== 'auto')
      .map((id) => `「${LAYOUT_LABELS[id]}」(${id})：${LAYOUT_BRIEFS[id]}`)
      .join('；')
    return `布局形态由你选择，可选：${choices}。`
  }
  return `用户为这个窗口选好了布局形态——「${LAYOUT_LABELS[layout]}」(${layout})：${LAYOUT_BRIEFS[layout]}。页面主体按这个结构组织。`
}

/** The placement instruction: how much room the page may assume. */
function placementInstruction(placement: WindowPlacement | undefined): string {
  if (placement === 'standalone') {
    return '这个窗口会以独立标签页弹出打开，空间充裕，可以用更宽松的排版和更大的留白。'
  }
  return '这个窗口默认以浮层嵌在应用里（最小 420×280），排版要紧凑，重点内容放左上。'
}

/**
 * Build the instruction text.
 *
 * Written in Chinese because the product is aimed at Chinese-speaking users who
 * are not developers: the model mirrors the language of the requirement, and the
 * surrounding instructions should not fight that.
 */
export function buildTaskText(context: TaskContext): string {
  const lines: string[] = []

  lines.push('【工作台 · 建窗任务】')
  lines.push('')
  lines.push(
    '你现在在 DSH 的「工作台」插件里工作。用户不是程序员，他用大白话描述了一个想要的小工具，你要把它做成一个能在工作台里打开、能点的窗口。',
  )
  lines.push('')
  lines.push('用户的需求：')
  lines.push(context.requirement.trim())
  lines.push('')
  lines.push('【布局形态】')
  lines.push(layoutInstruction(context.layout))
  lines.push('')
  lines.push('【打开方式】')
  lines.push(placementInstruction(context.placement))
  lines.push('')

  if (context.answers !== undefined && context.answers.trim().length > 0) {
    lines.push('【已经问过用户的问题和他的回答】')
    lines.push('下面这些是用户亲自回答的，比需求那一句更具体，按它做：')
    lines.push(context.answers.trim())
    lines.push('')
  }

  lines.push('项目文件夹（所有产出都写进这个文件夹，不要写到别的位置，也不要新建别的目录）：')
  lines.push(context.folder)
  lines.push('')

  if (context.skillName !== undefined && context.skillName.length > 0) {
    lines.push(
      `可参考的内置技能：${context.skillName}（里面有产物契约、主题变量、沙箱陷阱和前端设计要点，需要时先读它）。`,
    )
    lines.push('')
  }

  if (context.existing !== undefined) {
    lines.push('这个项目里已经有一个窗口了，请在它基础上改，不要推倒重来：')
    lines.push(`  标题：${context.existing.title}`)
    lines.push(`  入口文件：${context.existing.entry}`)
    lines.push(
      `  已声明的动作：${context.existing.actions.length > 0 ? context.existing.actions.join('、') : '（无）'}`,
    )
    lines.push('')
  }

  lines.push('要求：')
  lines.push('')
  lines.push(
    '1. 写一个自包含的单文件 HTML（默认就叫 index.html，可以覆盖）。CSS 和 JavaScript 全部内联。不要用 CDN、不要引用外网资源、不要构建步骤——这个页面是在一个沙箱 iframe 里直接加载本地文件的。',
  )
  lines.push(
    '2. 样式跟 DSH 主题走，这样深色、浅色模式都好看。颜色只用这些变量：var(--dsw-alias-bg-layer-1)、var(--dsw-alias-bg-layer-2)、var(--dsw-alias-label-primary)、var(--dsw-alias-label-secondary)、var(--dsw-alias-label-tertiary)、var(--dsw-alias-border-l1)、var(--dsw-alias-brand-primary)、var(--dsw-alias-state-success)、var(--dsw-alias-state-error)、var(--dsw-alias-state-warn)。页面背景保持透明，不要写死白底或黑底。字体用 system-ui。',
  )
  lines.push('3. 布局要能自适应：最窄 420px、最宽全屏都要能用。窄的时候不要横向滚动。')
  lines.push(
    '4. 状态保存在内存变量里即可。注意：这个页面跑在没有 allow-same-origin 的沙箱 iframe 里，origin 是不透明的，直接读写 localStorage 会抛 SecurityError——如果要持久化，必须把整段访问用 try/catch 包住，失败时静默退回内存，绝不能让这个异常打断主循环（计时器、动画、事件处理）。',
  )
  lines.push(
    '5. 交互要完整：该有的空状态、增删改、撤销或清除，都要有。不要只画一个静态界面。',
  )
  lines.push('')
  lines.push('6. 如果用户的需求里信息不够（比如要做什么内容、有哪些条目不清楚），页面里放一个能直接填写补全的入口，不要停下来追问——先做出一个能用的版本。')
  lines.push('')
  lines.push(`7. 在同目录写一个 ${MANIFEST_FILE}，告诉工作台这个窗口叫什么、入口是哪个文件、哪些动作要回传给模型：`)
  lines.push('   {')
  lines.push('     "title": "窗口标题（中文，短）",')
  lines.push('     "entry": "index.html",')
  lines.push('     "ready": true,')
  lines.push('     "actions": [')
  lines.push('       { "name": "add", "label": "添加", "description": "用户添加了一条记录" }')
  lines.push('     ]')
  lines.push('   }')
  lines.push('')
  lines.push('8. 只有当用户做了「模型需要知道」的事，才回传动作。回传方式：')
  lines.push(
    `   parent.postMessage({ source: '${ACTION_SOURCE}', action: '动作名', data: { ... } }, '*')`,
  )
  lines.push(
    `   没写在 ${MANIFEST_FILE} 的 actions 里的动作，工作台会直接丢掉。所以只声明真正需要模型处理的那几个——普通的前端交互（翻页、展开、输入校验）不要声明，它们留在本地就够了。`,
  )
  lines.push('')
  lines.push('做完之后，用一两句话告诉用户：窗口叫什么、打开后能做什么、哪个按钮会把事情告诉我。不要贴大段代码。')

  return lines.join('\n')
}

/**
 * One question the panel asks before it builds anything.
 *
 * Deliberately asked by the *panel*, not by the model. Making the model interview
 * the user costs a round trip, depends on the model choosing to ask rather than
 * build, and produces a different question set every time — a non-coder then has
 * to answer an unfamiliar form in a chat box. A fixed form is the same every time,
 * can be answered by clicking, and works even when no session exists yet.
 */
export interface IntakeQuestion {
  id: string
  /** The question itself, in plain language. */
  label: string
  /** One line of help under the question. */
  hint?: string
  /** Suggested answers offered as chips; the user can still type their own. */
  options?: readonly string[]
  /** `true` when the user may pick several chips. */
  multiple?: boolean
}

/**
 * The interview.
 *
 * Every question is answerable by someone who has never written code, and every
 * one changes what gets built: what it is for, what goes on the screen, whether
 * anything happens on its own, whether data has to survive a reload, what it
 * should look like, and what the user expects to be able to click. Nothing here
 * asks for a file name, a framework, or a data format.
 */
export const INTAKE_QUESTIONS: readonly IntakeQuestion[] = [
  {
    id: 'purpose',
    label: '这个小工具是做什么用的？给谁用？',
    hint: '一句话就行，比如「记录每天喝了几杯水，我自己用」。',
  },
  {
    id: 'content',
    label: '打开以后，屏幕上应该看到什么？',
    hint: '比如：一个列表、几个数字、一个日历、一张图。',
    options: ['一个清单', '几个统计数字', '一张表格', '一个日历', '一张图或图表'],
    multiple: true,
  },
  {
    id: 'automation',
    label: '需要它自己做点什么吗？（不用一直盯着）',
    hint: '比如每天提醒、每周自动总结、到点弹提示。没有就选「不需要」。',
    options: ['不需要，我手动操作', '要提醒我', '要定期自动总结', '要自动算数/统计'],
    multiple: true,
  },
  {
    id: 'storage',
    label: '关掉再打开，之前填的东西还要在吗？',
    hint: '这决定数据存哪里。不确定就选「要保留」。',
    options: ['要保留', '不用，每次重新开始'],
  },
  {
    id: 'style',
    label: '希望它看起来是什么风格？',
    hint: '选一个最接近的就好。',
    options: ['干净简洁', '紧凑信息多', '柔和好看', '像表格/仪表盘'],
  },
  {
    id: 'interaction',
    label: '你希望点哪里、能改什么？',
    hint: '比如：能加一条、能划掉、能改数字、能搜索。',
    options: ['能新增', '能修改', '能删除', '能搜索/筛选', '能排序'],
    multiple: true,
  },
  {
    id: 'extra',
    label: '还有什么要补充的吗？',
    hint: '没想到也没关系，可以留空。',
  },
]

/**
 * Render the answered interview as the block handed to the model.
 *
 * Questions the user skipped are omitted rather than sent as blanks: an empty
 * answer is not a requirement, and telling the model "they said nothing about
 * style" invites it to invent a constraint.
 */
export function buildAnswersText(
  answers: Readonly<Record<string, string>>,
  questions: readonly IntakeQuestion[] = INTAKE_QUESTIONS,
): string {
  const lines: string[] = []
  for (const question of questions) {
    const answer = (answers[question.id] ?? '').trim()
    if (answer.length === 0) continue
    lines.push(`- ${question.label} → ${answer}`)
  }
  return lines.join('\n')
}

/**
 * The prompt that opens the interview inside the session.
 *
 * Used only when the panel's own form was skipped (a user who types a paragraph
 * and presses build straight away). It asks the model to interview first and to
 * stop, which is the one thing a model will not do on its own: left alone it
 * builds immediately, and the user discovers the misunderstanding only after the
 * window exists.
 */
export function buildInterviewText(context: TaskContext): string {
  const lines: string[] = []
  lines.push('【工作台 · 先问清楚再动手】')
  lines.push('')
  lines.push('用户这样描述他想要的窗口：')
  lines.push(context.requirement.trim())
  lines.push('')
  lines.push(
    '用户不是程序员。现在**先不要写任何文件、不要调用工具**，只用大白话问他 5 到 7 个问题，把需求问清楚。',
  )
  lines.push('')
  lines.push('问的时候遵守这几条：')
  lines.push('1. 每个问题都要附上你推荐的选项（两三个），让他可以直接挑，不用自己想怎么答。')
  lines.push(
    '2. 要问到这些方面：这东西给谁用、屏幕上要看到什么、需不需要它自己定时做事（比如每天提醒、每周自动总结）、关掉再打开数据还要不要、界面想要什么风格、他希望点哪里能做什么。',
  )
  lines.push('3. 不要问技术问题：不要问文件名、框架、数据库、API、JSON 格式。')
  lines.push('4. 一次把问题问完，不要一个一个来回。')
  lines.push('5. 最后用一段话总结你理解到的需求，并问他「就按这个做，对吗？」')
  lines.push('')
  lines.push(
    '问完就停下，等用户回答。等他确认之后，你会在下一条消息里收到确认过的需求，那时候再开始建窗口。',
  )
  return lines.join('\n')
}

/**
 * The short follow-up used when the user refines an existing window.
 *
 * Kept separate from {@link buildTaskText} because a refinement does not need the
 * full contract restated — the window already exists and already declares its
 * actions. Repeating the whole brief would waste context and invite the model to
 * rewrite the file from scratch.
 */
export function buildRefineText(context: TaskContext): string {
  const existing = context.existing
  const lines: string[] = []
  lines.push('【工作台 · 修改窗口】')
  lines.push('')
  lines.push('用户对现有的窗口提了新的要求：')
  lines.push(context.requirement.trim())
  lines.push('')
  lines.push(`项目文件夹：${context.folder}`)
  lines.push(
    '提醒：页面跑在没有 allow-same-origin 的沙箱 iframe 里，origin 是不透明的，直接读写 localStorage 会抛 SecurityError。新增或修改涉及持久化的代码时，整段访问必须用 try/catch 包住，失败时静默退回内存，绝不能让这个异常打断主循环。',
  )
  if (existing !== undefined) {
    lines.push(`现有入口文件：${existing.entry}`)
    if (existing.actions.length > 0) {
      lines.push(`现有已声明动作：${existing.actions.join('、')}`)
    }
  }
  lines.push('')
  lines.push(
    `请在现有文件上直接改，保持它还是自包含的单文件 HTML；如果动作有变化，同步更新 ${MANIFEST_FILE}。改完用一两句话说明改了什么。`,
  )
  return lines.join('\n')
}

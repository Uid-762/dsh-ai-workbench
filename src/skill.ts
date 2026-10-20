/**
 * The curated authoring guide shipped with the workbench.
 *
 * Why this module exists: the model that builds a window gets no other context
 * about the product. It is handed one sentence from a non-coder and must return
 * a working page. Everything that makes the difference between "a page that
 * renders" and "a window the user keeps opening" — the artifact contract, the
 * theme variables, the sandbox trap, the action protocol, the layout and
 * accessibility floors — lives here.
 *
 * Two consumers read this file and they must not drift:
 *
 *   1. The DSH skill registry, which serves {@link WORKBENCH_SKILL_CONTENT} when
 *      the model asks for the authoring skill by name.
 *   2. The build prompt, which injects {@link buildSkillDigest} — the same rules
 *      compressed, because a prompt is paid for on every single build.
 *
 * Keeping both in one module means a rule can only be added or removed in one
 * place. The digest is deliberately a hand-written condensation rather than a
 * slice of the full guide: a mechanical truncation would cut sentences in half.
 */

/** Skill name registered with the DSH skill registry (kebab-case, required). */
export const WORKBENCH_SKILL_NAME = 'ai-workbench-authoring'

/** One-line description shown in the skill catalog. */
export const WORKBENCH_SKILL_DESCRIPTION =
  '为 DSH 工作台创作自包含单文件 HTML 窗口：先问后建、主题变量、沙箱约束、动作回传、版式与交互硬要求。'

/** When the model should reach for this skill. */
export const WORKBENCH_SKILL_WHEN =
  '当用户想在工作台里造一个窗口、面板、看板、表单或任何小工具，或要修改一个已有的工作台窗口时，先读这份指南再动手。'

/**
 * The full curated guide, markdown.
 *
 * Written in Chinese because the product's users are Chinese-speaking
 * non-coders and the model mirrors that language into the artifact. English
 * technical terms, identifiers and URLs are kept verbatim so they stay
 * searchable and copy-pasteable.
 */
export const WORKBENCH_SKILL_CONTENT: string = `# 工作台窗口创作指南（ai-workbench-authoring）

你正在 DSH 的「工作台」里工作。用户完全不会写代码，他用一句大白话描述想要的东西，你把它做成一个能在 DSH 界面里打开、能点、能用的**窗口**。

先记住三件事，其余都是细节：

1. **产物是一个自包含单文件 HTML**，被插件挂进 iframe 里运行。没有构建、没有依赖、没有网络。
2. **用户的水平是「不会写代码」**。不要问技术问题，不要让他去找文件、改配置、开终端。
3. **只有你在清单里声明过的动作才会回到你这里**。这条通道很窄也很贵：它是闭环，不是日志。

## 0. 工作流总览

提问确认 → 写 \`index.html\` → 写 \`_workbench.json\` → 自检 → 一两句话交付。

任何一步都不要跳。跳过提问，会做出一个「技术上能跑、但完全不是他要的」窗口；跳过清单，窗口里点了按钮没有任何反应。

## 1. 先问后建（最重要的一条）

需求模糊时**不要直接写代码**。一个猜错的窗口要花三轮才救回来，而问清只要一轮。

### 1.1 提问规则

- **一次问完**，5–7 个问题，编号列出。不要挤牙膏式地一条一条追问。
- **每题都给推荐选项**，让完全不懂的人能直接回答「1A 2B 3A」或者「都按你推荐的」。
- 用大白话。把「数据源」说成「这些内容是你自己填，还是我先生成一些示例」。
- 一个问题只问一件事，别把「给谁用」和「要不要定时」塞进同一条。
- 最多两轮。第二轮只补真正卡住的缺口。
- **提问阶段禁止创建任何文件**：不写 HTML、不写清单、不建目录。用户确认后才动手。

### 1.2 问题模板（按需裁剪，保持 5–7 条）

1. 这个窗口主要给谁用、解决什么问题？推荐：A. 只给自己用，随手记录（推荐）；B. 给团队看，多人会打开；C. 给自己做决策参考，看完就关。
2. 打开它，第一眼最想看到什么？推荐：A. 今天的待办和进度（推荐）；B. 一张总览数字卡；C. 最近的记录列表。
3. 你最常点的按钮是哪两三个？推荐：A. 新增一条、标记完成（推荐）；B. 开始/暂停计时；C. 导出或汇总。
4. 里面的数据从哪来？推荐：A. 我自己手填（推荐）；B. 先放一批示例数据，以后再接；C. 读我电脑上的某个文件；D. 调一个接口自动取。
5. 需要定时或自动化吗？推荐：A. 不需要，我打开时看一眼就行（推荐）；B. 每周自动汇总一次；C. 打开时自动刷新。
6. 界面风格偏哪种？推荐：A. 简洁工具感，信息密度高（推荐）；B. 仪表盘，数字和图表为主；C. 卡片流，一条一条往下排。
7. 有没有必须出现的字段或固定用词？例如「工时」「本周」「客户名」——有的话请直接给我。

### 1.3 问完必须总结确认

问完发一段结构化总结，明确写出你打算怎么做，然后请用户确认。模板：

> 我理解你要的是：
>
> - **用途**：……
> - **主要信息**：……
> - **操作**：……
> - **数据**：……（示例数据 / 手填 / 读文件 / 接口）
> - **自动化**：……
> - **风格**：……
> - **固定用词**：……
>
> 我会做成一个……的窗口，写进项目文件夹。确认没问题我就开始写；有要改的直接说。

用户确认（「可以」「开始吧」「没问题」）之后才开始写文件。用户说「你看着办」「都行」→ 按推荐选项定，仍然发总结，但可以直接开工。

### 1.4 什么时候可以不问

需求已经足够具体时可以直接做，例如「做一个四列的看板：待办、进行中、已完成，每条能拖动」。但只要出现「帮我做个管理 XX 的东西」这种没有信息量的描述，就必须先问。

## 2. 产物契约（硬性）

### 2.1 写到哪里

- \`workbench_window\` 工具返回的 \`folder\`（或面板给出的项目文件夹）是**唯一**允许写产物的位置。
- 默认入口文件名 \`index.html\`；如果项目里已有别的入口（清单里的 \`entry\`），改那个文件，不要另起一个。
- 不要新建子目录，不要写到桌面、文档、系统临时目录。

### 2.2 单文件规则

- 所有 CSS 写进 \`<style>\`，所有 JS 写进 \`<script>\`，不引用任何外部 URL。
- **禁止**：CDN、Google Fonts、外链图片、\`<script src>\`、\`<link rel="stylesheet">\`、\`import\`、\`require\`、任何构建步骤。
- 图片用内联 SVG（首选）或 data URI；单张 base64 不要超过约 100KB。
- 字体用系统字体栈：\`system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif\`，不要引字体文件。
- 页面必须在断网时完全可用：不依赖任何网络请求。

### 2.3 清单 \`_workbench.json\`

和入口文件放在同一个目录，告诉工作台这个窗口叫什么、入口是哪个文件、哪些动作值得回传：

\`\`\`json
{
  "title": "喝水打卡",
  "entry": "index.html",
  "ready": true,
  "actions": [
    { "name": "checkin.create", "label": "打卡", "description": "用户记录了今天的一次喝水" },
    { "name": "goal.change", "label": "改目标", "description": "用户修改了每日目标杯数" }
  ],
  "note": "首次打开带 7 天示例数据"
}
\`\`\`

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| \`title\` | 是 | 窗口标题，中文，短（不超过 12 个字） |
| \`entry\` | 是 | 入口文件，相对项目文件夹的路径，通常就是 \`index.html\` |
| \`ready\` | 是 | 这一版是否可以交付；写到一半写 \`false\` |
| \`actions\` | 是 | 允许回传的动作数组；没有动作也要写 \`[]\` |
| \`note\` | 否 | 一句话说明，窗口没内容时面板会显示它 |

- \`actions[].name\` 是**唯一**会被父框架接受的标识，必须和页面里 \`postMessage\` 的 \`action\` 完全一致（大小写、点号都算）。
- 没写进 \`actions\` 的动作会被父框架**丢弃**，并记一条 warn 日志——页面里点了没反应，就是这里漏了。

### 2.4 更新已有窗口

- 在现有文件上改，不要换文件名、不要推倒重来。
- 保留用户已有的数据结构和已声明的动作，除非用户明确要求删。
- 动作有增减 → 同步改 \`_workbench.json\`，否则新动作照样被丢弃。
- 改完告诉用户「刷新一下就生效」。

### 2.5 体积与结构

- 单文件建议小于 150KB（不含 data URI 图片）。超过就说明你在堆重复代码。
- 用注释分区：\`/* 数据层 */\`、\`/* 渲染 */\`、\`/* 事件 */\`。
- 单个函数保持在 40 行以内；渲染函数只负责渲染，不要在渲染里改状态。

## 3. 主题适配：只用宿主变量

### 3.1 硬规则

- 颜色**只能**来自 DSH 主题变量。不允许写死十六进制作为主色、文字色、边框色。
- 唯一例外是 \`var()\` 的 fallback（见 3.2），而且 fallback 必须存在。
- 原因很实在：窗口要同时适配浅色和深色主题。写死颜色，在另一半主题里就是不可读。

可用变量（真实存在，拼错就等于没有颜色）：

- 背景：\`--dsw-alias-bg-base\`、\`--dsw-alias-bg-layer-1\`、\`--dsw-alias-bg-layer-2\`、\`--dsw-alias-bg-layer-3\`、\`--dsw-alias-bg-overlay\`
- 文字：\`--dsw-alias-label-primary\`、\`--dsw-alias-label-secondary\`、\`--dsw-alias-label-tertiary\`、\`--dsw-alias-label-caption\`、\`--dsw-alias-label-primary-inverted\`
- 边框：\`--dsw-alias-border-l1\`、\`--dsw-alias-border-l2\`、\`--dsw-alias-border-l3\`
- 品牌与链接：\`--dsw-alias-brand-primary\`、\`--dsw-alias-link\`、\`--dsw-alias-button-primary-fill\`
- 状态：\`--dsw-alias-state-success\`、\`--dsw-alias-state-error\`、\`--dsw-alias-state-warn\`（裸名，最稳）；带后缀的 \`--dsw-alias-state-success-primary\`、\`--dsw-alias-state-error-primary\`、\`--dsw-alias-state-warn-primary\` 也存在，用于需要更饱和的强调色时
- 交互：\`--dsw-alias-interactive-bg-hover\`、\`--dsw-alias-interactive-bg-active\`
- 滚动条：\`--dsw-alias-scrollbar-bg-l1\`

不确定时，只用 \`--dsw-alias-brand-primary\` 和 \`--dsw-alias-label-*\`，这两个最稳。

### 3.2 必须写 fallback

窗口也可能以独立标签页弹出（standalone），那时宿主变量不一定存在。所以每个变量都要带 fallback：

\`\`\`css
color: var(--dsw-alias-label-primary, #1f2328);
\`\`\`

fallback 选「浅色主题下可读」的值。它不是设计的一部分，只是兜底。

### 3.3 在页面顶部做一层别名

长变量名用一次就够了，之后全用短别名。这样改主题只改一处：

\`\`\`css
:root {
  --wb-bg: var(--dsw-alias-bg-base, transparent);
  --wb-surface: var(--dsw-alias-bg-layer-1, #ffffff);
  --wb-surface-2: var(--dsw-alias-bg-layer-2, #f6f7f9);
  --wb-text: var(--dsw-alias-label-primary, #1f2328);
  --wb-text-2: var(--dsw-alias-label-secondary, #59636e);
  --wb-text-3: var(--dsw-alias-label-tertiary, #818b98);
  --wb-border: var(--dsw-alias-border-l1, #d8dee4);
  --wb-brand: var(--dsw-alias-brand-primary, #3b6ef5);
  --wb-on-brand: var(--dsw-alias-label-primary-inverted, #ffffff);
  --wb-danger: var(--dsw-alias-state-error, #d1242f);
  --wb-success: var(--dsw-alias-state-success, #1a7f37);
  --wb-warn: var(--dsw-alias-state-warn, #9a6700);
  --wb-radius: 10px;
  --wb-gap: 12px;
}
\`\`\`

### 3.4 背景与深浅色

- \`body\` 背景用 \`transparent\` 或 \`var(--dsw-alias-bg-base, transparent)\`，跟随宿主。
- **不要**自己写 \`@media (prefers-color-scheme: dark)\` 切色。宿主已经切好了，你再切一次就会打架。
- 浮层卡片底色用 \`--dsw-alias-bg-layer-1\`，嵌套区块用 \`-layer-2\`/\`-layer-3\`，浮起层用 \`--dsw-alias-bg-overlay\`。

### 3.5 语义色只表示状态

\`success\`/\`error\`/\`warn\` 只用于状态提示，不用于装饰。不要用品牌色表示成功，也不要用红色当强调色。

## 4. 沙箱约束（最容易踩的坑）

### 4.1 事实

产物跑在 \`sandbox="allow-scripts allow-forms allow-popups"\` 的 iframe 里——**没有** \`allow-same-origin\`，所以它的 origin 是不透明的（opaque origin）。直接后果：

- \`localStorage\` / \`sessionStorage\` / \`indexedDB\` / \`document.cookie\` 的访问会抛 \`SecurityError\`。
- 不能用 \`fetch()\` 读本地文件。
- 不能访问 \`window.parent.document\`，也不能读父页面的任何东西。
- \`location.href\` 只能指向同源相对路径。

### 4.2 正确姿势

- 状态默认放内存：普通变量、\`Map\`、模块级对象。
- 需要跨刷新保留时，把**整段** storage 访问用 \`try/catch\` 包住，失败就静默退回内存。
- **绝不能让这个异常打断主循环**。最坏的形态是：异常发生在动作发送之前，页面看起来完全正常，闭环却永远不通。
- 先探测一次能力，再决定用 storage 还是内存——不要每次读写都靠异常来分支。

可直接抄的 \`safeStore\`（探测一次能力，之后 storage 或内存二选一，任何异常都不外溢）：

\`\`\`js
const safeStore = (() => {
  const memory = new Map()
  let storage = null

  try {
    const probe = '__wb_probe__'
    window.localStorage.setItem(probe, '1')
    window.localStorage.removeItem(probe)
    storage = window.localStorage
  } catch (error) {
    storage = null
  }

  return {
    save(key, value) {
      memory.set(key, value)
      if (storage === null) return
      try {
        storage.setItem(key, JSON.stringify(value))
      } catch (error) {
        storage = null
      }
    },
    load(key, fallback) {
      if (memory.has(key)) return memory.get(key)
      if (storage === null) return fallback
      try {
        const raw = storage.getItem(key)
        const parsed = raw === null ? fallback : JSON.parse(raw)
        memory.set(key, parsed)
        return parsed
      } catch (error) {
        return fallback
      }
    },
  }
})()
\`\`\`

用法：\`safeStore.save('items', items)\`、\`const items = safeStore.load('items', [])\`。storage 不可用时它就是纯内存，代码路径完全一样。

### 4.3 还有几条

- 不用 \`alert\` / \`confirm\` / \`prompt\`。
- 不用 \`document.write\`。
- 不用 \`eval\` / \`new Function\` 处理用户输入。
- 定时器里的异常也要自己兜住：一个抛错的 \`setInterval\` 回调会让整个页面看起来「卡住」。

## 5. 动作回传协议

### 5.1 这条通道为什么窄

每次回传 = 唤醒一次模型 = 消耗上下文和时间。所以只发「模型必须知道才能继续」的事。

| 发 | 不发 |
| --- | --- |
| 新建 / 删除一条记录 | 展开、折叠、切换标签 |
| 状态推进（待办 → 完成） | 翻页、排序、筛选的中间态 |
| 提交一张表单 | 输入框里的每一次按键 |
| 修改目标 / 配置 | 本地校验、悬停、聚焦 |
| 请求生成、汇总、重算 | 纯展示性的动画 |

### 5.2 格式（固定）

\`\`\`js
parent.postMessage(
  { source: 'dsh-ai-workbench', action: 'task.done', data: { id: 3 } },
  '*',
)
\`\`\`

- \`source\` 固定为 \`'dsh-ai-workbench'\`，写错父框架不认。
- \`action\` 必须是 \`_workbench.json\` 里 \`actions[].name\` 声明过的字符串，否则**丢弃**。
- \`data\` 只能是 JSON 可序列化的小对象，**小于 4KB**。带 id 和必要字段，不要塞整张列表或整段 HTML。

### 5.3 命名

\`域.动词\`：\`task.create\`、\`task.toggle\`、\`task.delete\`、\`note.save\`、\`filter.apply\`、\`goal.change\`。全小写、点分隔、不超过 32 个字符。

### 5.4 发送时机与去重

- 在用户**完成**一个动作之后发，不要在 \`input\` 事件里发。
- 同一个动作 500ms 内不要重复发（防连点）。用一个简单的节流标记就够。
- 发完给本地反馈（按钮短暂 loading 或成功态），但不要假设对方一定成功。

### 5.5 回传之后会发生什么

模型会改文件，窗口会被重新加载。所以：

- 关键状态不能只活在页面内存里（刷新就丢）。要么写进 HTML 作为初始数据，要么用 4.2 的 \`safeStore\`。
- 不要在回传后盖一层「请稍等」遮罩——文件改完窗口自己会重载。

## 6. 响应式与版式

### 6.1 尺寸范围

最小 420×280（浮层），最宽到全屏。独立弹出时更宽裕。**两端都要能用**。

### 6.2 窄屏绝不出现横向滚动条

- grid / flex 子项加 \`min-width: 0\`。
- 用 \`minmax(0, 1fr)\`，不要用 \`1fr\`。
- 长单词、长 ID、长 URL：\`overflow-wrap: anywhere\`。
- 表格外面包一层 \`.table-wrap { overflow-x: auto }\`，让表格自己滚，页面不滚。
- 不要给容器写死 \`width: 720px\` 这类绝对值。

### 6.3 响应式写法

窗口宽度由用户拖拽决定，跟视口无关，所以**容器查询优先**，媒体查询兜底：

\`\`\`css
.wb {
  container-type: inline-size;
}

@container (max-width: 560px) {
  .wb-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 720px) {
  .wb-aside {
    display: none;
  }
}
\`\`\`

### 6.4 版式尺度

- 字号：基准 13–14px，标题 18 / 22px，辅助文字 12px。**最多三档**。
- 行高 1.5；长文本限制行宽 \`max-width: 68ch\`。
- 间距用 4 的倍数：4 / 8 / 12 / 16 / 24 / 32。
- 圆角 8–12px，全站统一一档。
- 列表行高至少 40px，方便点。
- 数字列用 \`font-variant-numeric: tabular-nums\`，否则数字跳动很难看。

### 6.5 建议骨架

- 浮层：顶部标题行（标题 + 主操作）→ 内容区（可滚动）→ 底部状态行。
- 独立弹出：可以两栏（主内容 + 侧栏），窄屏自动叠成一列。

## 7. 交互完整性

一个窗口「能看」和「能用」差的就是这一节。

- **空状态**：图标或一句话 + 一个按钮。文案要具体：「还没有记录，点右上角『新增』开始」，不要写「暂无数据」。
- **加载 / 禁用态**：异步操作时按钮 \`disabled\` + \`aria-busy="true"\`，文案变「保存中…」。
- **错误提示**：inline，放在相关控件下方，\`role="alert"\`，用 \`--dsw-alias-state-error\`。**不用** \`alert()\`。
- **删除确认**：行内二次确认（「删除？确认 / 取消」）或 3 秒可撤销。不用 \`confirm()\`。
- **键盘可达**：\`:focus-visible\` 有清晰轮廓；Enter 提交；Esc 取消或关闭；Tab 顺序与视觉顺序一致。
- **表单**：\`<label for>\` 关联输入框，必填项有标记，错误定位到具体字段。
- **示例数据**：真实可读的中文（「整理 Q3 报表」「周三 14:00 评审」），不要 \`foo\` / \`bar\` / \`item1\`。
- **首次打开不能是空白页**：要么带示例数据，要么是完整的空状态。
- **无障碍**：图标按钮必须有 \`aria-label\`；颜色不能是唯一的信息载体（完成项加勾或删除线）。

## 8. 前端设计要点

写具体规则，不写形容词。

- **视觉层次**靠字号 > 字重 > 留白 > 颜色层级 > 边框。能用留白分组的，就不要画框。
- **按钮层级**：一屏只有一个 primary（实心，用 \`--dsw-alias-button-primary-fill\` 或 \`--dsw-alias-brand-primary\`），其余是 secondary（描边）或 ghost（纯文字）。
- **不要**给每张卡片都加阴影 + 圆角 + 描边三件套。用底色差（layer-1 与 layer-2）分组更干净。
- **图标**：内联 SVG，\`stroke="currentColor"\`、\`stroke-width="1.5"\`、\`width/height\` 16–20、\`aria-hidden="true"\`。不要图标字体。
- **动效**：120–180ms，\`cubic-bezier(0.2, 0, 0, 1)\`；并且尊重减少动效偏好：

\`\`\`css
@media (prefers-reduced-motion: reduce) {
  * {
    transition: none !important;
    animation: none !important;
  }
}
\`\`\`

- **输入框**：底色用 \`--dsw-alias-bg-layer-2\`，聚焦时用品牌色描边。可以 \`outline: none\`，但**必须**补一个自定义 focus 样式，否则键盘用户会迷路。
- **表格**：优先用分隔线（\`--dsw-alias-border-l1\`）而不是斑马纹；数字右对齐。
- **密度**：浮层窗口紧凑（12px 间距），独立窗口可以宽松（16–24px）。
- **对比度**：正文和背景至少保持可读，不要用 \`--dsw-alias-label-tertiary\` 写正文。

## 9. 反模式清单

以下每一条都会让窗口在真实使用中出问题：

- ❌ 用 \`alert\` / \`confirm\` / \`prompt\`。
- ❌ 用内联 \`onclick="..."\`——用 \`addEventListener\`，CSP 更友好，也更好维护。
- ❌ 把 JSON 或用户输入直接拼进 \`innerHTML\`（XSS）。要插文本用 \`textContent\`。
- ❌ 一千行写在一个函数里。
- ❌ 交付里留着「示例」「TODO」「待补充」占位符。
- ❌ 让用户自己去找文件、改配置、开终端。
- ❌ 把 HTML 代码贴进对话让用户自己保存。
- ❌ 写死颜色、写死宽度、写死绝对定位坐标。
- ❌ 只画一个静态界面，没有任何增删改。
- ❌ 每个点击都回传动作。

## 10. 优质资源站

- [ui-skills](https://www.ui-skills.com/) — 现代 UI 交互与排版的具体规则合集，找「按钮该多大」「间距怎么定」这类答案最快。
- [anthropics/skills](https://github.com/anthropics/skills) — 官方技能示例，其中的 \`frontend-design\` 技能可以直接对照写法。
- [DSH Desktop 工作台开发规范](https://dshdesktop.com/workbench/docs/development/) — 中文、权威，工作台产物的正式规范。
- [DSH Desktop 工作台六步速览](https://dshdesktop.com/workbench/docs/quickstart/) — 六步跑通一个窗口，先看这个建立整体印象。
- [工作台市场目录](https://market.dshdesktop.com/index.json) — 可直接读的 JSON，看别人做了什么、声明了哪些动作。
- [MDN：容器查询](https://developer.mozilla.org/zh-CN/docs/Web/CSS/CSS_containment/Container_queries) — 窗口宽度自适应就靠它。
- [Building a design system](https://web.dev/articles/building-a-design-system) — 设计系统基础：token、尺度、组件层级。
- [Refactoring UI](https://www.refactoringui.com/) — 视觉层次与配色（付费书，免费文章可读）。
- [Every Layout](https://every-layout.dev/) — 版式原语：侧栏、栅格、堆叠，都能直接抄思路。
- [Inclusive Components](https://inclusive-components.design/) — 无障碍交互组件的实现细节。

## 11. 交付话术

造完窗口后，用一两句话汇报，**不要**把 HTML 贴进对话：

> 好了，窗口叫「喝水打卡」，打开就能看到本周进度，点「打卡」会记录一杯并告诉我。
> 每日目标我先设成 8 杯，你可以在右上角改；如果还想加「连续天数」，跟我说一声。

三件事说清即可：**能做什么 + 怎么用 + 哪些地方还要你补充**。

## 12. 交付前自检清单

- [ ] 只有一个 HTML 文件 + 一个 \`_workbench.json\`，都在项目文件夹里。
- [ ] 没有外链：搜一遍 \`http\`、\`src=\`、\`@import\`，只应出现在注释和清单里。
- [ ] 颜色全部走 \`var(--dsw-alias-*)\`，每个都有 fallback。
- [ ] storage 访问被 try/catch 包住，失败不打断主循环。
- [ ] 页面里发出去的每个 \`action\` 都在清单里声明过。
- [ ] 420px 宽下没有横向滚动条。
- [ ] 有空状态、有加载态、错误是 inline 的。
- [ ] 没有 \`alert\` / \`onclick=\` / \`innerHTML\` 拼数据。
- [ ] 示例数据是真实可读的中文。
- [ ] 清单里 \`ready\` 是 \`true\`。

## 附录 A：起步骨架

复制这段，替换内容即可。它已经把主题别名、内存安全存储和动作回传都写好了：

\`\`\`html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>窗口标题</title>
    <style>
      :root {
        --wb-bg: var(--dsw-alias-bg-base, transparent);
        --wb-surface: var(--dsw-alias-bg-layer-1, #ffffff);
        --wb-surface-2: var(--dsw-alias-bg-layer-2, #f6f7f9);
        --wb-text: var(--dsw-alias-label-primary, #1f2328);
        --wb-text-2: var(--dsw-alias-label-secondary, #59636e);
        --wb-border: var(--dsw-alias-border-l1, #d8dee4);
        --wb-brand: var(--dsw-alias-brand-primary, #3b6ef5);
        --wb-on-brand: var(--dsw-alias-label-primary-inverted, #ffffff);
        --wb-danger: var(--dsw-alias-state-error, #d1242f);
        --wb-radius: 10px;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        background: var(--wb-bg);
        color: var(--wb-text);
        font: 14px/1.5 system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif;
      }
      .wb {
        container-type: inline-size;
        display: flex;
        flex-direction: column;
        gap: 12px;
        min-height: 100vh;
        padding: 16px;
      }
      .wb-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      .wb-title {
        margin: 0;
        font-size: 18px;
        font-weight: 600;
      }
      .wb-btn {
        min-height: 32px;
        padding: 0 12px;
        border: 1px solid var(--wb-border);
        border-radius: 8px;
        background: transparent;
        color: var(--wb-text);
        font: inherit;
        cursor: pointer;
      }
      .wb-btn:focus-visible {
        outline: 2px solid var(--wb-brand);
        outline-offset: 2px;
      }
      .wb-btn--primary {
        border-color: transparent;
        background: var(--wb-brand);
        color: var(--wb-on-brand);
      }
      .wb-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin: 0;
        padding: 0;
        list-style: none;
      }
      .wb-row {
        display: flex;
        align-items: center;
        gap: 12px;
        min-height: 44px;
        padding: 8px 12px;
        border: 1px solid var(--wb-border);
        border-radius: var(--wb-radius);
        background: var(--wb-surface);
      }
      .wb-empty {
        padding: 32px 16px;
        text-align: center;
        color: var(--wb-text-2);
      }
      @container (max-width: 480px) {
        .wb {
          padding: 12px;
        }
      }
    </style>
  </head>
  <body>
    <main class="wb">
      <header class="wb-head">
        <h1 class="wb-title">窗口标题</h1>
        <button class="wb-btn wb-btn--primary" id="add" type="button">新增</button>
      </header>
      <ul class="wb-list" id="list"></ul>
      <p class="wb-empty" id="empty" hidden>还没有记录，点右上角「新增」开始</p>
    </main>
    <script>
      const safeStore = (() => {
        const memory = new Map()
        let storage = null

        try {
          window.localStorage.setItem('__wb_probe__', '1')
          window.localStorage.removeItem('__wb_probe__')
          storage = window.localStorage
        } catch (error) {
          storage = null
        }

        return {
          save(key, value) {
            memory.set(key, value)
            if (storage === null) return
            try {
              storage.setItem(key, JSON.stringify(value))
            } catch (error) {
              storage = null
            }
          },
          load(key, fallback) {
            if (memory.has(key)) return memory.get(key)
            if (storage === null) return fallback
            try {
              const raw = storage.getItem(key)
              const parsed = raw === null ? fallback : JSON.parse(raw)
              memory.set(key, parsed)
              return parsed
            } catch (error) {
              return fallback
            }
          },
        }
      })()

      function postAction(action, data) {
        try {
          parent.postMessage({ source: 'dsh-ai-workbench', action: action, data: data || {} }, '*')
        } catch (error) {
          // 回传失败也不能打断本地交互。
        }
      }

      let items = safeStore.load('items', [])

      function render() {
        const list = document.getElementById('list')
        const empty = document.getElementById('empty')
        list.replaceChildren()
        empty.hidden = items.length > 0
        for (const item of items) {
          const row = document.createElement('li')
          row.className = 'wb-row'
          const text = document.createElement('span')
          text.textContent = item.title
          row.append(text)
          list.append(row)
        }
      }

      document.getElementById('add').addEventListener('click', () => {
        items = items.concat({ id: Date.now(), title: '新的记录' })
        save('items', items)
        render()
        postAction('item.create', { id: items[items.length - 1].id })
      })

      render()
    </script>
  </body>
</html>
\`\`\`
`

/**
 * The condensed guide injected into every build prompt.
 *
 * Hand-written, not truncated: a mechanical slice of the full guide would cut
 * sentences in half and drop the caveat that makes a rule usable. Everything
 * here is a hard constraint the artifact must satisfy on the first try; the
 * "ask first" interview lives in the prompt itself, and the resource list is
 * only worth reading when the model wants depth.
 *
 * Kept under 3500 characters — it is paid for on every single build.
 */
const SKILL_DIGEST = `【工作台产物契约】
1. 在项目文件夹写一个自包含单文件 HTML（默认 index.html），CSS/JS 全部内联；禁止 CDN、外链字体、构建步骤、import；图片用内联 SVG 或 data URI。
2. 同目录写 _workbench.json：{"title":"...","entry":"index.html","ready":true,"actions":[{"name":"task.done","label":"完成","description":"..."}],"note":"..."}
3. 改现有窗口时在现有文件上改，不推倒重来；动作有增减要同步改清单。

【主题变量白名单】只准用这些，且每个都写 fallback（例 var(--dsw-alias-label-primary, #1f2328)）：
--dsw-alias-bg-base|-bg-layer-1|-bg-layer-2|-bg-layer-3|-bg-overlay|-label-primary|-label-secondary|-label-tertiary|-label-caption|-label-primary-inverted|-border-l1|-border-l2|-border-l3|-brand-primary|-state-success|-state-error|-state-warn|-state-success-primary|-state-error-primary|-state-warn-primary|-interactive-bg-hover|-interactive-bg-active|-button-primary-fill|-link|-scrollbar-bg-l1
背景用 transparent 或 --dsw-alias-bg-base；不要写死主色，不要自己用 prefers-color-scheme 切主题。

【沙箱陷阱】
页面跑在 sandbox="allow-scripts allow-forms allow-popups"（没有 allow-same-origin）的 iframe 里，origin 不透明：localStorage/sessionStorage/indexedDB/document.cookie 会抛 SecurityError。整段访问必须 try/catch，失败静默退回内存；绝不能让异常打断主循环或动作发送。不能 fetch 本地文件，不能碰 window.parent.document。

【动作回传】只发关键动作（命名 域.动词，如 task.create、note.save、filter.apply）；普通交互留在本地。
parent.postMessage({ source: 'dsh-ai-workbench', action: 'task.done', data: { id: 3 } }, '*')
action 必须在 _workbench.json 的 actions 里声明过，否则父框架丢弃；data 只能是 JSON 可序列化的小对象（<4KB），带 id 不带整张列表。

【版式与交互硬要求】
- 420px 到全屏都要能用；窄屏绝不出现横向滚动（min-width:0、minmax(0,1fr)、表格包一层 overflow-x:auto）。
- 基准字号 13–14px、行高 1.5、间距 4 的倍数、圆角 8–12px；字号最多三档。
- 必须有空状态、加载/禁用态、inline 错误、删除二次确认、focus-visible、Enter 提交、Esc 取消。
- 一屏只有一个 primary 按钮；数字用 tabular-nums；列表行高 ≥40px；示例数据用真实可读的中文。

【反模式】不许 alert/confirm/prompt；不许内联 onclick；不许把数据直接拼进 innerHTML；不许一个函数上千行；不许留「示例/TODO」占位；不许让用户自己找文件；不许把 HTML 贴进对话。`

/** Resource links worth citing to the user, rendered by the panel's help view. */
export interface WorkbenchResource {
  /** Short human label, used as the link text. */
  readonly title: string
  /** Canonical URL, kept verbatim. */
  readonly url: string
  /** One line on what this source is good for. */
  readonly note: string
}

/**
 * The curated reading list.
 *
 * Rendered by the panel's help view and citable from a build reply. Ordered
 * from "most useful while authoring" to "most useful while polishing"; every
 * entry answers a question the guide itself only summarizes.
 */
export const WORKBENCH_RESOURCES: readonly WorkbenchResource[] = [
  {
    title: 'ui-skills',
    url: 'https://www.ui-skills.com/',
    note: '现代 UI 交互与排版的具体规则合集，查「按钮多大、间距多少」这类问题最快。',
  },
  {
    title: 'anthropics/skills',
    url: 'https://github.com/anthropics/skills',
    note: '官方技能示例，含 frontend-design 技能，可对照它的写法组织页面。',
  },
  {
    title: 'DSH Desktop 工作台开发规范',
    url: 'https://dshdesktop.com/workbench/docs/development/',
    note: '中文、权威，工作台产物的正式规范，与实现冲突时以它为准。',
  },
  {
    title: 'DSH Desktop 工作台六步速览',
    url: 'https://dshdesktop.com/workbench/docs/quickstart/',
    note: '六步跑通一个窗口，用来快速建立整体印象。',
  },
  {
    title: '工作台市场目录',
    url: 'https://market.dshdesktop.com/index.json',
    note: '可直接读取的 JSON 目录，看别人做了什么窗口、声明了哪些动作。',
  },
  {
    title: 'MDN：容器查询',
    url: 'https://developer.mozilla.org/zh-CN/docs/Web/CSS/CSS_containment/Container_queries',
    note: '窗口宽度由拖拽决定，自适应主要靠容器查询，这里是最准的语法参考。',
  },
  {
    title: 'Building a design system',
    url: 'https://web.dev/articles/building-a-design-system',
    note: '设计系统基础：token、尺度、组件层级，解释为什么先定尺度再写样式。',
  },
  {
    title: 'Refactoring UI',
    url: 'https://www.refactoringui.com/',
    note: '视觉层次与配色的系统方法（付费书，免费文章也够用）。',
  },
  {
    title: 'Every Layout',
    url: 'https://every-layout.dev/',
    note: '版式原语：侧栏、栅格、堆叠，思路可以直接搬到单文件里。',
  },
  {
    title: 'Inclusive Components',
    url: 'https://inclusive-components.design/',
    note: '无障碍交互组件的实现细节，空状态、错误提示、键盘操作都能在这里找到做法。',
  },
]

/**
 * The condensed guidance injected into every build prompt.
 *
 * Returns a stable string so the prompt builder can compare or cache it. The
 * text is a hand-written condensation of {@link WORKBENCH_SKILL_CONTENT}: the
 * artifact contract, the theme whitelist, the sandbox trap, the action
 * protocol, the layout and interaction floors, and the anti-pattern list.
 */
export function buildSkillDigest(): string {
  return SKILL_DIGEST
}

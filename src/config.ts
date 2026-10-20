/**
 * The plugin's Config schema.
 *
 * Declaring `Config` is what gives the plugin a settings page: the shell
 * projects this schema into the Plugins page automatically, so there is no
 * `installSection()` call to make (that method does not exist in this
 * generation — the schema IS the section).
 *
 * Every field has a default, so a profile that enables the bundle with no
 * configuration at all still works.
 */
import Schema from '@deepseek-ai/schemastery'

export interface ForgeConfig {
  /** Overrides `$DSH_HOME`. Empty means "resolve it the normal way". */
  dshHome: string
  /** Ledger file name inside the DSH home directory. */
  ledgerFile: string
  /** Register the loopback HTTP routes. Off is useful only for debugging. */
  serveHttp: boolean
  /** Register the `workbench_window` tool the model calls to declare an artifact. */
  registerTool: boolean
  /** Register the built-in authoring skill so the model can read the guide. */
  registerSkill: boolean
  /** Write every action the user triggers into the ledger journal. */
  journalActions: boolean
  /** How many journal lines to keep. */
  maxJournalEntries: number
  /** Forward declared artifact actions into the bound session. */
  forwardActionsToSession: boolean
  /** Refuse to create more than this many projects. */
  maxProjects: number
  /** Refuse to create more than this many windows in one project. */
  maxWindowsPerProject: number
  /** Default project name offered by the panel's first-run state. */
  defaultProjectName: string
  /**
   * Ask the user the interview questions before building.
   *
   * On by default because the product is aimed at people who cannot describe a
   * program precisely: a two-step "ask, then confirm, then build" flow produces
   * a far better artifact than guessing. Turning it off makes every request go
   * straight to the build prompt.
   */
  interviewFirst: boolean
  /** Open the chat pane beside a new window. */
  chatPane: boolean
  /** Root URL of the dsh-desktop workbench market index. */
  marketUrl: string
  /**
   * Prefix proxy tried when a direct GitHub download fails.
   *
   * GitHub release assets and codeload are routinely unreachable from mainland
   * China while npm and the market catalog load fine, so without a fallback the
   * market would list sixteen workbenches and install none of them. The prefix is
   * only a transport: the catalog's published SHA-256 still verifies the bytes, so
   * a proxy cannot substitute content. Empty disables the fallback.
   */
  marketProxy: string
}

export const Config: Schema<ForgeConfig> = Schema.object({
  dshHome: Schema.string()
    .default('')
    .description('Override the DSH home directory (empty = resolve from $DSH_HOME, then ~/.dsh).'),
  ledgerFile: Schema.string()
    .default('dsh-ai-workbench.json')
    .description('Ledger file name inside the DSH home directory.'),
  serveHttp: Schema.boolean()
    .default(true)
    .description('Serve the loopback HTTP API and the artifact host.'),
  registerTool: Schema.boolean()
    .default(true)
    .description('Register the workbench_window tool so the model can declare a window.'),
  registerSkill: Schema.boolean()
    .default(true)
    .description('Register the built-in workbench authoring skill for the model.'),
  journalActions: Schema.boolean()
    .default(true)
    .description('Record every artifact action in the ledger journal.'),
  maxJournalEntries: Schema.number()
    .default(200)
    .min(0)
    .max(2000)
    .step(1)
    .description('Journal lines to keep before the oldest are dropped.'),
  forwardActionsToSession: Schema.boolean()
    .default(true)
    .description('Send declared artifact actions into the session bound to the project.'),
  maxProjects: Schema.number()
    .default(20)
    .min(1)
    .max(200)
    .step(1)
    .description('Upper bound on projects in the ledger.'),
  maxWindowsPerProject: Schema.number()
    .default(12)
    .min(1)
    .max(100)
    .step(1)
    .description('Upper bound on windows inside one project.'),
  defaultProjectName: Schema.string()
    .default('工作台项目')
    .description('Name offered for a project created without one.'),
  interviewFirst: Schema.boolean()
    .default(true)
    .description('Ask the user clarifying questions and confirm a summary before building.'),
  chatPane: Schema.boolean()
    .default(true)
    .description('Open a chat pane beside a window so the user can talk about it.'),
  marketUrl: Schema.string()
    .default('https://market.dshdesktop.com/index.json')
    .description('dsh-desktop workbench market index to list in the panel.'),
  marketProxy: Schema.string()
    .default('https://gh-proxy.com')
    .description(
      'Prefix proxy retried when a direct GitHub download fails (empty disables it). ' +
        'The catalog SHA-256 still verifies the bytes.',
    ),
})

/**
 * Fill in defaults for a partially-specified config.
 *
 * The shell normally hands `apply()` a fully-resolved object, but the plugin is
 * also mounted directly in tests and in a hand-written profile, where `config`
 * can be `undefined`.
 */
export function normalizeConfig(input: Partial<ForgeConfig> | undefined): ForgeConfig {
  const merged = { ...(input ?? {}) }
  return {
    dshHome: typeof merged.dshHome === 'string' ? merged.dshHome : '',
    ledgerFile:
      typeof merged.ledgerFile === 'string' && merged.ledgerFile.length > 0
        ? merged.ledgerFile
        : 'dsh-ai-workbench.json',
    serveHttp: merged.serveHttp !== false,
    registerTool: merged.registerTool !== false,
    registerSkill: merged.registerSkill !== false,
    journalActions: merged.journalActions !== false,
    maxJournalEntries: clampInt(merged.maxJournalEntries, 200, 0, 2000),
    forwardActionsToSession: merged.forwardActionsToSession !== false,
    maxProjects: clampInt(merged.maxProjects, 20, 1, 200),
    maxWindowsPerProject: clampInt(merged.maxWindowsPerProject, 12, 1, 100),
    defaultProjectName:
      typeof merged.defaultProjectName === 'string' && merged.defaultProjectName.length > 0
        ? merged.defaultProjectName
        : '工作台项目',
    interviewFirst: merged.interviewFirst !== false,
    chatPane: merged.chatPane !== false,
    marketUrl:
      typeof merged.marketUrl === 'string' && merged.marketUrl.trim().length > 0
        ? merged.marketUrl.trim()
        : 'https://market.dshdesktop.com/index.json',
    // An empty string is a real value here — it means "never fall back to a proxy",
    // which is what a user behind a healthy network or a private mirror wants.
    marketProxy:
      typeof merged.marketProxy === 'string' ? merged.marketProxy.trim().replace(/\/+$/, '') : DEFAULT_MARKET_PROXY,
  }
}

/** Prefix proxy that serves GitHub release assets on networks where they time out. */
export const DEFAULT_MARKET_PROXY = 'https://gh-proxy.com'

/** Coerce a number to an integer inside `[min, max]`, falling back on nonsense. */
export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, Math.round(numeric)))
}

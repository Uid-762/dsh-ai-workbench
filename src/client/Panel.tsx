/**
 * The central panel: the one input, the projects it created, and the windows
 * those projects produced.
 *
 * This is the whole authoring surface. A user who cannot read code types a
 * sentence here; everything else on this screen is feedback about what happened
 * to that sentence.
 *
 * The shape of the page follows from that: the composer is the *first* thing in
 * the body and the heaviest object on it, because it is the product's front
 * door. The lists below it are reference material — you look at them after you
 * have asked for something, not before. An earlier revision hid the composer
 * behind a modal "create" wizard, which read as a form to fill in rather than a
 * thing to say; the modal is gone and the input is always on screen.
 *
 * The flow has three stages and they are the store's, not this component's:
 * `describe` (one sentence), `intake` (the interview form, skipped when the Host
 * turns it off), `build` (the request is in flight). Keeping the stage in the
 * store means an SSE frame arriving mid-form cannot reset what the user typed.
 */

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type ReactElement } from 'react'
import type { WindowLayout } from '../protocol.ts'
import { ForgeIntake } from './Intake.tsx'
import { ForgeMarket } from './Market.tsx'
import { useLocale, type MessageKey } from './messages.ts'
import { statusLabel, type ForgeStore } from './store.ts'
import { useForge } from './use-store.ts'
import styles from './styles.module.css'

export interface ForgePanelProps {
  store: ForgeStore
}

/**
 * The layout chips, in prompt order. `auto` first: it is the default.
 *
 * Written out rather than derived from the ids — `grid-2x2` maps to
 * `layoutGrid`, not `layoutGrid2x2`, and a derivation that is right six times
 * and wrong once is worse than a table a reader can check at a glance.
 */
const LAYOUT_CHIPS: readonly { id: WindowLayout; labelKey: MessageKey; descKey: MessageKey }[] = [
  { id: 'auto', labelKey: 'layoutAuto', descKey: 'layoutDesc_auto' },
  { id: 'single', labelKey: 'layoutSingle', descKey: 'layoutDesc_single' },
  { id: 'two-col', labelKey: 'layoutTwoCol', descKey: 'layoutDesc_twoCol' },
  { id: 'three-col', labelKey: 'layoutThreeCol', descKey: 'layoutDesc_threeCol' },
  { id: 'grid-2x2', labelKey: 'layoutGrid', descKey: 'layoutDesc_grid2x2' },
  { id: 'top-one', labelKey: 'layoutTopOne', descKey: 'layoutDesc_topOne' },
  { id: 'dashboard', labelKey: 'layoutDashboard', descKey: 'layoutDesc_dashboard' },
]

/** The two placement choices; keys named after the ids on purpose. */
const PLACEMENT_CHIPS: readonly {
  id: 'embedded' | 'standalone'
  labelKey: MessageKey
  descKey: MessageKey
}[] = [
  { id: 'embedded', labelKey: 'placementEmbedded', descKey: 'placementEmbeddedHint' },
  { id: 'standalone', labelKey: 'placementStandalone', descKey: 'placementStandaloneHint' },
]

/**
 * Miniature pane arrangements, one per layout preset.
 *
 * Each entry is a row of pane units; CSS turns them into little bars.
 * Proportions mirror the presets the prompt describes, so the thumbnail is a
 * promise, not decoration: `top-one` really is one tall pane over two short
 * ones, `dashboard` really is the uneven mosaic.
 */
const LAYOUT_THUMBS: Record<WindowLayout, readonly number[]> = {
  auto: [2, 2],
  single: [6],
  'two-col': [3, 3],
  'three-col': [2, 2, 2],
  'grid-2x2': [3, 3, 3, 3],
  'top-one': [4, 1, 1],
  dashboard: [3, 2, 2, 3, 2],
}

/** Format a timestamp as `hh:mm:ss`, which is all a log line needs. */
function clock(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** The status → badge class map, spelled out so the union stays exhaustively checked. */
function badgeClass(status: 'draft' | 'building' | 'ready' | 'error'): string {
  if (status === 'ready') return styles.badgeReady
  if (status === 'building') return styles.badgeBuilding
  if (status === 'error') return styles.badgeError
  return ''
}

export function ForgePanel(props: ForgePanelProps): ReactElement {
  const { store } = props
  const state = useForge(store)
  const t = useLocale()
  const [nameDraft, setNameDraft] = useState('')
  const [creating, setCreating] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | undefined>(undefined)
  const activityRef = useRef<HTMLDivElement | null>(null)
  const stickRef = useRef(true)
  const fileRef = useRef<HTMLInputElement | null>(null)

  const project = store.project
  const windows = store.windows
  const interviewing = state.stage === 'intake' && state.features.interviewFirst

  // Keep the activity list pinned to the bottom unless the user scrolled away.
  // Auto-scrolling unconditionally is what makes a log unusable the moment the
  // user scrolls back to read something.
  useEffect(() => {
    const element = activityRef.current
    if (element === null || !stickRef.current) return
    element.scrollTop = element.scrollHeight
  }, [state.activity])

  function onActivityScroll(): void {
    const element = activityRef.current
    if (element === null) return
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    stickRef.current = distance < 24
  }

  /**
   * Submit from the composer.
   *
   * When the interview is enabled this opens the form instead of sending: the
   * form's own confirm button is what calls `submitRequest`. Sending first and
   * asking afterwards would build a page the user then has to throw away.
   */
  function submit(event: FormEvent): void {
    event.preventDefault()
    if (state.draft.trim().length === 0) {
      void store.submitRequest(state.draft)
      return
    }
    if (state.features.interviewFirst) {
      store.setStage('intake')
      return
    }
    void store.submitRequest(state.draft)
  }

  function confirmIntake(): void {
    void store.submitRequest(state.draft)
  }

  function createProject(event: FormEvent): void {
    event.preventDefault()
    const name = nameDraft.trim()
    if (name.length === 0) return
    void store.createProject(name).then((created) => {
      if (created !== undefined) {
        setNameDraft('')
        // The next project starts from the default again, not from the last
        // one's edited folder.
        store.setNewProjectFolder(state.projectsRoot)
        setCreating(false)
      }
    })
  }

  /**
   * Folder browse. The renderer has no native "pick a folder and hand back the
   * path" dialog, and `showDirectoryPicker` returns a handle without a path —
   * so the honest control is a text field the user can paste into, with a
   * cancel-able confirm. The field is pre-filled with the Host's projects root.
   */
  function onFolderInput(event: ChangeEvent<HTMLInputElement>): void {
    store.setNewProjectFolder(event.target.value)
  }

  function pickBundle(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0]
    // Reset first: picking the same file twice in a row fires no change event
    // while the input still holds the previous selection.
    event.target.value = ''
    if (file === undefined) return
    void store.importFromFile(file)
  }

  function openWindow(windowId: string): void {
    void store.updateWindow(windowId, {
      open: true,
      minimized: false,
      z: Math.max(...state.ledger.windows.map((row) => row.z), 0) + 1,
    })
  }

  return (
    <div className={styles.panel}>
      <header className={styles.panelHeader}>
        <span className={styles.brandMark} aria-hidden="true" />
        <span className={styles.brandText}>
          <h1 className={styles.panelTitle}>{t('title')}</h1>
          <span className={styles.panelHint}>{t('panelHint')}</span>
        </span>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.iconButton}
            data-on={creating ? 'true' : 'false'}
            title={t('newProject')}
            aria-label={t('newProject')}
            onClick={() => setCreating((current) => !current)}
          >
            ＋
          </button>
          <button
            type="button"
            className={styles.iconButton}
            title={t('importHint')}
            aria-label={t('import')}
            onClick={() => fileRef.current?.click()}
          >
            ⤓
          </button>
          <input
            ref={fileRef}
            className={styles.hiddenInput}
            type="file"
            accept=".json,application/json"
            onChange={pickBundle}
          />
        </div>
      </header>

      <div className={styles.panelBody}>
        {state.toast !== undefined ? <div className={styles.toast}>{state.toast}</div> : null}

        {/* ------------------------------------------------- the composer -- */}
        {interviewing ? (
          <ForgeIntake store={store} onConfirm={confirmIntake} />
        ) : (
          <form className={styles.composer} onSubmit={submit}>
            <div className={styles.composerTop}>
              <span className={styles.composerLabel}>{t('requestTitle')}</span>
              <span className={styles.composerHint}>{t('layoutHint')}</span>
            </div>
            <textarea
              className={styles.textarea}
              value={state.draft}
              placeholder={t('requestPlaceholder')}
              onChange={(event) => store.setDraft(event.target.value)}
              onKeyDown={(event) => {
                // Enter submits, Shift+Enter makes a newline. A single-sentence
                // request is the common case and should not need a mouse.
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  submit(event)
                }
              }}
              spellCheck={false}
            />
            <div className={styles.chipRow} role="group" aria-label={t('layout')}>
              <span className={styles.chipLabel}>{t('layout')}</span>
              {LAYOUT_CHIPS.map((chip) => {
                const slug = chip.id.replace(/[^a-z0-9]/gi, '_')
                const active = state.layout === chip.id
                return (
                  <button
                    key={chip.id}
                    type="button"
                    className={`${styles.layoutChip} ${active ? styles.layoutChipActive : ''}`}
                    aria-pressed={active}
                    title={chip.id === 'auto' ? t('layoutHint') : t(chip.descKey)}
                    onClick={() => store.setLayout(chip.id)}
                  >
                    <span
                      className={`${styles.layoutThumb} ${
                        styles[`layoutThumb_${slug}` as keyof typeof styles] ?? ''
                      }`}
                      aria-hidden="true"
                    >
                      {LAYOUT_THUMBS[chip.id].map((units, index) => (
                        <span key={index} className={styles.layoutThumbPane} data-units={units} />
                      ))}
                    </span>
                    <span className={styles.layoutChipLabel}>{t(chip.labelKey)}</span>
                  </button>
                )
              })}
            </div>
            <div className={styles.composerFoot}>
              <div className={styles.chipRow} role="group" aria-label={t('placement')}>
                <span className={styles.chipLabel}>{t('placement')}</span>
                {PLACEMENT_CHIPS.map((chip) => (
                  <button
                    key={chip.id}
                    type="button"
                    className={`${styles.chip} ${state.placement === chip.id ? styles.chipActive : ''}`}
                    aria-pressed={state.placement === chip.id}
                    title={t(chip.descKey)}
                    onClick={() => store.setPlacement(chip.id)}
                  >
                    {t(chip.labelKey)}
                  </button>
                ))}
              </div>
              <span className={styles.composerFootSpacer} />
              <button className={styles.button} type="submit" disabled={state.sending}>
                {state.sending ? t('submitting') : t('submit')}
              </button>
            </div>
          </form>
        )}

        {/* ------------------------------------------------- the projects -- */}
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <span className={styles.sectionTitle}>{t('projects')}</span>
            <span className={styles.sectionCount}>{state.ledger.projects.length}</span>
            <span className={styles.sectionAction}>
              <button
                className={styles.buttonGhost}
                type="button"
                title={t('exportHint')}
                disabled={project === undefined}
                onClick={() => {
                  if (project !== undefined) void store.exportProject(project.id)
                }}
              >
                {t('export')}
              </button>
            </span>
          </div>

          {creating ? (
            <form className={styles.sectionBody} onSubmit={createProject}>
              <div className={styles.row}>
                <input
                  className={styles.input}
                  value={nameDraft}
                  placeholder={t('projectNamePlaceholder')}
                  onChange={(event) => setNameDraft(event.target.value)}
                  autoFocus
                />
                <button className={styles.button} type="submit">
                  {t('create')}
                </button>
                <button
                  className={styles.buttonGhost}
                  type="button"
                  onClick={() => setCreating(false)}
                >
                  {t('cancel')}
                </button>
              </div>
              <div className={styles.folderRow}>
                <label htmlFor="wf-folder">{t('folder')}</label>
                <input
                  id="wf-folder"
                  className={styles.input}
                  value={state.newProjectFolder}
                  placeholder={state.projectsRoot}
                  onChange={onFolderInput}
                  spellCheck={false}
                />
                <span className={styles.folderHint}>{t('folderHint')}</span>
              </div>
            </form>
          ) : null}

          {state.ledger.projects.length === 0 ? (
            <div className={styles.empty}>{t('noProjects')}</div>
          ) : (
            <div className={styles.projectList}>
              {state.ledger.projects.map((candidate) => {
                const count = state.ledger.windows.filter(
                  (window) => window.projectId === candidate.id,
                ).length
                const active = project?.id === candidate.id
                const confirming = confirmDelete === candidate.id
                return (
                  <div
                    key={candidate.id}
                    className={`${styles.projectItem} ${active ? styles.projectItemActive : ''}`}
                  >
                    <button
                      type="button"
                      className={styles.projectMain}
                      onClick={() => store.selectProject(candidate.id)}
                      title={candidate.folder}
                    >
                      <span className={styles.projectName}>{candidate.name}</span>
                      <span className={styles.projectMeta}>{count}</span>
                    </button>
                    {confirming ? (
                      <span className={styles.confirmRow}>
                        <button
                          className={`${styles.buttonGhost} ${styles.buttonDanger}`}
                          type="button"
                          onClick={() => {
                            setConfirmDelete(undefined)
                            void store.deleteProject(candidate.id)
                          }}
                        >
                          {t('confirmDelete')}
                        </button>
                        <button
                          className={styles.buttonGhost}
                          type="button"
                          onClick={() => setConfirmDelete(undefined)}
                        >
                          {t('cancel')}
                        </button>
                      </span>
                    ) : (
                      <button
                        className={`${styles.buttonGhost} ${styles.buttonDanger} ${styles.projectDelete}`}
                        type="button"
                        title={t('deleteProjectHint')}
                        aria-label={t('deleteProjectHint')}
                        onClick={() => setConfirmDelete(candidate.id)}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </section>

        {/* -------------------------------------------------- the windows -- */}
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <span className={styles.sectionTitle}>{t('windows')}</span>
            <span className={styles.sectionCount}>{windows.length}</span>
          </div>
          {windows.length === 0 ? (
            <div className={styles.empty}>{t('noWindows')}</div>
          ) : (
            <div className={styles.windowList}>
              {windows.map((window) => (
                <div key={window.id} className={styles.windowCard}>
                  <div className={styles.windowCardMain}>
                    <span className={styles.windowTitle}>{window.title}</span>
                    <span className={styles.windowSub} title={window.entry}>
                      {window.entry}
                    </span>
                    {window.actions.length > 0 ? (
                      <div className={styles.actionList} title={t('actionsHint')}>
                        <span className={styles.actionListLabel}>{t('actions')}</span>
                        {window.actions.map((action) => (
                          <span key={action.name} className={styles.actionChip} title={action.description}>
                            {action.label ?? action.name}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <div className={styles.actionList} title={t('actionsHint')}>
                        <span className={styles.actionListLabel}>{t('noActions')}</span>
                      </div>
                    )}
                  </div>
                  <div className={styles.windowActions}>
                    <span className={`${styles.badge} ${badgeClass(window.status)}`}>
                      {statusLabel(window.status)}
                    </span>
                    <button
                      className={styles.buttonGhost}
                      type="button"
                      onClick={() => openWindow(window.id)}
                    >
                      {t('open')}
                    </button>
                    <button
                      className={`${styles.buttonGhost} ${
                        state.chatWindowId === window.id ? styles.chipActive : ''
                      }`}
                      type="button"
                      title={t('chatHint')}
                      onClick={() => store.toggleChat(window.id)}
                    >
                      {t('chat')}
                    </button>
                    <button
                      className={styles.buttonGhost}
                      type="button"
                      title={t('popout')}
                      aria-label={t('popout')}
                      disabled={window.status !== 'ready'}
                      onClick={() => store.popout(window.id)}
                    >
                      ⧉
                    </button>
                    <button
                      className={`${styles.buttonGhost} ${styles.buttonDanger}`}
                      type="button"
                      title={t('removeWindow')}
                      onClick={() => void store.deleteWindow(window.id)}
                    >
                      {t('remove')}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* --------------------------------------------------- the market -- */}
        <ForgeMarket store={store} />

        {/* ------------------------------------------------- the activity -- */}
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <span className={styles.sectionTitle}>{t('log')}</span>
            <span className={styles.sectionCount}>{state.activity.length}</span>
            <span className={styles.sectionAction}>
              <button
                className={styles.buttonGhost}
                type="button"
                onClick={() => store.clearActivity()}
              >
                {t('clearLog')}
              </button>
            </span>
          </div>
          {state.activity.length === 0 ? (
            <div className={styles.empty}>{t('noLog')}</div>
          ) : (
            <div className={styles.activity} ref={activityRef} onScroll={onActivityScroll}>
              {state.activity.map((line) => (
                <div
                  key={line.id}
                  className={`${styles.activityLine} ${
                    line.level === 'action'
                      ? styles.activityAction
                      : line.level === 'success'
                        ? styles.activitySuccess
                        : line.level === 'warn'
                          ? styles.activityWarn
                          : line.level === 'error'
                            ? styles.activityError
                            : ''
                  }`}
                >
                  <span className={styles.activityTime}>{clock(line.at)}</span>
                  <span>{line.text}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <footer className={styles.panelFooter}>
        <span
          className={`${styles.statusDot} ${
            state.connected ? styles.statusDotLive : styles.statusDotDown
          }`}
        />
        <span className={styles.statusText}>
          {project?.sessionId === undefined ? t('sessionNone') : t('sessionReused')}
        </span>
        <span className={styles.footerMeta}>
          {state.emitted} / {state.delivered}
        </span>
      </footer>
    </div>
  )
}

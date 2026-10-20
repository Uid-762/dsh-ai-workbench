/**
 * The chat pane: a conversation about one workbench.
 *
 * The point of this pane is not "chat" in general — the shell already has a
 * conversation column. It is that the model answering here is told *which
 * workbench* the user is looking at: its files, its declared actions, its
 * layout, and what has happened in it recently. Without that preamble the model
 * has no way to know, because the pane's messages arrive in a session whose
 * transcript does not contain the artifact.
 *
 * The transcript lives in the Host ledger, not in this component, so it survives
 * the window closing and the App reloading. Model replies are pulled from the
 * session transcript by the Host (`GET /chat/:projectId`), which is idempotent.
 */

import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react'
import type { ForgeChatLine } from '../protocol.ts'
import { useLocale } from './messages.ts'
import type { ForgeStore } from './store.ts'
import { useForge } from './use-store.ts'
import styles from './styles.module.css'

export interface ForgeChatProps {
  store: ForgeStore
  projectId: string
  /** Called when the user wants the real session column opened. */
  onOpenSession?: () => void
}

function clock(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function ForgeChat(props: ForgeChatProps): ReactElement {
  const { store, projectId, onOpenSession } = props
  const state = useForge(store)
  const t = useLocale()
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const logRef = useRef<HTMLDivElement | null>(null)
  const stickRef = useRef(true)

  const lines: ForgeChatLine[] = store.chatOf(projectId)
  const project = state.ledger.projects.find((candidate) => candidate.id === projectId)
  const hasSession = project?.sessionId !== undefined
  const enabled = state.features.chatPane

  // Pull replies once when the pane opens. The Host reads the session
  // transcript, appends anything new, and pushes the lines over SSE; polling
  // here would duplicate that.
  useEffect(() => {
    if (!enabled || !hasSession) return
    void store.refreshChat(projectId)
  }, [store, projectId, enabled, hasSession])

  useEffect(() => {
    const element = logRef.current
    if (element === null || !stickRef.current) return
    element.scrollTop = element.scrollHeight
  }, [lines.length])

  function onScroll(): void {
    const element = logRef.current
    if (element === null) return
    stickRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    const text = draft.trim()
    if (text.length === 0 || busy) return
    setBusy(true)
    try {
      await store.sendChat(projectId, text)
      setDraft('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside className={styles.chatPane} aria-label={t('chatTitle')}>
      <header className={styles.chatHead}>
        <span className={styles.chatHeadTitle} title={t('chatHint')}>
          {t('chatTitle')}
        </span>
        <button
          type="button"
          className={styles.buttonGhost}
          title={t('chatRefresh')}
          disabled={!hasSession}
          onClick={() => void store.refreshChat(projectId)}
        >
          ⟳
        </button>
        <button
          type="button"
          className={styles.buttonGhost}
          title={t('chatClear')}
          onClick={() => void store.clearChat(projectId)}
        >
          {t('chatClear')}
        </button>
      </header>

      <div className={styles.chatLog} ref={logRef} onScroll={onScroll}>
        {!enabled ? <div className={styles.chatWarn}>{t('chatDisabled')}</div> : null}
        {enabled && !hasSession ? (
          <div className={styles.chatWarn}>{t('chatNoSession')}</div>
        ) : null}
        {lines.length === 0 ? (
          <div className={styles.chatEmpty}>{t('chatEmpty')}</div>
        ) : (
          lines.map((line) => (
            <div
              key={line.id}
              className={`${styles.chatLine} ${
                line.role === 'user' ? styles.chatLineUser : styles.chatLineModel
              }`}
            >
              <span className={styles.chatRole}>
                {line.role === 'user' ? 'you' : line.role === 'model' ? 'model' : 'system'} ·{' '}
                {clock(line.at)}
              </span>
              {line.context !== undefined && line.context.length > 0 ? (
                <details className={styles.chatContext}>
                  <summary>{t('chatContext')}</summary>
                  <div className={styles.chatContextBody}>{line.context}</div>
                </details>
              ) : null}
              <div className={styles.chatBubble}>{line.text}</div>
            </div>
          ))
        )}
      </div>

      <form className={styles.chatComposer} onSubmit={(event) => void submit(event)}>
        <textarea
          className={styles.chatTextarea}
          value={draft}
          placeholder={t('chatPlaceholder')}
          disabled={!enabled}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void submit(event)
            }
          }}
          spellCheck={false}
        />
        <div className={styles.chatComposerRow}>
          <button className={styles.button} type="submit" disabled={!enabled || busy}>
            {t('chatSend')}
          </button>
          {onOpenSession !== undefined && hasSession ? (
            <button className={styles.buttonGhost} type="button" onClick={onOpenSession}>
              {t('chatOpenSession')}
            </button>
          ) : null}
          <span className={styles.chatHint}>{t('chatHint')}</span>
        </div>
      </form>
    </aside>
  )
}

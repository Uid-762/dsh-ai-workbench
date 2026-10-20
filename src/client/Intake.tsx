/**
 * The interview, as a form.
 *
 * Shown before anything is built. Every question is answerable by someone who
 * has never written code, and every answer narrows what the model is allowed to
 * invent. The reason this is a form in the panel rather than a conversation with
 * the model: it works before a session exists, it asks the same questions every
 * time, and it can be answered by clicking rather than by composing a reply.
 *
 * Answers are keyed by question id and stored on the store, not in local state,
 * so a re-render (an SSE frame, a language switch) does not lose typing.
 */

import { useMemo, type ReactElement } from 'react'
import { useLocale } from './messages.ts'
import type { ForgeStore } from './store.ts'
import { useForge } from './use-store.ts'
import styles from './styles.module.css'

export interface ForgeIntakeProps {
  store: ForgeStore
  /** Called when the user confirms; the panel turns this into a build request. */
  onConfirm: () => void
}

/**
 * Turn the answers into the requirement sentence the build prompt leads with.
 *
 * The one-line description is still the spine of the request — the answers are
 * appended as a separate block so the model can tell "what the user asked for"
 * from "what they confirmed". This sentence exists so the project has a name and
 * so the prompt has a subject even when the description was terse.
 */
function summarize(answers: Readonly<Record<string, string>>): string {
  const purpose = (answers['purpose'] ?? '').trim()
  const content = (answers['content'] ?? '').trim()
  if (purpose.length > 0) return purpose
  if (content.length > 0) return `一个${content}的小工具`
  return ''
}

export function ForgeIntake(props: ForgeIntakeProps): ReactElement {
  const { store, onConfirm } = props
  const state = useForge(store)
  const t = useLocale()
  const questions = useMemo(() => store.intakeQuestions, [store])
  const answered = Object.keys(state.answers).length

  function toggleOption(questionId: string, option: string, multiple: boolean): void {
    const current = (state.answers[questionId] ?? '').trim()
    if (!multiple) {
      // Clicking the selected chip again clears it: an answer the user cannot
      // take back is worse than a required field, because the interview is
      // optional all the way through.
      store.setAnswer(questionId, current === option ? '' : option)
      return
    }
    const parts = current
      .split('、')
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
    const next = parts.includes(option)
      ? parts.filter((part) => part !== option)
      : [...parts, option]
    store.setAnswer(questionId, next.join('、'))
  }

  function isChosen(questionId: string, option: string): boolean {
    const current = state.answers[questionId] ?? ''
    if (!current.includes(option)) return false
    return current
      .split('、')
      .map((part) => part.trim())
      .includes(option)
  }

  return (
    <div className={styles.intake}>
      <div className={styles.intakeHead}>
        <span className={styles.intakeTitle}>{t('intakeTitle')}</span>
        <span className={styles.intakeHint}>{t('intakeHint')}</span>
      </div>

      <div className={styles.intakeList}>
        {questions.map((question) => (
          <div key={question.id} className={styles.intakeQuestion}>
            <label className={styles.intakeLabel} htmlFor={`intake-${question.id}`}>
              {question.label}{' '}
              {question.options === undefined ? (
                <span className={styles.intakeLabelMeta}>({t('intakeOptional')})</span>
              ) : question.multiple === true ? (
                <span className={styles.intakeLabelMeta}>({t('intakeChooseMany')})</span>
              ) : null}
            </label>
            {question.hint !== undefined ? (
              <span className={styles.intakeQuestionHint}>{question.hint}</span>
            ) : null}
            {question.options !== undefined ? (
              <div className={styles.chipRow} role="group" aria-label={question.label}>
                {question.options.map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={`${styles.chip} ${
                      isChosen(question.id, option) ? styles.chipActive : ''
                    }`}
                    aria-pressed={isChosen(question.id, option)}
                    onClick={() => toggleOption(question.id, option, question.multiple === true)}
                  >
                    {option}
                  </button>
                ))}
              </div>
            ) : null}
            <textarea
              id={`intake-${question.id}`}
              className={styles.intakeInput}
              value={state.answers[question.id] ?? ''}
              rows={question.id === 'purpose' ? 2 : 1}
              placeholder={question.hint ?? ''}
              onChange={(event) => store.setAnswer(question.id, event.target.value)}
              spellCheck={false}
            />
          </div>
        ))}
      </div>

      {answered === 0 ? (
        <div className={styles.intakeSummary}>
          <span className={styles.intakeSummaryLine}>{t('intakeNothingAnswered')}</span>
        </div>
      ) : null}

      <div className={styles.intakeActions}>
        <button className={styles.button} type="button" onClick={onConfirm}>
          {t('intakeConfirm')}
        </button>
        <button className={styles.buttonGhost} type="button" onClick={() => store.resetIntake()}>
          {t('intakeRestart')}
        </button>
        <button
          className={styles.buttonGhost}
          type="button"
          onClick={() => {
            // Build from the sentence alone. The store notices that no answer
            // was given and asks the model to interview first, so this cannot
            // silently produce a page built on guesses.
            store.resetIntake()
            void store.submitRequest(store.state.draft)
          }}
        >
          {t('intakeSkip')}
        </button>
      </div>
    </div>
  )
}

/** The sentence the intake produces, exposed so the panel can show it. */
export { summarize as summarizeIntake }

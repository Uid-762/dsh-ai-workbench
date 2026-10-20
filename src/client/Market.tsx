/**
 * The market list.
 *
 * The catalog is the dsh-desktop workbench index (`market.dshdesktop.com`), and
 * the honest thing to say about it here is that entries are *installable but not
 * natively runnable*: this DSH build ships no `desktopWorkbenches` service, so a
 * dsh-desktop workbench's React panel cannot be mounted. What installing one
 * does is download the package, extract its entry page into a project folder, and
 * open it in a window — and because the descriptor page carries a working
 * "let the AI build it" button, an installed entry is one click away from a real
 * static workbench.
 *
 * The list is deliberately a compact stack of rows rather than a grid of
 * poster cards. A poster grid of a few dozen entries grew the panel to four
 * thousand pixels and pushed the activity log — the thing a user actually
 * watches while the model builds — off the bottom of the page. Each row keeps a
 * small thumbnail (still clickable for the full-size lightbox), the name, the
 * one-line description, and the install action on a single line.
 */

import { useEffect, useState, type ReactElement } from 'react'
import { ROUTE_API, type MarketEntry } from '../protocol.ts'
import { useLocale } from './messages.ts'
import type { ForgeStore } from './store.ts'
import { useForge } from './use-store.ts'
import styles from './styles.module.css'

export interface ForgeMarketProps {
  store: ForgeStore
}

/** How many entries are shown before the list has to be expanded. */
const COLLAPSED_ROWS = 4

/**
 * The `<img>` URL for a catalog screenshot.
 *
 * The screenshot lives on `raw.githubusercontent.com`, which the user's machine
 * frequently cannot reach (DNS poisoning answers `0.0.0.0`) — the card would
 * render as an eternal broken image. The Host relays the picture instead: the
 * tag points at the plugin's own origin, which always resolves, and the Host
 * does the GitHub fetch with its proxy fallback.
 */
function shotUrl(entry: MarketEntry): string {
  return `${ROUTE_API}/screenshot?url=${encodeURIComponent(entry.screenshot ?? '')}`
}

function fetchedLabel(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function ForgeMarket(props: ForgeMarketProps): ReactElement {
  const { store } = props
  const state = useForge(store)
  const t = useLocale()
  // The zoomed screenshot, if the user opened one. Local to the market
  // section: closing the panel (or selecting another) drops it, which is the
  // behaviour a lightbox should have — no route, no ledger entry, nothing to
  // clean up.
  const [zoomed, setZoomed] = useState<MarketEntry | undefined>(undefined)
  /** Whether the tail of a long catalog is revealed. */
  const [expanded, setExpanded] = useState(false)

  // Loaded once per mount, cached on the Host for fifteen minutes. A refresh
  // button is offered because a user who just published something expects to see
  // it, and the cache would otherwise hide it.
  useEffect(() => {
    if (state.market === undefined) void store.loadMarket()
  }, [store, state.market])

  const market = state.market
  const entries = market?.entries ?? []
  const overflow = entries.length > COLLAPSED_ROWS
  const visible = expanded || !overflow ? entries : entries.slice(0, COLLAPSED_ROWS)

  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <span className={styles.sectionTitle} title={t('marketHint')}>
          {t('market')}
        </span>
        <span className={styles.sectionCount}>{entries.length}</span>
        <div className={styles.sectionAction}>
          <button
            className={styles.buttonGhost}
            type="button"
            disabled={state.marketBusy}
            onClick={() => void store.loadMarket(true)}
          >
            {t('marketRefresh')}
          </button>
        </div>
      </div>

      {market === undefined ? (
        <div className={styles.empty}>{t('marketLoading')}</div>
      ) : (
        <>
          {market.error !== undefined ? (
            <div className={styles.chatWarn}>
              {t('marketFailed')} — {market.error}
            </div>
          ) : null}
          <div className={styles.marketMeta}>
            {market.source.length > 0 ? (
              <span>
                {t('marketSource')}: {market.source}
              </span>
            ) : null}
            {market.fetchedAt > 0 ? (
              <span>{t('marketFetched', { time: fetchedLabel(market.fetchedAt) })}</span>
            ) : null}
            {state.marketBusy ? <span>{t('marketInstalling')}</span> : null}
          </div>
          {entries.length === 0 ? (
            <div className={styles.empty}>{t('marketEmpty')}</div>
          ) : (
            <div className={styles.marketList}>
              {visible.map((entry: MarketEntry) => {
                const installed = entry.installedProjectId !== undefined
                return (
                  <div key={entry.id} className={styles.marketRow}>
                    {/* The screenshot is the row's first impression. It is
                        fetched through the Host's relay (see shotUrl) because
                        raw.githubusercontent.com is unreachable on the networks
                        this panel runs on. Clicking opens the full-size
                        lightbox. */}
                    {entry.screenshot !== undefined ? (
                      <button
                        type="button"
                        className={styles.marketShotButton}
                        title={t('marketZoomHint')}
                        onClick={() => setZoomed(entry)}
                      >
                        <img
                          className={styles.marketShot}
                          src={shotUrl(entry)}
                          alt={entry.name}
                          loading="lazy"
                          referrerPolicy="no-referrer"
                        />
                      </button>
                    ) : (
                      <span className={styles.marketShotBlank} aria-hidden="true" />
                    )}
                    <div className={styles.marketRowBody}>
                      <div className={styles.marketRowHead}>
                        <span className={styles.marketName} title={entry.id}>
                          {entry.name}
                        </span>
                        <span className={styles.marketVersion}>v{entry.version}</span>
                        {entry.category !== undefined ? (
                          <span className={styles.marketTag}>{entry.category}</span>
                        ) : null}
                        <span
                          className={`${styles.marketTag} ${
                            entry.runnable ? '' : styles.marketTagWarn
                          }`}
                        >
                          {entry.runnable ? t('marketRunnable') : t('marketDescriptorOnly')}
                        </span>
                        {entry.license !== undefined ? (
                          <span className={styles.marketVersion}>{entry.license}</span>
                        ) : null}
                      </div>
                      <span className={styles.marketDescription}>{entry.description}</span>
                    </div>
                    <div className={styles.marketActions}>
                      {installed ? (
                        <button
                          className={styles.buttonGhost}
                          type="button"
                          onClick={() => store.selectProject(entry.installedProjectId)}
                        >
                          {t('marketInstalled')}
                        </button>
                      ) : (
                        <button
                          className={styles.button}
                          type="button"
                          disabled={state.marketBusy}
                          onClick={() => void store.installFromMarket(entry.id)}
                        >
                          {t('marketInstall')}
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
          {overflow ? (
            <button
              className={styles.marketMore}
              type="button"
              onClick={() => setExpanded((current) => !current)}
            >
              {expanded
                ? t('marketShowLess')
                : t('marketShowAll', { count: entries.length - COLLAPSED_ROWS })}
            </button>
          ) : null}
        </>
      )}
      {zoomed !== undefined ? (
        <div
          className={styles.lightbox}
          role="dialog"
          aria-label={zoomed.name}
          onClick={() => setZoomed(undefined)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setZoomed(undefined)
          }}
        >
          <div className={styles.lightboxCard} onClick={(event) => event.stopPropagation()}>
            <div className={styles.lightboxHead}>
              <span className={styles.marketName}>{zoomed.name}</span>
              <span className={styles.marketVersion}>v{zoomed.version}</span>
              <button
                className={styles.buttonGhost}
                type="button"
                onClick={() => setZoomed(undefined)}
              >
                ✕
              </button>
            </div>
            {zoomed.screenshot !== undefined ? (
              <img
                className={styles.lightboxShot}
                src={shotUrl(zoomed)}
                alt={zoomed.name}
                referrerPolicy="no-referrer"
              />
            ) : null}
            <span className={styles.lightboxDesc}>{zoomed.description}</span>
          </div>
        </div>
      ) : null}
    </section>
  )
}

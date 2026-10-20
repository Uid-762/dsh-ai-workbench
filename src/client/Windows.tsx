/**
 * The floating layer: the windows the model built, as real windows.
 *
 * This component is registered into `shell.overlay`, a frame-wide list seat that
 * sits above every column. The seat is additive — a fresh id is placed beside the
 * shipped occupants rather than replacing them — and the layer is click-through,
 * so mounting here does not make the application underneath unclickable. Only the
 * `.window` elements opt back into pointer events.
 *
 * Four jobs, in order of importance:
 *
 *   1. **Render an artifact.** Each open window is an iframe pointed at the
 *      plugin's own `GET /site/<projectId>/<entry>` route. That route serves the
 *      file straight off disk, so the page the model wrote is the page the user
 *      sees — no build step, no bundling, no cache.
 *
 *   2. **Never fight the native chrome.** The desktop shell runs with
 *      `titleBarStyle: "hidden"` and a `titleBarOverlay`, so Electron paints the
 *      minimise / maximise / close buttons in a strip across the very top of the
 *      web view, at a z-order the page cannot reach. A window drawn at `top: 0`
 *      therefore loses its own titlebar — including its close button — to that
 *      strip, and a *maximised* window drawn at `top: 0` loses the only visible
 *      way out. That is the "the app froze and I could not close it" report this
 *      component exists to make impossible:
 *        · no window is ever placed above `chrome.top`;
 *        · "fullscreen" means *fill everything below the native strip*, not
 *          "cover the whole screen", so the native buttons stay reachable;
 *        · a fullscreen window additionally gets a labelled exit pill pinned
 *          below the strip, outside the window's own hit area.
 *
 *   3. **Relay declared actions.** The artifact talks to us with
 *      `parent.postMessage({ source, action, data }, '*')`. We accept a message
 *      only when it comes from a frame we own AND the action is declared in the
 *      window's manifest, then hand it to the store, which posts it to the Host.
 *      Everything else is dropped — that filter is the whole reason the model is
 *      not woken by every click inside a page.
 *
 *   4. **Stay disposable.** Every listener added here is removed on unmount, and
 *      the drag handlers live on `window` only for the duration of a drag.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react'
import { createPortal } from 'react-dom'
import { ACTION_SOURCE, LEGACY_ACTION_SOURCE, type ForgeWindow, type JsonValue } from '../protocol.ts'
import { ForgeChat } from './Chat.tsx'
import { t, useLocale } from './messages.ts'
import { useNativeChrome, type NativeChromeMetrics } from './native-chrome.ts'
import { siteUrl, statusLabel, type ForgeStore } from './store.ts'
import { useForge } from './use-store.ts'
import styles from './styles.module.css'

export interface ForgeWindowsProps {
  store: ForgeStore
}

/** The shape an artifact is allowed to post. Anything else is ignored. */
interface PostedAction {
  source?: unknown
  action?: unknown
  data?: unknown
}

/** A drag in progress on one window. */
interface DragState {
  windowId: string
  pointerId: number
  /** Offset from the window's top-left to the pointer, in screen pixels. */
  offsetX: number
  offsetY: number
}

/** Which edge or corner a resize grip is pulling. */
type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/** A resize in progress. */
interface ResizeState {
  windowId: string
  pointerId: number
  edge: Edge
  startX: number
  startY: number
  startLeft: number
  startTop: number
  startW: number
  startH: number
}

/** The eight grips, in the order they are drawn around the frame. */
const EDGES: readonly Edge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

/**
 * Clamp a window box into the area the page actually owns.
 *
 * Two invariants, both learned from the same complaint ("the close button is
 * gone and the thing is stuck"):
 *
 * 1. The lower bound is not `0`. On Windows the native control strip occupies
 *    the top `chrome.top` pixels and is painted above the page, so a window
 *    whose titlebar sits under it can no longer be moved or closed.
 * 2. The *whole* box is kept on screen whenever it fits. Constraining only the
 *    top-left corner is not enough: a ledger written on a 2560px monitor
 *    restores a 762px-wide window at x=1067, whose right-hand titlebar buttons
 *    — refresh, fullscreen, close — land past the 1440px viewport edge. The
 *    titlebar is the only handle that can close a window, so if it is off
 *    screen the window reads as frozen.
 */
function clampToViewport(
  x: number,
  y: number,
  w: number,
  h: number,
  chrome: NativeChromeMetrics,
): { x: number; y: number } {
  const minX = Math.min(chrome.left, 0)
  const minY = chrome.top
  const roomW = window.innerWidth - minX
  const roomH = window.innerHeight - minY
  // A window larger than the viewport cannot fit at all; pin its top-left to the
  // owned area's corner so its titlebar is still reachable, and let the frame
  // overflow to the right/bottom rather than off the top/left.
  const maxX = w <= roomW ? Math.max(minX, minX + roomW - w) : minX
  const maxY = h <= roomH ? Math.max(minY, minY + roomH - h) : minY
  return {
    x: Math.min(Math.max(x, minX), maxX),
    y: Math.min(Math.max(y, minY), maxY),
  }
}

export function ForgeWindows(props: ForgeWindowsProps): ReactElement | null {
  const { store } = props
  const state = useForge(store)
  useLocale()
  const chrome = useNativeChrome()
  const open = store.openWindows

  /** Maps a frame's `contentWindow` to the ledger row that owns it. */
  const framesRef = useRef(new Map<Window, string>())
  /** The `<section>` per window, so a fullscreen surface can take keyboard focus. */
  const shellsRef = useRef(new Map<string, HTMLElement>())
  const [drag, setDrag] = useState<DragState | null>(null)
  const [resize, setResize] = useState<ResizeState | null>(null)
  /** Bumped to force a reload of one artifact without touching the ledger. */
  const [reloads, setReloads] = useState<Record<string, number>>({})

  const fullscreenRows = open.filter((row) => row.fullscreen)

  const remember = useCallback((windowId: string, frame: HTMLIFrameElement | null): void => {
    const map = framesRef.current
    if (frame === null) {
      for (const [key, value] of map) {
        if (value === windowId) map.delete(key)
      }
      return
    }
    const content = frame.contentWindow
    if (content !== null) map.set(content, windowId)
  }, [])

  // --- the action bridge --------------------------------------------------
  //
  // One listener for the whole layer, installed once. It authenticates by frame
  // identity rather than by trusting `event.origin`, because the artifact is
  // served from the same origin as the shell: origin checking would accept any
  // other same-origin page, while frame identity accepts exactly the frames this
  // component created.
  useEffect(() => {
    function onMessage(event: MessageEvent<unknown>): void {
      const data = event.data
      if (data === null || typeof data !== 'object') return
      const posted = data as PostedAction
      // Both sources are accepted: the current one and the one the plugin wrote
      // under its previous name, because a window restored from an older ledger
      // may hold a page that still posts the old marker. Frame identity below is
      // the real authentication; the source check is only a cheap first filter.
      if (posted.source !== ACTION_SOURCE && posted.source !== LEGACY_ACTION_SOURCE) return
      const source = event.source
      if (source === null) return
      const windowId = framesRef.current.get(source as Window)
      if (windowId === undefined) return
      if (typeof posted.action !== 'string' || posted.action.length === 0) return
      void store.relayAction(windowId, posted.action, posted.data as JsonValue | undefined)
    }
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('message', onMessage)
    }
  }, [store])

  // --- window drag --------------------------------------------------------
  //
  // The handlers live on `window` for the duration of the drag, not on the
  // titlebar: the pointer routinely leaves a 40px-tall titlebar, and a drag that
  // stops following the pointer the moment it exits the element feels broken.
  useEffect(() => {
    if (drag === null) return
    const active = drag
    document.body.style.userSelect = 'none'

    function onMove(event: PointerEvent): void {
      if (event.pointerId !== active.pointerId) return
      const x = event.clientX - active.offsetX
      const y = event.clientY - active.offsetY
      const current = store.state.ledger.windows.find((row) => row.id === active.windowId)
      if (current === undefined) return
      const clamped = clampToViewport(x, y, current.w, current.h, chrome)
      // Optimistic local move: the ledger round trip would make the window lag
      // the pointer by a frame at 60 Hz, which reads as stutter.
      void store.updateWindow(active.windowId, clamped)
    }
    function onUp(event: PointerEvent): void {
      if (event.pointerId !== active.pointerId) return
      setDrag(null)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      document.body.style.userSelect = ''
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [drag, store, chrome])

  // --- window resize ------------------------------------------------------
  //
  // Eight grips share one handler: the edge decides which of the four numbers
  // move, and the top edge stops at `chrome.top` instead of at zero so pulling a
  // window up can never tuck it under the native strip.
  useEffect(() => {
    if (resize === null) return
    const active = resize
    document.body.style.userSelect = 'none'

    function onMove(event: PointerEvent): void {
      if (event.pointerId !== active.pointerId) return
      const limits = store.state.limits
      const dx = event.clientX - active.startX
      const dy = event.clientY - active.startY

      let w = active.startW
      let h = active.startH
      let x = active.startLeft
      let y = active.startTop

      if (active.edge.includes('e')) w = Math.max(limits.minWindowW, active.startW + dx)
      if (active.edge.includes('s')) h = Math.max(limits.minWindowH, active.startH + dy)
      if (active.edge.includes('w')) {
        w = Math.max(limits.minWindowW, active.startW - dx)
        x = active.startLeft + (active.startW - w)
      }
      if (active.edge.includes('n')) {
        h = Math.max(limits.minWindowH, active.startH - dy)
        y = active.startTop + (active.startH - h)
        if (y < chrome.top) {
          // The grip hit the native strip: give the height back rather than
          // sliding under it.
          h = Math.max(limits.minWindowH, h - (chrome.top - y))
          y = chrome.top
        }
      }
      const clamped = clampToViewport(x, y, w, h, chrome)
      void store.updateWindow(active.windowId, { x: clamped.x, y: clamped.y, w, h })
    }
    function onUp(event: PointerEvent): void {
      if (event.pointerId !== active.pointerId) return
      setResize(null)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      document.body.style.userSelect = ''
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [resize, store, chrome])

  // --- the exit hatch -----------------------------------------------------
  //
  // Three independent ways out of a fullscreen surface, because the report was
  // "I got stuck and had to kill the app":
  //
  //   · the exit pill pinned under the native strip (a real button, always
  //     visible, labelled — see the render below);
  //   · Escape, wired here so it works whenever the page owns the keyboard;
  //   · the window's own close button in its titlebar.
  //
  // Escape cannot reach us while the artifact's iframe holds focus — a frame is
  // a separate document and its key events do not bubble out. So entering
  // fullscreen moves focus back to our own shell, which is what makes Escape
  // work at the moment the user is most likely to press it.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return
      for (const row of store.openWindows) {
        if (row.fullscreen) void store.updateWindow(row.id, { fullscreen: false })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [store])

  // Hand focus to the surface that just became fullscreen, so Escape lands on
  // our listener instead of inside a sandboxed document.
  const fullscreenSignature = fullscreenRows.map((row) => row.id).join(',')
  useEffect(() => {
    if (fullscreenSignature.length === 0) return
    for (const id of fullscreenSignature.split(',')) {
      const shell = shellsRef.current.get(id)
      if (shell === undefined) continue
      shell.focus({ preventScroll: true })
      const frame = shell.querySelector('iframe')
      if (frame !== null) frame.blur()
    }
  }, [fullscreenSignature])

  if (open.length === 0) return null

  function startDrag(event: ReactPointerEvent<HTMLElement>, row: ForgeWindow): void {
    if (event.button !== 0) return
    // A titlebar that also hosts buttons must not start a drag when the button is
    // the real target.
    if ((event.target as HTMLElement).closest('button') !== null) return
    // A fullscreen window has nowhere to be dragged to.
    if (row.fullscreen) return
    event.preventDefault()
    const bounds = event.currentTarget.getBoundingClientRect()
    setDrag({
      windowId: row.id,
      pointerId: event.pointerId,
      offsetX: event.clientX - bounds.left,
      offsetY: event.clientY - bounds.top,
    })
    void store.raise(row.id)
  }

  function startResize(event: ReactPointerEvent<HTMLElement>, row: ForgeWindow, edge: Edge): void {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    // A fullscreen window has no meaningful size to shrink from: leave
    // fullscreen first and continue from the surface it occupied, so the grip a
    // user grabs on a maximised window starts a resize that feels continuous.
    if (row.fullscreen) {
      void store.updateWindow(row.id, {
        fullscreen: false,
        x: 0,
        y: chrome.top,
        w: window.innerWidth,
        h: Math.max(store.state.limits.minWindowH, window.innerHeight - chrome.top),
      })
    }
    setResize({
      windowId: row.id,
      pointerId: event.pointerId,
      edge,
      startX: event.clientX,
      startY: event.clientY,
      startLeft: row.fullscreen ? 0 : row.x,
      startTop: row.fullscreen ? chrome.top : Math.max(row.y, chrome.top),
      startW: row.fullscreen ? window.innerWidth : row.w,
      startH: row.fullscreen
        ? Math.max(store.state.limits.minWindowH, window.innerHeight - chrome.top)
        : row.h,
    })
  }

  return createPortal(
    <div className={styles.layer} data-chrome-top={chrome.top}>
      {open.map((row) => {
        const fullscreen = row.fullscreen
        // Both branches respect `chrome.top`: the maximised surface starts below
        // the native strip and ends at the bottom of the viewport, so the shell's
        // own window buttons stay lit and clickable while an artifact is open.
        //
        // The restore path clamps too, not just the drag path. A ledger written on
        // a 2560px monitor and reopened on a 1440px laptop otherwise restores a
        // window whose titlebar — the only handle that can move or close it — sits
        // off the right edge, which is indistinguishable from a freeze.
        const restored = fullscreen ? null : clampToViewport(row.x, row.y, row.w, row.h, chrome)
        // A window restored on a smaller screen may also be *wider* than the
        // viewport, which pushes its titlebar buttons off the right edge just as
        // effectively as a bad origin. Shrink it to fit rather than let it
        // overflow; the ledger keeps the authored size for the next restore.
        const roomW = Math.max(store.state.limits.minWindowW, window.innerWidth - chrome.left)
        const roomH = Math.max(store.state.limits.minWindowH, window.innerHeight - chrome.top)
        const width = Math.min(row.w, roomW)
        const height = Math.min(row.h, roomH)
        const box: CSSProperties = fullscreen
          ? { left: 0, right: 0, top: chrome.top, bottom: 0, width: 'auto', height: 'auto' }
          : {
              left: restored === null ? row.x : restored.x,
              top: restored === null ? chrome.top : restored.y,
              width,
              height: row.minimized ? 40 : height,
            }
        const reload = reloads[row.id] ?? 0
        // The cache-buster must NOT be `row.updatedAt`: the ledger row is patched
        // on every move, resize and raise, so a timestamp in the URL would reload
        // the artifact on every pointer move — the frame flickers, typed state is
        // lost, and dragging reads as a freeze. Only real content signals belong
        // here: the entry file, the declared action count, and the ready flag.
        const src = `${siteUrl(row)}?v=${encodeURIComponent(row.entry)}-${row.actions.length}-${
          row.status === 'ready' ? 'r' : 'b'
        }-${reload}`
        return (
          <section
            key={row.id}
            ref={(element) => {
              if (element === null) shellsRef.current.delete(row.id)
              else shellsRef.current.set(row.id, element)
            }}
            className={`${styles.window} ${fullscreen ? styles.windowFullscreen : ''} ${
              row.minimized ? styles.windowMinimized : ''
            } ${drag?.windowId === row.id ? styles.titlebarDragging : ''} ${
              resize?.windowId === row.id ? styles.windowResizing : ''
            }`}
            style={box}
            onPointerDown={() => void store.raise(row.id)}
            aria-label={row.title}
            tabIndex={-1}
            data-status={row.status}
          >
            <header
              className={styles.titlebar}
              onPointerDown={(event) => startDrag(event, row)}
              onDoubleClick={() => void store.updateWindow(row.id, { fullscreen: !fullscreen })}
            >
              <span className={styles.titleMark} aria-hidden="true" />
              <span className={styles.titleTextWrap}>
                <span className={styles.titleText} title={row.entry}>
                  {row.title}
                </span>
                <span className={styles.titleSub} title={row.entry}>
                  {row.entry.trim().length > 0 ? row.entry : statusLabel(row.status)}
                </span>
              </span>
              <span className={styles.titleBadge} data-status={row.status}>
                {statusLabel(row.status)}
              </span>
              <div className={styles.titleActions}>
                <button
                  type="button"
                  className={styles.titleButton}
                  title={t('refresh')}
                  aria-label={t('refresh')}
                  onClick={() => {
                    setReloads((current) => ({ ...current, [row.id]: (current[row.id] ?? 0) + 1 }))
                  }}
                >
                  ⟳
                </button>
                <button
                  type="button"
                  className={`${styles.titleButton} ${
                    state.chatWindowId === row.id ? styles.titleButtonActive : ''
                  }`}
                  title={t('chatTitle')}
                  aria-label={t('chatTitle')}
                  onClick={() => store.toggleChat(row.id)}
                >
                  💬
                </button>
                <button
                  type="button"
                  className={styles.titleButton}
                  title={row.minimized ? t('restore') : t('minimize')}
                  aria-label={row.minimized ? t('restore') : t('minimize')}
                  onClick={() => void store.updateWindow(row.id, { minimized: !row.minimized })}
                >
                  {row.minimized ? '▢' : '—'}
                </button>
                <button
                  type="button"
                  className={styles.titleButton}
                  title={t('popout')}
                  aria-label={t('popout')}
                  onClick={() => store.popout(row.id)}
                >
                  ⧉
                </button>
                {/* The way out, and it is not an icon. While a page owns the
                    screen the exit is the one control a user hunts for, so it
                    gets a label and the accent colour. It lives inside the
                    titlebar rather than floating over the artifact: a floating
                    dock is one more layer that can cover the artifact's own
                    controls, and this row is always painted below the native
                    strip and inside the clamped box, so it cannot be covered. */}
                {fullscreen ? (
                  <button
                    type="button"
                    className={styles.titleExit}
                    title={t('exitFullscreen')}
                    aria-label={t('exitFullscreen')}
                    onClick={() => void store.updateWindow(row.id, { fullscreen: false })}
                  >
                    <span className={styles.titleExitKey}>Esc</span>
                    {t('exitFullscreen')}
                  </button>
                ) : null}
                <button
                  type="button"
                  className={`${styles.titleButton} ${fullscreen ? styles.titleButtonActive : ''}`}
                  title={fullscreen ? t('exitFullscreen') : t('fullscreen')}
                  aria-label={fullscreen ? t('exitFullscreen') : t('fullscreen')}
                  onClick={() => void store.updateWindow(row.id, { fullscreen: !fullscreen })}
                >
                  {fullscreen ? '⤡' : '⤢'}
                </button>
                <button
                  type="button"
                  className={`${styles.titleButton} ${styles.titleButtonClose}`}
                  title={t('close')}
                  aria-label={t('close')}
                  onClick={() =>
                    void store.updateWindow(row.id, { open: false, minimized: false, fullscreen: false })
                  }
                >
                  ✕
                </button>
              </div>
            </header>

            {row.minimized ? null : (
              <div className={styles.frameRow}>
                <div className={styles.frameArea}>
                  <div className={styles.frameWrap}>
                    {row.entry.trim().length === 0 ? (
                      <div className={styles.frameState}>
                        <span className={styles.frameStateTitle}>{t('windowEmpty')}</span>
                        <span className={styles.frameStateHint}>{t('windowEmptyHint')}</span>
                      </div>
                    ) : (
                      <iframe
                        className={styles.frame}
                        ref={(element) => remember(row.id, element)}
                        src={src}
                        title={row.title}
                        // The artifact is generated code. `allow-scripts` lets it run;
                        // `allow-same-origin` is deliberately omitted so it cannot read
                        // the shell's storage or cookies — its own localStorage still
                        // works because the sandbox gives it a unique opaque origin.
                        sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"
                        referrerPolicy="no-referrer"
                      />
                    )}
                    {row.status !== 'ready' ? (
                      <div className={styles.frameHint}>
                        <span className={styles.badge} data-status={row.status}>
                          {statusLabel(row.status)}
                        </span>
                        <span>
                          {row.status === 'building' ? t('waitingForModel') : t('windowBlocked')}
                        </span>
                      </div>
                    ) : null}
                  </div>
                </div>
                {state.chatWindowId === row.id ? (
                  // The chat is bound to the *project*, not the window: a project
                  // owns one folder, one session and one manifest, and the model
                  // answering here is talking about that folder. Two windows of
                  // the same project therefore share one transcript, which is the
                  // honest model — they are two views of one artifact.
                  <ForgeChat
                    store={store}
                    projectId={row.projectId}
                    onOpenSession={() => store.openSession(row.projectId)}
                  />
                ) : null}
              </div>
            )}

            {row.minimized
              ? null
              : EDGES.map((edge) => (
                  <span
                    key={edge}
                    className={styles.resizeHandle}
                    data-edge={edge}
                    onPointerDown={(event) => startResize(event, row, edge)}
                    title={t('resize')}
                  />
                ))}
          </section>
        )
      })}

      {/* The safety net. The labelled pill in the titlebar is the primary way
          out, but it sits in a row whose position depends on the native strip
          being measured correctly. This dock does not: it is pinned to the
          bottom-left corner, which no native chrome ever occupies, so it stays
          reachable even if the strip height is misreported. Bottom-left rather
          than top-right because every artifact page puts its own navigation up
          there, and this is the corner where a stray pill covers the least. */}
      {fullscreenRows.length > 0 ? (
        <div className={styles.exitDock}>
          <span className={styles.exitDockLabel}>
            {t('fullscreenActive')} · {fullscreenRows[0]?.title}
          </span>
          <button
            type="button"
            className={styles.exitDockButton}
            onClick={() => {
              for (const row of fullscreenRows) void store.updateWindow(row.id, { fullscreen: false })
            }}
          >
            <span className={styles.exitDockKey}>Esc</span>
            {t('exitFullscreen')}
          </button>
        </div>
      ) : null}
    </div>,
    // Portal into `document.body`. Two stacked reasons, both load-bearing:
    //
    // 1. **Escape the stacking context.** `shell.overlay` renders inside the
    //    shell's chrome at `z-index: 20`; our windows need to sit above the
    //    application columns, which no z-index inside that context can do. A
    //    direct child of `<body>` competes with the chrome on equal terms.
    // 2. **Escape transformed ancestors.** Any ancestor with a transform or
    //    containment clips `position: fixed` descendants — that was the "the
    //    window only shows half" bug. A body child has no such ancestor.
    //
    // Theme variables survive the move: the shell defines `--dsw-alias-*` on
    // `body`, so a child of body still inherits every token.
    document.body,
  )
}

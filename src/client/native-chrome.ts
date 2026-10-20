/**
 * How much of the window the *operating system* owns.
 *
 * The desktop shell runs with `titleBarStyle: "hidden"` and a
 * `titleBarOverlay`, so on Windows the minimise / maximise / close buttons are
 * painted by Electron in a strip across the top of the web view, at the very
 * highest z-order the page can never reach. Anything this plugin draws at
 * `top: 0` — including its own close button — lands underneath that strip and
 * stops being clickable. That is the "the window froze and I cannot get out"
 * bug: a maximised artifact covered the viewport, and the only visible exit was
 * a button the native chrome was sitting on.
 *
 * So the layer needs one number: the height of the strip it must stay below.
 * There is no public CSS variable that reliably carries it — the shell declares
 * `--dsh-windows-titlebar-height` but the value is injected by the renderer, not
 * the stylesheet — so this module reads it from the authoritative source,
 * `navigator.windowControlsOverlay`, and falls back to the documented 40px only
 * when that API is missing.
 *
 * Everything here is read-only and side-effect free apart from the subscription
 * a React caller installs. It degrades to `{top: 0}` in a plain browser, where
 * there is no native chrome to avoid.
 */

import { useEffect, useState } from 'react'

/** The safe area the floating layer must keep clear of, in CSS pixels. */
export interface NativeChromeMetrics {
  /** Height of the native titlebar strip across the top of the web view. */
  top: number
  /** Width of the native control cluster when it sits on the left (macOS). */
  left: number
  /** Width of the native control cluster when it sits on the right (Windows). */
  right: number
  /** True when Electron's Window Controls Overlay is driving the layout. */
  overlay: boolean
  /** Best guess at the host platform, from the shell's own attribute. */
  platform: 'win32' | 'darwin' | 'other'
}

/** Electron's documented default for `titleBarOverlay.height` on Windows. */
const FALLBACK_TITLEBAR_HEIGHT = 40

/** Width of the three native buttons at their default size, plus their gutter. */
const FALLBACK_CONTROLS_WIDTH = 138

/** macOS traffic lights float over the top-left corner without reserving a strip. */
const DARWIN_LIGHTS_HEIGHT = 28

/**
 * The slice of `WindowControlsOverlay` this module uses.
 *
 * TypeScript's DOM library does not ship this interface, so it is declared here
 * with every member optional: the object exists in Electron and in Chromium, but
 * a plain browser tab has no `navigator.windowControlsOverlay` at all, and older
 * Electron builds lack `geometrychange`.
 */
interface OverlayFace {
  visible?: boolean
  getTitlebarAreaRect?: () => DOMRect
  addEventListener?: (type: string, listener: () => void) => void
  removeEventListener?: (type: string, listener: () => void) => void
}

const NO_CHROME: NativeChromeMetrics = {
  top: 0,
  left: 0,
  right: 0,
  overlay: false,
  platform: 'other',
}

function readPlatform(): NativeChromeMetrics['platform'] {
  const declared = document.documentElement.getAttribute('data-platform')
  if (declared === 'darwin') return 'darwin'
  if (declared === 'win32' || declared === 'windows') return 'win32'
  const agent = navigator.userAgent
  if (agent.includes('Mac OS X') || agent.includes('Macintosh')) return 'darwin'
  if (agent.includes('Windows')) return 'win32'
  return 'other'
}

/** A CSS length read off the document root, or 0 when it is not a number. */
function readRootLength(name: string): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name)
  const value = Number.parseFloat(raw)
  return Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Measure the native chrome once.
 *
 * Order matters. `windowControlsOverlay` is the only API that answers "where are
 * the buttons, exactly"; the shell attribute is a hint that some strip exists;
 * the constant is the last resort so a maximised window is still escapable if
 * every probe fails.
 */
export function measureNativeChrome(): NativeChromeMetrics {
  const platform = readPlatform()
  const face = (navigator as Navigator & { windowControlsOverlay?: OverlayFace })
    .windowControlsOverlay

  let top = 0
  let left = 0
  let right = 0
  let overlay = false

  if (face !== undefined && face.visible === true && typeof face.getTitlebarAreaRect === 'function') {
    overlay = true
    const rect = face.getTitlebarAreaRect()
    if (Number.isFinite(rect.height) && rect.height > 0) top = Math.round(rect.height)
    // The rect covers the draggable part of the titlebar, so the controls are
    // whatever the rect does not cover. A zero-width rect means the API is
    // reporting nothing useful and the constant below takes over.
    if (Number.isFinite(rect.width) && rect.width > 0 && rect.width < window.innerWidth - 1) {
      const cluster = Math.round(window.innerWidth - rect.width)
      if (rect.x > window.innerWidth / 2) left = cluster
      else right = cluster
    }
  }

  if (top === 0) {
    const declared = document.documentElement.hasAttribute('data-windows-titlebar')
    // When the *host window* itself is in real fullscreen the shell says so on
    // the root element, and its own layout collapses the chrome to zero. Take
    // that as the answer: the overlay strip is not painted in fullscreen, so
    // reserving 40px there would leave a dead band across the top of the screen.
    const hostFullscreen = document.documentElement.hasAttribute('data-fullscreen')
    const cssTop = readRootLength('--dsh-windows-titlebar-height')
    if (hostFullscreen) {
      // Leave top at 0; the strip is gone.
    } else if (cssTop > 0) {
      top = Math.round(cssTop)
      overlay = declared
    } else if (declared) {
      top = FALLBACK_TITLEBAR_HEIGHT
      overlay = true
    }
  }

  if (top > 0 && left === 0 && right === 0) {
    // A strip exists but the API did not report the cluster: assume the Windows
    // arrangement, which is where this plugin is actually used.
    right = FALLBACK_CONTROLS_WIDTH
  }

  if (top === 0 && platform === 'darwin') {
    // No strip is reserved, but the traffic lights still sit over the page.
    top = DARWIN_LIGHTS_HEIGHT
    left = 78
  }

  if (top === 0) return NO_CHROME
  return { top, left, right, overlay, platform }
}

/**
 * Subscribe to the native chrome geometry.
 *
 * `geometrychange` fires when the overlay is toggled (entering and leaving full
 * screen, for instance) and a plain `resize` catches the rest. Both listeners
 * are removed on unmount; the initial measurement happens during the first
 * render so a window is never painted into the native strip for one frame.
 */
export function useNativeChrome(): NativeChromeMetrics {
  const [metrics, setMetrics] = useState<NativeChromeMetrics>(measureNativeChrome)

  useEffect(() => {
    function sync(): void {
      const next = measureNativeChrome()
      setMetrics((current) =>
        current.top === next.top &&
        current.left === next.left &&
        current.right === next.right &&
        current.overlay === next.overlay &&
        current.platform === next.platform
          ? current
          : next,
      )
    }
    const face = (navigator as Navigator & { windowControlsOverlay?: OverlayFace })
      .windowControlsOverlay
    face?.addEventListener?.('geometrychange', sync)
    window.addEventListener('resize', sync)
    return () => {
      face?.removeEventListener?.('geometrychange', sync)
      window.removeEventListener('resize', sync)
    }
  }, [])

  return metrics
}

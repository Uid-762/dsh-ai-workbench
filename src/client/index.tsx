/**
 * Client-half entry: register the three surfaces this plugin owns.
 *
 * 1. `sidebar.panellist` — a row in the sidebar's icon strip. This is the entry
 *    point the user actually sees; without it the plugin is invisible.
 * 2. `main` — the central panel that row selects. The two are registered as a
 *    pair because the shell refuses to select a sidebar row whose panel is
 *    missing, and a `main` key with no row can never be reached.
 * 3. `shell.overlay` — the frame-wide floating layer the generated windows live
 *    in. This seat is additive: a fresh id sits beside the shipped entries
 *    instead of replacing them.
 *
 * Everything is reached structurally. The client bundle may only `require` the
 * nine specifiers in the shell's frozen module table — none of the
 * `@deepseek-ai/dsh-client-*` packages are among them — so the registry, the
 * session service and the conversation service are all described by local
 * interfaces and probed at runtime. Each registration is wrapped so one missing
 * seat cannot take down the others.
 *
 * All three seats are *other* plugins' declarations, so every one of them is
 * mounted through `registry.inject(name, …)` rather than a bare `register`: see
 * {@link mount} for why the distinction decides whether the plugin is visible
 * at all.
 */

import type { Context } from '@deepseek-ai/cordis'
import { PANEL_ID, PANEL_ORDER, SEAT_ID } from '../protocol.ts'
import { attachLocale, t } from './messages.ts'
import { ForgePanel } from './Panel.tsx'
import { ForgeWindows } from './Windows.tsx'
import { ForgeStore, type ForgeServices } from './store.ts'

/** The only hard dependency: without a slot registry nothing can be mounted. */
export const inject = ['slots']

/**
 * The slot registry, as this plugin uses it.
 *
 * `register` returns a disposer and `inject` gates the registration on the seat
 * existing. Declared structurally so the bundle stays pure.
 */
interface SlotRegistryFace {
  inject(name: string, register: () => () => void): () => void
  register(options: SlotOptions, component: unknown): () => void
}

interface SlotOptions {
  name: string
  id?: string
  key?: string
  order?: number
  label?: string | (() => string)
  inject?: () => Record<string, unknown>
}

/** Reach `ctx.slots` without assuming the augmentation is installed. */
function slotRegistry(ctx: Context): SlotRegistryFace | undefined {
  const candidate = (ctx as unknown as { slots?: unknown }).slots
  if (candidate === null || typeof candidate !== 'object') return undefined
  const face = candidate as Partial<SlotRegistryFace>
  if (typeof face.inject !== 'function' || typeof face.register !== 'function') return undefined
  return face as SlotRegistryFace
}

/**
 * Collect the optional client services.
 *
 * `ctx.get(name)` is the non-throwing lookup; a missing service leaves that slot
 * of the result undefined and the corresponding feature degrades (no session is
 * created, so the panel explains that instead of throwing).
 *
 * Returned as a *resolver* rather than a snapshot. The shell composes its client
 * services after a third-party client half is applied, so calling this once
 * during `apply()` would capture four `undefined`s and the store would believe
 * the shell has no session service for the rest of the session.
 */
function serviceResolver(ctx: Context): () => ForgeServices {
  const get = (name: string): unknown => {
    try {
      return (ctx as unknown as { get?: (key: string) => unknown }).get?.(name)
    } catch {
      return undefined
    }
  }
  return () => ({
    sessions: get('sessions'),
    conversation: get('conversation'),
    uiWorkspace: get('uiWorkspace'),
    locale: get('locale'),
  })
}

/**
 * Attach the dictionaries once the locale service exists.
 *
 * Same late-composition problem as the store's services: the locale service is
 * installed by a shell half that applies after this one, so probing once during
 * `apply()` would find nothing and every string would stay on the bundled
 * fallback. Polling a handful of times is enough — this runs once per page
 * load, not per frame — and a deployment without the service simply exhausts
 * the attempts and keeps the fallback dictionary.
 */
function attachLocaleWhenReady(services: () => ForgeServices): () => void {
  let dispose = attachLocale(services().locale)
  let attempts = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const probe = (): void => {
    if (services().locale === undefined && attempts < LOCALE_PROBE_ATTEMPTS) {
      attempts += 1
      timer = setTimeout(probe, LOCALE_PROBE_MS)
      return
    }
    if (services().locale !== undefined && attempts > 0) dispose = attachLocale(services().locale)
  }
  timer = setTimeout(probe, LOCALE_PROBE_MS)

  return () => {
    if (timer !== undefined) clearTimeout(timer)
    dispose()
  }
}

/** How many times to look for the locale service, and how far apart. */
const LOCALE_PROBE_ATTEMPTS = 20
const LOCALE_PROBE_MS = 250

/**
 * Mount the client half.
 *
 * The store is created and loaded *before* the seats are registered. That
 * ordering matters: the model can summon a window the moment the plugin is
 * active, and a store that connects lazily would miss the frame that opens it.
 */
export function apply(ctx: Context): () => void {
  const services = serviceResolver(ctx)
  const store = new ForgeStore(services)
  void store.load()
  store.connect()

  const disposeLocale = attachLocaleWhenReady(services)
  const registry = slotRegistry(ctx)
  const disposers: Array<() => void> = []

  if (registry === undefined) {
    // A shell without the slot registry cannot show anything, but the plugin
    // must not throw: another seat (or a future version) may still call in.
    console.warn('[ai-workbench] the client has no slot registry — nothing is mounted.')
    return () => {
      disposeLocale()
      store.dispose()
    }
  }

  // --- the three seats ----------------------------------------------------

  /**
   * Register into one seat, waiting for its declaration.
   *
   * This must go through `registry.inject(name, …)`, never a bare `register`:
   * none of these seats are declared by this plugin. `main` is declared by the
   * layout shell and `sidebar.panellist` by the sidebar shell, both of which
   * compose *after* a third-party client half is applied — a direct `register`
   * at this point throws `slot "…" is not declared` and the surface silently
   * never appears. `inject` runs the callback when (and each time) the
   * declaration arrives, so registration order between plugins stops mattering.
   */
  const mount = (name: string, register: () => () => void, label: string): void => {
    try {
      const dispose = registry.inject(name, register)
      disposers.push(dispose)
    } catch (error) {
      console.warn(`[ai-workbench] could not register the ${label}:`, error)
    }
  }

  // The central panel. Its key is the id the sidebar row selects, so the row
  // and the panel agree on one string and the pair cannot drift apart.
  mount(
    'main',
    () => registry.register({ name: 'main', key: PANEL_ID, inject: () => ({ store }) }, ForgePanel),
    'main panel',
  )

  // The sidebar row. `label` is a thunk so the row follows a language switch
  // without re-registering.
  mount(
    'sidebar.panellist',
    () =>
      registry.register(
        { name: 'sidebar.panellist', id: PANEL_ID, order: PANEL_ORDER, label: () => t('title') },
        PanelIcon,
      ),
    'sidebar row',
  )

  // The frame-wide floating layer the generated windows live in.
  mount(
    'shell.overlay',
    () =>
      registry.register(
        {
          name: 'shell.overlay',
          id: SEAT_ID,
          order: PANEL_ORDER,
          label: () => t('title'),
          inject: () => ({ store }),
        },
        ForgeWindows,
      ),
    'overlay seat',
  )

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // A seat that was already removed by the shell is not an error.
      }
    }
    disposeLocale()
    store.dispose()
  }
}

/**
 * The sidebar icon.
 *
 * A plain function component, not a React element: the seat calls it with
 * `{ size, active }` owner props and renders the result. It draws the two panes
 * of a split window — the product in one glyph.
 */
function PanelIcon(props: { size?: number; active?: boolean }): unknown {
  const size = props.size ?? 16
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="1.8" y="2.6" width="12.4" height="10.8" rx="2" />
      <path d="M6.4 2.6v10.8" />
      <path d="M2 5.4h12.2" />
    </svg>
  )
}

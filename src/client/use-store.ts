/**
 * The React binding for {@link ForgeStore}.
 *
 * `useSyncExternalStore` rather than `useState` + `useEffect`: the store is the
 * single writer, and subscribing through the official hook is what makes a
 * mutation that happens outside React (an SSE frame, an action relayed from an
 * iframe) render on the next paint instead of the next tick.
 *
 * The returned object is the store's whole state. Components slice what they
 * need; there is no selector memoisation because the state object is small and
 * replaced wholesale on every change, which is what makes reference equality a
 * valid change signal.
 */

import { useSyncExternalStore } from 'react'
import type { ForgeState, ForgeStore } from './store.ts'

/** Subscribe a component to the store. */
export function useForge(store: ForgeStore): ForgeState {
  return useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.state,
    () => store.state,
  )
}

/**
 * Minimal ambient typing for `react-dom`.
 *
 * The shell provides `react-dom` in its frozen client module table — a client
 * bundle may `require` it, but the package (and its type declarations) are not
 * installed on this machine and must not be bundled. This file declares just the
 * surface the plugin uses (`createPortal`), which keeps `tsc` honest about the
 * call shape without adding a dependency.
 */
declare module 'react-dom' {
  import type { ReactNode, ReactPortal } from 'react'

  export function createPortal(
    children: ReactNode,
    container: Element | DocumentFragment,
    key?: string | number | null,
  ): ReactPortal
}

/**
 * Ambient declaration for CSS Module imports.
 *
 * The build hashes every class name (`[hash]_[local]`), so the shape the bundler
 * hands back is a plain string map. This declaration is only the fallback: a
 * generated sidecar (`styles.module.css.d.ts`, written by `scripts/css-types.mjs`)
 * sits next to the stylesheet and wins over this wildcard, giving every class an
 * explicitly declared name.
 *
 * That distinction is not cosmetic. Under `noUncheckedIndexedAccess`, an index
 * signature reads back as `string | undefined`, so with this wildcard alone every
 * `styles.someClass` would be a type error at the point it is assigned to a
 * `className`. Explicitly declared properties are exempt from that widening — and
 * a typo is still a compile error.
 */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

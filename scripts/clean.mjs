/**
 * Remove the build output.
 *
 * Deliberately a script rather than `rimraf`/`del-cli`: the Host half is meant to
 * resolve with only Node builtins and `@deepseek-ai/*`, and a build that needs a
 * third-party cleaner to produce that half is already inconsistent.
 *
 * The `lib` directory is removed whole, before `tsc` writes `lib/types` and
 * `tsdown` writes `lib/index.js` + `lib/client.js`. That ordering matters:
 * `tsdown` runs with `clean: false` so it never wipes the declarations `tsc`
 * emitted a moment earlier, which is why the cleanup has to happen here, once, at
 * the front of the build.
 */
import { rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const target = join(root, 'lib')

await rm(target, { recursive: true, force: true })
console.log(`clean: removed ${target}`)

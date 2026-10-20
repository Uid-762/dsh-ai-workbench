/**
 * Build recipe for `dsh-ai-workbench`.
 *
 * Two artifacts are produced:
 *
 *   lib/index.js   — the Host half, plain Node ESM (`format: 'esm'`).
 *   lib/client.js  — the browser half, wrapped in the DSH lazy-CJS bundle
 *                    protocol `window.__ModuleLoader__.load({ id, factory })`.
 *
 * The wrapper is not cosmetic: the client module system executes a bundle only
 * to register its factory, and `require` inside the factory resolves against the
 * frozen platform table (React, Cordis, the static UI libraries). Bundling React
 * or importing another plugin's internals would break at materialization, so
 * `purityGate()` turns those two mistakes into build errors instead of runtime
 * ones.
 */
import { basename, dirname, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { transform } from 'lightningcss'
import type { UserConfig } from 'tsdown'

/** The bundle id MUST equal the package name; the module loader keys factories by it. */
const ID = 'dsh-ai-workbench'

/**
 * The frozen platform module table. A client bundle may `require` exactly these
 * specifiers without declaring them in `dsh.client.external`.
 */
const EXTERNALS = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis']

/** Packages that must never be imported for value: they are runtime-owned by the shell. */
const FORBIDDEN_PREFIX = '@deepseek-ai/'

/**
 * Rejects any `@deepseek-ai/*` value import that is not part of the platform
 * table. Cross-plugin imports are forbidden — plugins collaborate through
 * cordis services, never through each other's modules.
 */
function purityGate() {
  return {
    name: 'workbench-purity-gate',
    resolveId(source: string, importer: string | undefined) {
      if (!source.startsWith(FORBIDDEN_PREFIX)) return null
      if (EXTERNALS.includes(source)) return null
      throw new Error(
        `client bundle purity: "${source}" is not in the module table (EXTERNALS) — ` +
          `cross-plugin value imports are forbidden; collaborate through cordis services ` +
          `(imported from ${importer ?? 'the entry'})`,
      )
    },
  }
}

/** Byte-stable class-name map: fixed UTF-16 ordering, never `localeCompare`. */
function sortClassMap(entries: Array<[string, string]>): Array<[string, string]> {
  return [...entries].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
}

/**
 * Compiles `*.module.css` into a virtual ES module that injects one `<style>`
 * tag at materialization time and default-exports the class map.
 *
 * The stylesheet never travels through the Host: the tag is created by the
 * bundle itself, which keeps the plugin free of any asset route.
 */
function cssModulesPlugin() {
  const VIRTUAL_PREFIX = '\0workbench-css:'
  /**
   * A trailing query keeps the virtual id from ending in `.css`.
   *
   * tsdown ships its own `css-guard` plugin that intercepts any id ending in
   * `.css` and insists `@tsdown/css` is installed. The stylesheet is already
   * compiled here by lightningcss, so the guard must not see it — and a suffix
   * is what keeps this plugin's id from looking like a plain stylesheet.
   */
  const VIRTUAL_SUFFIX = '?workbench-css'
  return {
    name: 'workbench-css-modules',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      // Resolve against the importer's directory with `node:path` rather than by
      // slicing on '/': on Windows the importer arrives with backslashes, and a
      // slash-only slice silently resolves the stylesheet against the process
      // CWD instead — which only fails at build time, and only on Windows.
      const from = importer === undefined ? process.cwd() : dirname(importer)
      return VIRTUAL_PREFIX + resolve(from, source) + VIRTUAL_SUFFIX
    },
    async load(id: string) {
      if (!id.startsWith(VIRTUAL_PREFIX) || !id.endsWith(VIRTUAL_SUFFIX)) return null
      const fileId = id.slice(VIRTUAL_PREFIX.length, -VIRTUAL_SUFFIX.length)
      const { readFile } = await import('node:fs/promises')
      const code = await readFile(fileId)
      const result = transform({
        filename: fileId,
        code,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      // `exports` is a parsed map of `{ [local]: { name, composes, isReferenced } }`,
      // not a JSON string. Only `name` is wanted: the bundle needs the class
      // name, and `composes` is already resolved into the emitted CSS.
      const raw = (result.exports ?? {}) as Record<string, { name: string }>
      const pairs = sortClassMap(Object.entries(raw).map(([local, entry]) => [local, entry.name]))
      const classMap = JSON.stringify(Object.fromEntries(pairs))
      const css = result.code.toString()
      const tagId = `${ID}/${basename(fileId)}`
      const styleJson = JSON.stringify(css)
      const tagJson = JSON.stringify(tagId)
      const pluginJson = JSON.stringify(ID)
      return [
        `const TAG_ID = ${tagJson};`,
        `const CSS = ${styleJson};`,
        `function ensureStyle() {`,
        `  if (typeof document === 'undefined') return;`,
        `  if (document.querySelector('style[data-plugin-css="' + TAG_ID + '"]') !== null) return;`,
        `  const el = document.createElement('style');`,
        `  el.setAttribute('data-plugin-css', TAG_ID);`,
        `  el.setAttribute('data-plugin', ${pluginJson});`,
        `  el.textContent = CSS;`,
        `  document.head.appendChild(el);`,
        `}`,
        `ensureStyle();`,
        `export default ${classMap};`,
      ].join('\n')
    },
    renderChunk(code: string, chunk: { fileName: string }) {
      if (chunk.fileName !== 'client.js') return null
      // A short, content-derived build stamp helps identify a stale bundle in the wild.
      const rev = createHash('sha256').update(code).digest('hex').slice(0, 12)
      return { code: `${code}\n//# workbench-build ${rev}\n`, map: null }
    },
  }
}

const clientConfig: UserConfig = {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  minify: true,
  sourcemap: false,
  clean: false,
  deps: {
    neverBundle: [...EXTERNALS],
    alwaysBundle: (id: string) => !EXTERNALS.includes(id),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  plugins: [purityGate(), cssModulesPlugin()],
  outputOptions: {
    entryFileNames: 'client.js',
    codeSplitting: false,
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

const hostConfig: UserConfig = {
  name: ID,
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  sourcemap: false,
  clean: false,
  external: [/^@deepseek-ai\//, /^node:/],
  outputOptions: {
    entryFileNames: '[name].js',
  },
}

export default [hostConfig, clientConfig]

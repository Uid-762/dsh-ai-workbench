/**
 * Static contract checks for this bundle.
 *
 * This script exists because the failure modes of a DSH plugin are almost all
 * silent. A wrong `dsh.client.inject` entry does not throw — it orders nothing. A
 * client bundle that requires a package outside the shell's frozen module table
 * does not throw at build time — it throws in the browser, after the user has
 * already installed the plugin. A CSS-Module class that exists in the stylesheet
 * but not in the generated sidecar fails `tsc` with a message about
 * `string | undefined` that does not mention CSS at all.
 *
 * So this file asserts the things a build cannot: the shape of the manifest, the
 * purity of the client bundle, the pairing of the sidebar row with its panel, the
 * wire constants the two halves share, and the parity of the two dictionaries.
 *
 * Run it after a build. Exit code 1 means a contract is broken. It deliberately
 * does NOT build, install, or start anything.
 */
import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const failures = []
const notes = []

/** The package name, read from the manifest so it is stated in exactly one place. */
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const PACKAGE_NAME = manifest.name

function fail(area, message) {
  failures.push({ area, message })
}

function note(area, message) {
  notes.push({ area, message })
}

async function exists(path) {
  try {
    await stat(join(root, path))
    return true
  } catch {
    return false
  }
}

async function read(path) {
  return readFile(join(root, path), 'utf8')
}

// ---------------------------------------------------------------- the tree --

/**
 * Every file this bundle promises to ship.
 *
 * Kept explicit rather than globbed: a glob would pass after a file was deleted,
 * and the point of the check is that the authored tree still has the shape the
 * README describes.
 */
const REQUIRED = [
  'package.json',
  'cordis.patch.yml',
  'tsconfig.json',
  'tsdown.config.ts',
  'README.md',
  'locale/en.json',
  'locale/zh.json',
  'scripts/clean.mjs',
  'scripts/css-types.mjs',
  'scripts/verify.mjs',
  'src/index.ts',
  'src/config.ts',
  'src/protocol.ts',
  'src/ledger.ts',
  'src/artifacts.ts',
  'src/reconcile.ts',
  'src/bundle.ts',
  'src/market.ts',
  'src/skill.ts',
  'src/summary.ts',
  'src/tar.ts',
  'src/routes/api.ts',
  'src/routes/sse.ts',
  'src/tools/workbench_window.ts',
  'src/client/index.tsx',
  'src/client/store.ts',
  'src/client/messages.ts',
  'src/client/task-text.ts',
  'src/client/Panel.tsx',
  'src/client/Windows.tsx',
  'src/client/Intake.tsx',
  'src/client/Chat.tsx',
  'src/client/Market.tsx',
  'src/client/use-store.ts',
  'src/client/styles.module.css',
  'src/client/css-modules.d.ts',
]

for (const path of REQUIRED) {
  if (!(await exists(path))) fail('tree', `missing required file: ${path}`)
}

// ------------------------------------------------------------- the manifest --

if (manifest.dsh === undefined || typeof manifest.dsh !== 'object') {
  fail('manifest', 'package.json has no "dsh" section — the installer will not treat this as a bundle')
} else {
  const dsh = manifest.dsh
  if (dsh.manifestVersion !== 1) {
    fail('manifest', `dsh.manifestVersion must be 1, found ${JSON.stringify(dsh.manifestVersion)}`)
  }
  if (dsh.bundle?.patch !== './cordis.patch.yml') {
    fail(
      'manifest',
      `dsh.bundle.patch must be "./cordis.patch.yml", found ${JSON.stringify(dsh.bundle?.patch)}`,
    )
  }
  if (dsh.client?.platform !== 'web') {
    fail('manifest', `dsh.client.platform must be "web", found ${JSON.stringify(dsh.client?.platform)}`)
  }

  const inject = dsh.client?.inject
  if (!Array.isArray(inject)) {
    fail('manifest', 'dsh.client.inject must be an array of client package names')
  } else {
    // The trap this check exists for: `@deepseek-ai/dsh-client-ui-slots` is in the
    // browser module table, so `require()` resolves it — but the package ships no
    // `./client` export, so the boot manifest creates no row for it and an inject
    // naming it orders nothing at all. It is silently useless, never an error.
    for (const id of inject) {
      if (typeof id !== 'string' || id.length === 0) {
        fail('manifest', `dsh.client.inject contains a non-string entry: ${JSON.stringify(id)}`)
        continue
      }
      let meta
      try {
        // Probed directly rather than by scanning node_modules: pnpm installs
        // packages as symlinks, and a directory scan skips them.
        meta = JSON.parse(await readFile(join(root, 'node_modules', id, 'package.json'), 'utf8'))
      } catch {
        // Not installed here (a consumer installs it). Nothing to check.
        continue
      }
      if (meta.exports?.['./client'] === undefined) {
        fail(
          'manifest',
          `dsh.client.inject names "${id}", which exports no "./client" — it has no client entry, so the inject orders nothing`,
        )
      }
      if (meta.dsh?.client?.platform !== 'web') {
        note(
          'manifest',
          `dsh.client.inject names "${id}", whose own platform is ${JSON.stringify(meta.dsh?.client?.platform)}`,
        )
      }
    }
  }
}

// The entry points the manifest promises must be the files the build produces.
const EXPECTED_ENTRIES = {
  '.': './lib/index.js',
  './client': './lib/client.js',
}
for (const [subpath, target] of Object.entries(EXPECTED_ENTRIES)) {
  const declared = manifest.exports?.[subpath]
  if (declared !== target) {
    fail('manifest', `exports["${subpath}"] must be "${target}", found ${JSON.stringify(declared)}`)
  }
}

// ---------------------------------------------------------------- the patch --

const patch = await read('cordis.patch.yml').catch(() => '')
if (patch.length === 0) {
  fail('patch', 'cordis.patch.yml is missing or empty')
} else {
  if (!patch.includes(`name: '${PACKAGE_NAME}'`)) {
    fail('patch', `cordis.patch.yml must name the package "${PACKAGE_NAME}" in the inserted row`)
  }
  // The guard matters: a bundle patch is applied on every boot, so a profile that
  // already lists this plugin would otherwise insert a second row. Two live copies
  // collide on the same route prefix, and a duplicate (kind, path) registration
  // throws during composition — which takes the whole application down, not just
  // this plugin.
  if (!patch.includes('ctx.loader.entries()')) {
    fail(
      'patch',
      'cordis.patch.yml has no double-mount guard (expected a `disabled: !!js` expression over ctx.loader.entries())',
    )
  }
  if (!patch.includes('e.options.id !==')) {
    fail('patch', 'the double-mount guard must exclude its own id, or the row disables itself')
  }
}

// ---------------------------------------------------------- the client half --

const clientBundlePath = 'lib/client.js'
if (await exists(clientBundlePath)) {
  const bundle = await read(clientBundlePath)

  // 1. The loader handshake. The id must equal the package name: the boot manifest
  //    keys the graph by package name, and a mismatch produces a bundle that loads
  //    under an id nothing can resolve.
  if (!bundle.startsWith('window.__ModuleLoader__.load({')) {
    fail('client', 'lib/client.js does not start with the __ModuleLoader__ handshake')
  }
  if (!/^window\.__ModuleLoader__\.load\(\{\s*id\s*:/.test(bundle)) {
    fail('client', 'lib/client.js does not pass an `id` as the first handshake field')
  }
  if (!bundle.includes(`id:\`${PACKAGE_NAME}\``) && !bundle.includes(`id:"${PACKAGE_NAME}"`)) {
    fail('client', `lib/client.js does not declare id "${PACKAGE_NAME}"`)
  }
  // The footer is rewritten by the minifier, so the check is on the closing shape
  // rather than on an exact expression: the factory must return something ending
  // in `.exports`, then close the object literal and the call. A real tail looks
  // like `return n.apply=U,n.inject=B,t.exports}});` — the exported names are
  // assigned on the way out, so matching `return module.exports` verbatim would
  // reject a correct bundle.
  if (!/\}\s*\}\s*\)\s*;?\s*$/.test(bundle)) {
    fail('client', 'lib/client.js does not close the factory and the load() call')
  }
  if (!/return\s+[^;{}]*\.exports\s*;?\s*\}\s*\}\s*\)\s*;?\s*$/.test(bundle)) {
    fail('client', 'lib/client.js does not return the module exports from the factory')
  }

  // 2. Purity. The shell's module table is a frozen set of nine specifiers; a
  //    require of anything else throws at load time in the browser.
  const MODULE_TABLE = new Set([
    'react',
    'react/jsx-runtime',
    'react-dom',
    'react-dom/client',
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-store',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-primitives',
    '@deepseek-ai/dsh-client-ui-dockkit',
  ])
  const required = new Set()
  // The minified factory aliases the require function, so the specifier is read
  // from the factory parameter rather than from a literal `require(` call. The
  // bundler writes `factory:e=>{`, with neither parentheses nor a space.
  const alias = bundle.match(/factory\s*:\s*(?:\(\s*)?([A-Za-z_$][\w$]*)\s*\)?\s*=>/)
  if (alias !== null) {
    const call = new RegExp(`\\b${alias[1]}\\(\\s*[\`'"]([^\`'"]+)[\`'"]\\s*\\)`, 'g')
    for (const match of bundle.matchAll(call)) required.add(match[1])
  }
  for (const match of bundle.matchAll(/\brequire\(\s*[`'"]([^`'"]+)[`'"]\s*\)/g)) {
    required.add(match[1])
  }
  if (required.size === 0) {
    fail('client', 'no require() calls found in lib/client.js — the bundle resolved nothing')
  }
  for (const specifier of required) {
    if (!MODULE_TABLE.has(specifier)) {
      fail(
        'client',
        `lib/client.js requires "${specifier}", which is outside the shell's frozen module table`,
      )
    } else {
      note('client', `requires ${specifier}`)
    }
  }

  // 3. The seats. All three registrations must be present. Whether they go
  //    through `registry.inject` (they must — the seats belong to other
  //    plugins) is asserted against the readable source below, not here: the
  //    minifier hoists the registration callbacks, so string offsets in the
  //    bundle say nothing about call order.
  if (!bundle.includes('sidebar.panellist')) {
    fail('client', 'lib/client.js never registers into sidebar.panellist — the plugin would be invisible')
  }
  if (!bundle.includes('name:`main`') && !bundle.includes('name:"main"')) {
    fail('client', 'lib/client.js never registers into main — the sidebar row would select nothing')
  }
  if (!bundle.includes('shell.overlay')) {
    fail(
      'client',
      'lib/client.js never registers into shell.overlay — generated windows would have nowhere to mount',
    )
  }

  // 4. The action tag the artifact and the bridge must agree on.
  const protocolSource = await read('src/protocol.ts')
  const tagMatch = protocolSource.match(/ACTION_SOURCE\s*=\s*['"]([^'"]+)['"]/)
  if (tagMatch === null) {
    fail('protocol', 'src/protocol.ts does not define ACTION_SOURCE')
  } else if (!bundle.includes(tagMatch[1])) {
    fail('client', `lib/client.js does not contain the action tag "${tagMatch[1]}" the artifacts will post`)
  }

  // 5. CSS injection must be guarded, or a second load stacks duplicate sheets.
  if (!bundle.includes('data-plugin-css')) {
    fail('client', 'lib/client.js injects no stylesheet — the panel would render unstyled')
  }
  if (!bundle.includes('querySelector')) {
    fail('client', 'lib/client.js injects its stylesheet without an existence guard')
  }
} else {
  note('client', 'lib/client.js is absent — run the build before verifying')
}

// ----------------------------------------------------------- the host half --

const hostBundlePath = 'lib/index.js'
if (await exists(hostBundlePath)) {
  const bundle = await read(hostBundlePath)
  if (!bundle.includes('export')) {
    fail('host', 'lib/index.js has no exports')
  }
  if (!bundle.includes('workbench_window')) {
    fail('host', 'lib/index.js does not register the workbench_window tool')
  }
  // The built-in skill is content, not code paths: if the bundler ever treeshook
  // it away the model silently loses the authoring guide, and nothing throws.
  if (!bundle.includes('ai-workbench-authoring')) {
    fail('host', 'lib/index.js does not carry the built-in authoring skill')
  }
  // Orphan adoption is a recovery path, so a treeshaking accident would show up
  // as "the page exists but no window ever appears" — the exact bug it fixes.
  if (!bundle.includes('windowDismissed')) {
    fail('host', 'lib/index.js has lost the window-dismissal guard that keeps adoption from undoing a delete')
  }
  // The reply filter decides which assistant messages belong to the chat pane. If
  // the marker strings are gone, every reply in the user's session gets copied
  // into the workbench chat log.
  if (!bundle.includes('workbench-chat')) {
    fail('host', 'lib/index.js has lost the chat-reply marker filter')
  }
} else {
  note('host', 'lib/index.js is absent — run the build before verifying')
}

// --------------------------------------------------------- the entry export --

const hostEntry = await read('src/index.ts')
for (const exported of ['name', 'apply']) {
  const pattern = new RegExp(`export\\s+(const|function)\\s+${exported}\\b`)
  if (!pattern.test(hostEntry)) {
    fail('host', `src/index.ts does not export ${exported}`)
  }
}
if (!/export const inject/.test(hostEntry)) {
  fail('host', 'src/index.ts does not export inject')
}
if (!/export\s*\{\s*Config\s*\}/.test(hostEntry) && !/export const Config/.test(hostEntry)) {
  fail('host', 'src/index.ts does not export Config — the settings page is generated from it')
}

const clientEntry = await read('src/client/index.tsx')
if (!/export function apply/.test(clientEntry)) {
  fail('client', 'src/client/index.tsx does not export apply')
}
if (!/export const inject\s*=\s*\['slots'\]/.test(clientEntry)) {
  fail('client', "the client half must declare exactly ['slots'] as its hard dependency")
}
// Every seat this plugin fills is declared by *another* plugin (the layout
// shell owns `main`, the sidebar shell owns `sidebar.panellist`). A bare
// `registry.register(...)` at apply time therefore throws "slot … is not
// declared" whenever that other half composes later — which is the normal case
// for a third-party client bundle — and the surface silently never appears.
// All three must be mounted through `registry.inject(name, …)`, which waits for
// the declaration. This is asserted on the readable source: the minifier
// hoists callbacks, so the bundle's string order says nothing about it.
{
  const mounts = clientEntry.match(/mount\(\s*\n?\s*'(main|sidebar\.panellist|shell\.overlay)'/g) ?? []
  if (mounts.length !== 3) {
    fail(
      'client',
      `src/client/index.tsx must mount all three seats through registry.inject (found ${mounts.length}/3)`,
    )
  }
  for (const seat of ['main', 'sidebar.panellist', 'shell.overlay']) {
    if (!new RegExp(`mount\\(\\s*\\n?\\s*'${seat.replace('.', '\\.')}'`).test(clientEntry)) {
      fail('client', `src/client/index.tsx never mounts the ${seat} seat`)
    }
  }
  // A bare register into an undeclared seat is the exact bug this guards.
  const bareRegister = clientEntry.match(/registry\.register\(/g) ?? []
  const throughInject = clientEntry.match(/registry\.inject\(/g) ?? []
  if (bareRegister.length > 0 && throughInject.length === 0) {
    fail(
      'client',
      'src/client/index.tsx calls registry.register directly; seats owned by other plugins must be entered through registry.inject',
    )
  }
}

// -------------------------------------------------------------- the protocol --

const protocol = await read('src/protocol.ts')
for (const constant of [
  "ROUTE_API = '/apps/ai-workbench/api'",
  "ROUTE_EVENTS = '/apps/ai-workbench/events'",
  "LEDGER_FILE_NAME = 'dsh-ai-workbench.json'",
  "MANIFEST_FILE = '_workbench.json'",
  "PANEL_ID = 'ai-workbench'",
  "SEAT_ID = 'ai-workbench'",
  "ACTION_SOURCE = 'dsh-ai-workbench'",
  "BUNDLE_EXTENSION = '.dshwb.json'",
]) {
  if (!protocol.includes(constant)) {
    fail('protocol', `src/protocol.ts must declare ${constant}`)
  }
}
// The client imports the route constant rather than repeating the string; a
// literal in the browser half is the drift this catches.
const clientStore = await read('src/client/store.ts')
if (clientStore.includes("'/apps/ai-workbench/api'") || clientStore.includes('"/apps/ai-workbench/api"')) {
  fail('protocol', 'src/client/store.ts repeats the route literal instead of importing ROUTE_API')
}
if (!clientStore.includes('ROUTE_API') || !clientStore.includes('ROUTE_EVENTS')) {
  fail('protocol', 'src/client/store.ts must import ROUTE_API and ROUTE_EVENTS')
}

// -------------------------------------------------------------- the locales --

const en = JSON.parse(await read('locale/en.json'))
const zh = JSON.parse(await read('locale/zh.json'))
/** The dictionary namespace, which must match `LOCALE_NS` in the runtime messages. */
const LOCALE_NS = 'ai-workbench'
for (const [name, dict] of [
  ['en', en],
  ['zh', zh],
]) {
  if (typeof dict.meta?.title !== 'string' || dict.meta.title.length === 0) {
    fail('locale', `locale/${name}.json has no meta.title — the installer shows this name`)
  }
  if (typeof dict.meta?.description !== 'string' || dict.meta.description.length === 0) {
    fail('locale', `locale/${name}.json has no meta.description`)
  }
  if (dict[LOCALE_NS] === undefined) {
    fail('locale', `locale/${name}.json has no "${LOCALE_NS}" namespace`)
  }
}
const enKeys = Object.keys(en[LOCALE_NS] ?? {}).sort()
const zhKeys = Object.keys(zh[LOCALE_NS] ?? {}).sort()
const missingInZh = enKeys.filter((key) => !zhKeys.includes(key))
const missingInEn = zhKeys.filter((key) => !enKeys.includes(key))
if (missingInZh.length > 0) fail('locale', `locale/zh.json is missing keys: ${missingInZh.join(', ')}`)
if (missingInEn.length > 0) fail('locale', `locale/en.json is missing keys: ${missingInEn.join(', ')}`)

// The runtime dictionaries live in the bundle, so they must cover the same keys
// as the files the installer reads. Drift here means the panel says one thing and
// the plugin list another. The runtime dictionary is a superset — it also carries
// the intake, chat, import/export and market copy, which no installer reads.
const messages = await read('src/client/messages.ts')
if (!messages.includes(`LOCALE_NS = '${LOCALE_NS}'`)) {
  fail('locale', `src/client/messages.ts must declare LOCALE_NS = '${LOCALE_NS}'`)
}
for (const key of enKeys) {
  if (!messages.includes(`${key}:`)) {
    fail('locale', `src/client/messages.ts has no "${key}" entry, but locale/en.json declares it`)
  }
}

// -------------------------------------------------------------- CSS modules --

const css = await read('src/client/styles.module.css')
const sidecar = await read('src/client/styles.module.css.d.ts').catch(() => '')
const cssClasses = new Set()
// Anchored at the line start: the same dot appears in descendant selectors
// (`.a .b`), in `:global(...)`, and inside comments.
for (const line of css.split('\n')) {
  const match = line.match(/^\.([A-Za-z_][A-Za-z0-9_]*)/)
  if (match !== null) cssClasses.add(match[1])
}
const declared = new Set()
for (const match of sidecar.matchAll(/readonly\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) {
  declared.add(match[1])
}
if (declared.size === 0) {
  fail('css', 'src/client/styles.module.css.d.ts is missing or empty — run `node scripts/css-types.mjs`')
}
for (const name of cssClasses) {
  if (!declared.has(name)) {
    fail(
      'css',
      `class ".${name}" is in the stylesheet but not in the generated sidecar — re-run scripts/css-types.mjs`,
    )
  }
}
for (const name of declared) {
  if (!cssClasses.has(name)) {
    fail(
      'css',
      `class ".${name}" is in the sidecar but no longer in the stylesheet — re-run scripts/css-types.mjs`,
    )
  }
}

// Every class the components reach for must exist. Comments and imports are
// stripped first: `import styles from './styles.module.css'` would otherwise be
// read as a use of a class named `module`, and a `styles.foo` inside a doc
// comment is prose rather than code.
const used = new Set()
const clientFiles = [
  'src/client/index.tsx',
  'src/client/Panel.tsx',
  'src/client/Windows.tsx',
  'src/client/Intake.tsx',
  'src/client/Chat.tsx',
  'src/client/Market.tsx',
  'src/client/use-store.ts',
]
for (const file of clientFiles) {
  const source = await read(file).catch(() => '')
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const withoutImports = withoutComments.replace(/^\s*import\b[^\n]*$/gm, '')
  for (const match of withoutImports.matchAll(/\bstyles\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
    used.add(match[1])
  }
  // Dynamic member reads (styles[`layoutThumb_${slug}`]) build class names at
  // runtime; verify each template prefix against the declarations so a renamed
  // CSS class is caught here rather than silently unstyled in the panel.
  for (const match of withoutImports.matchAll(/styles\[`([A-Za-z_][A-Za-z0-9_]*)\$\{/g)) {
    const prefix = match[1]
    for (const name of cssClasses) {
      if (name.startsWith(prefix)) used.add(name)
    }
  }
}
for (const name of used) {
  if (!cssClasses.has(name)) {
    fail('css', `a component uses styles.${name}, which the stylesheet does not declare`)
  }
}
for (const name of cssClasses) {
  if (!used.has(name)) {
    note('css', `class ".${name}" is declared but never used`)
  }
}

// -------------------------------------------------------------- the tsdown --

const tsdown = await read('tsdown.config.ts')
if (!tsdown.includes(`const ID = '${PACKAGE_NAME}'`)) {
  fail(
    'build',
    `tsdown.config.ts must declare \`const ID = '${PACKAGE_NAME}'\` — the loader handshake is generated from it`,
  )
}
if (!tsdown.includes('window.__ModuleLoader__.load({ id: ')) {
  fail('build', 'tsdown.config.ts does not set the client banner')
}
if (!tsdown.includes("'return module.exports; } });'")) {
  fail('build', 'tsdown.config.ts does not set the client footer')
}
if (!tsdown.includes("'var module = { exports: {} }; var exports = module.exports;'")) {
  fail('build', 'tsdown.config.ts does not set the client intro')
}

// ---------------------------------------------------------------- reporting --

if (failures.length === 0) {
  const clientFilesPresent = REQUIRED.filter((path) => path.startsWith('src/client/'))
  const hostFilesPresent = REQUIRED.filter((path) => path.startsWith('src/') && !path.startsWith('src/client/'))
  console.log(`${PACKAGE_NAME} · ${clientFilesPresent.length} client files, ${hostFilesPresent.length} host files`)
  for (const entry of notes) console.log(`note: [${entry.area}] ${entry.message}`)
  console.log('all contract checks passed')
} else {
  for (const entry of notes) console.log(`note: [${entry.area}] ${entry.message}`)
  for (const entry of failures) console.error(`FAIL [${entry.area}] ${entry.message}`)
  console.error(`${failures.length} contract check(s) failed`)
  process.exitCode = 1
}

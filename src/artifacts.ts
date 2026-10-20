/**
 * Artifact hosting.
 *
 * The model writes plain files into the project folder; this module is what
 * turns a folder into something an iframe can load. Two responsibilities, and
 * both of them are security boundaries:
 *
 *   1. **Containment.** A request path arrives from the browser and is joined to
 *      the project folder. Everything here resolves the result and refuses
 *      anything that escapes that folder — including through a symlink, which is
 *      why the check is done on the real path rather than on the string. Without
 *      this, `/apps/ai-workbench/api/site/<id>/../../../../etc/passwd` would be a
 *      file-read primitive for any page in the app.
 *
 *   2. **The manifest.** `_workbench.json` next to the entry file is how the model
 *      declares the window's title, entry point, and the actions the artifact is
 *      allowed to send back. Reading it is what lets the loop stay quiet: the
 *      client drops any action the manifest did not declare.
 *
 * No index of the folder is ever served. A request for a directory returns the
 * project's entry file if it has one, and 404 otherwise.
 */
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import {
  LEGACY_MANIFEST_FILE,
  MANIFEST_FILE,
  type ForgeManifest,
  type ForgeProject,
  type ForgeWindow,
} from './protocol.ts'

/** A record with no prototype surprises. */
function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

/** Content types for the file kinds a generated artifact realistically uses. */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
}

/**
 * Extensions that must never be served.
 *
 * The artifact host is reachable by any page in the app. Serving a `.json` that
 * happens to be a credential file, or an executable, would turn "the model wrote
 * a file here" into a disclosure primitive. Generated windows are HTML and the
 * assets they reference; nothing else is part of the product.
 */
const BLOCKED_EXTENSIONS = new Set(['.exe', '.dll', '.bat', '.cmd', '.ps1', '.sh', '.node', '.env'])

/** True when `child` is inside `parent` (or is `parent`). */
function isInside(parent: string, child: string): boolean {
  if (child === parent) return true
  const withSep = parent.endsWith(sep) ? parent : `${parent}${sep}`
  return child.startsWith(withSep)
}

/** What a resolved artifact request produced. */
export type ArtifactResult =
  | { kind: 'file'; path: string; contentType: string; bytes: Buffer }
  | { kind: 'missing'; reason: string }
  | { kind: 'forbidden'; reason: string }

/**
 * Resolve a browser-supplied relative path against a project folder.
 *
 * Returns the real path only when it is inside the folder. Both the lexical
 * resolution and the real path are checked: the first catches `..` traversal,
 * the second catches a symlink inside the folder pointing outside it.
 */
export async function resolveArtifactPath(
  folder: string,
  relative: string,
): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  let decoded: string
  try {
    decoded = decodeURIComponent(relative)
  } catch {
    return { ok: false, reason: 'the path is not valid URL encoding' }
  }
  if (decoded.includes('\0')) return { ok: false, reason: 'the path contains a null byte' }
  const cleaned = normalize(decoded).replace(/^([/\\])+/, '')
  const base = resolve(folder)
  const candidate = resolve(base, cleaned)
  if (!isInside(base, candidate)) return { ok: false, reason: 'the path leaves the project folder' }
  let realBase: string
  let realCandidate: string
  try {
    realBase = await realpath(base)
  } catch {
    return { ok: false, reason: 'the project folder does not exist' }
  }
  try {
    realCandidate = await realpath(candidate)
  } catch {
    return { ok: false, reason: 'no such file' }
  }
  if (!isInside(realBase, realCandidate)) {
    return { ok: false, reason: 'the path resolves outside the project folder' }
  }
  return { ok: true, path: realCandidate }
}

/**
 * Read a file for the artifact host.
 *
 * A directory request falls back to the project's entry file, then to
 * `index.html`. Directory listings are never produced.
 */
export async function readArtifact(
  project: ForgeProject,
  relative: string,
  fallbackEntry: string,
): Promise<ArtifactResult> {
  const trimmed = relative.replace(/^([/\\])+/, '')
  const attempt = trimmed.length === 0 ? fallbackEntry : trimmed
  const resolved = await resolveArtifactPath(project.folder, attempt)
  if (!resolved.ok) {
    // A bare folder request with no entry declared is the common first-run case:
    // the project exists but the model has not written anything yet. Report it as
    // missing rather than forbidden so the window can show its own empty state.
    // 'no such file' is the same situation for a named path — the file simply is
    // not there; only containment and extension denials are genuine forbidden.
    if (trimmed.length === 0 || resolved.reason === 'no such file') {
      return { kind: 'missing', reason: 'this project has no entry file yet' }
    }
    return { kind: 'forbidden', reason: resolved.reason }
  }
  let info
  try {
    info = await stat(resolved.path)
  } catch {
    return { kind: 'missing', reason: 'no such file' }
  }
  if (info.isDirectory()) {
    for (const candidate of ['index.html', fallbackEntry]) {
      if (candidate.length === 0) continue
      const nested = await resolveArtifactPath(project.folder, join(attempt, candidate))
      if (!nested.ok) continue
      try {
        const nestedInfo = await stat(nested.path)
        if (!nestedInfo.isFile()) continue
        return await loadFile(nested.path)
      } catch {
        continue
      }
    }
    return { kind: 'missing', reason: 'this folder has no index.html' }
  }
  if (!info.isFile()) return { kind: 'missing', reason: 'not a regular file' }
  return await loadFile(resolved.path)
}

async function loadFile(path: string): Promise<ArtifactResult> {
  const extension = extname(path).toLowerCase()
  if (BLOCKED_EXTENSIONS.has(extension)) {
    return { kind: 'forbidden', reason: `files ending in ${extension} are not served` }
  }
  try {
    const bytes = await readFile(path)
    return {
      kind: 'file',
      path,
      contentType: CONTENT_TYPES[extension] ?? 'application/octet-stream',
      bytes,
    }
  } catch {
    return { kind: 'missing', reason: 'the file could not be read' }
  }
}

/**
 * Read the model's manifest from the project folder.
 *
 * Every field is optional and every failure is silent: a project with no
 * manifest is the normal state before the model has written anything, and a
 * malformed one must not break the window that is already showing.
 *
 * The previous release's file name is tried second so an artifact written before
 * the rename still reports its title and actions instead of looking empty.
 */
export async function readManifest(project: ForgeProject): Promise<ForgeManifest | undefined> {
  for (const name of [MANIFEST_FILE, LEGACY_MANIFEST_FILE]) {
    const manifest = await readManifestFile(project, name)
    if (manifest !== undefined) return manifest
  }
  return undefined
}

async function readManifestFile(project: ForgeProject, name: string): Promise<ForgeManifest | undefined> {
  const resolved = await resolveArtifactPath(project.folder, name)
  if (!resolved.ok) return undefined
  let text: string
  try {
    text = await readFile(resolved.path, 'utf8')
  } catch {
    return undefined
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  const record = asRecord(raw)
  const manifest: ForgeManifest = {}
  if (typeof record.title === 'string') manifest.title = record.title
  if (typeof record.entry === 'string') manifest.entry = record.entry
  if (typeof record.note === 'string') manifest.note = record.note
  if (typeof record.ready === 'boolean') manifest.ready = record.ready
  if (Array.isArray(record.actions)) {
    const actions: NonNullable<ForgeManifest['actions']> = []
    for (const item of record.actions) {
      const entry = asRecord(item)
      if (typeof entry.name !== 'string' || entry.name.length === 0) continue
      const action: NonNullable<ForgeManifest['actions']>[number] = { name: entry.name }
      if (typeof entry.label === 'string') action.label = entry.label
      if (typeof entry.description === 'string') action.description = entry.description
      actions.push(action)
    }
    manifest.actions = actions
  }
  return manifest
}

/** One entry in the folder listing the panel shows. */
export interface FolderEntry {
  name: string
  kind: 'file' | 'dir'
  size: number
  /** True for the file the manifest names as the window's entry point. */
  entry: boolean
}

/**
 * List a project folder for the panel.
 *
 * Deliberately shallow and bounded: this exists so the user can see what the
 * model produced, not to be a file manager. Entries outside the folder are
 * impossible here because only direct children are named, and each name is
 * re-resolved before being reported.
 */
export async function listFolder(
  project: ForgeProject,
  relative = '',
  limit = 200,
): Promise<FolderEntry[]> {
  const resolved = await resolveArtifactPath(project.folder, relative)
  if (!resolved.ok) return []
  let names: string[]
  try {
    names = await readdir(resolved.path)
  } catch {
    return []
  }
  const manifest = await readManifest(project)
  const entry = manifest?.entry ?? ''
  const entries: FolderEntry[] = []
  for (const name of names.slice(0, limit)) {
    const child = await resolveArtifactPath(project.folder, join(relative, name))
    if (!child.ok) continue
    try {
      const info = await stat(child.path)
      entries.push({
        name,
        kind: info.isDirectory() ? 'dir' : 'file',
        size: info.isDirectory() ? 0 : info.size,
        entry: entry.length > 0 && (entry === name || entry.endsWith(`/${name}`)),
      })
    } catch {
      continue
    }
  }
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })
  return entries
}

/** Absolute path of a project's entry file, for display. */
export function entryPath(folder: string, entry: string): string {
  if (isAbsolute(entry)) return entry
  return join(folder, entry)
}

/**
 * Cheap existence probe with the same containment rules as a real read.
 *
 * Used by the market view to decide whether an installed package actually holds
 * an entry page — a question that must not cost a full file read, and must not
 * be answered with a bare `stat` on an unnormalized path.
 */
export async function statArtifact(
  folder: string,
  relative: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const resolved = await resolveArtifactPath(folder, relative)
  if (!resolved.ok) return { ok: false, reason: resolved.reason }
  try {
    const info = await stat(resolved.path)
    if (!info.isFile()) return { ok: false, reason: 'not a file' }
    return { ok: true }
  } catch {
    return { ok: false, reason: 'the file does not exist' }
  }
}

/**
 * Deep candidate scan: which page in this folder could serve as the entry?
 *
 * Root `index.html` is still the answer when it exists, but packages downloaded
 * from the market often keep their only real page one or two levels down
 * (`standalone/index.html`, `public/index.html`, …). Returns posix-relative
 * paths, shallowest first, deeper paths never descending past two directories.
 */
export async function findEntryCandidates(folder: string, limit = 6): Promise<string[]> {
  const out: string[] = []
  const scan = async (relative: string, depth: number): Promise<void> => {
    const absolute = join(folder, relative)
    let names: string[]
    try {
      names = await readdir(absolute)
    } catch {
      return
    }
    for (const name of names) {
      if (out.length >= limit) return
      if (name.startsWith('.')) continue
      const child = relative.length === 0 ? name : `${relative}/${name}`
      const extension = extname(name).toLowerCase()
      if (extension === '.html' || extension === '.htm') {
        out.push(child)
        continue
      }
      if (depth >= 2) continue
      let isDir = false
      try {
        isDir = (await stat(join(folder, child))).isDirectory()
      } catch {
        isDir = false
      }
      if (isDir) await scan(child, depth + 1)
    }
  }
  await scan('', 0)
  return out
}

/**
 * Does this on-disk page reference a local asset the folder does not have?
 *
 * The disk twin of the tar scanner in `bundle.ts`: a page that references
 * `/assets/app.js` but ships no such file opens to a spinner, and a spinner
 * looks *worse* than an honest descriptor page because it pretends to be ready.
 * Same rules as there — external URLs, protocol-relative, hashes and data: URIs
 * are ignored; every other `src`/`href` must resolve inside the folder.
 */
export async function referencesMissingAssetsOnDisk(path: string): Promise<boolean> {
  let html: string
  try {
    html = await readFile(path, 'utf8')
  } catch {
    return false
  }
  const directory = dirname(path)
  const references = new Set<string>()
  for (const match of html.matchAll(/(?:src|href)\s*=\s*"([^"]*)"/gi)) {
    const raw = (match[1] ?? '').trim()
    if (raw.length === 0) continue
    if (/^(?:[a-z]+:|\/\/|#|data:)/i.test(raw)) continue
    references.add(raw.replace(/^\.\//, '').replace(/[?#].*$/, ''))
  }
  for (const reference of references) {
    const parts = directory.split(sep).concat(reference.replace(/\//g, sep).split(sep))
    const stack: string[] = []
    for (const part of parts) {
      if (part === '' || part === '.') continue
      if (part === '..') stack.pop()
      else stack.push(part)
    }
    try {
      await stat(stack.join(sep))
    } catch {
      return true
    }
  }
  return false
}

/**
 * Serve a window from its inline copy, for artifacts that never had a folder.
 *
 * Imported bundles and market downloads keep their HTML in the ledger rather
 * than on disk, because the user never chose a folder for them. The rule is
 * "file wins": this is only consulted after the on-disk read has already failed,
 * so a model that later writes a real file into the folder takes over cleanly.
 *
 * Only the entry document is served this way. A multi-file artifact needs a
 * folder, which is exactly what the build prompt asks the model to produce.
 */
export function inlineArtifact(window: ForgeWindow, relative: string): ArtifactResult {
  if (window.inlineHtml === undefined || window.inlineHtml.length === 0) {
    return { kind: 'missing', reason: 'this window has no artifact yet' }
  }
  const trimmed = relative.replace(/^([/\\])+/, '')
  const entry = window.entry.replace(/^([/\\])+/, '')
  // A nested request cannot be satisfied from a single inline document, and
  // answering it with the entry page would make a broken `<img src>` render as
  // a full HTML page inside an image box.
  if (trimmed.length > 0 && trimmed !== entry) {
    return { kind: 'missing', reason: 'this window is a single inline document' }
  }
  return {
    kind: 'file',
    path: entry.length > 0 ? entry : 'index.html',
    contentType: 'text/html; charset=utf-8',
    bytes: Buffer.from(window.inlineHtml, 'utf8'),
  }
}

/**
 * A dependency-free `.tgz` reader for workbench packages.
 *
 * The market ships workbenches as npm-style tarballs and the Host has to unpack
 * them in-process. Pulling in `node-tar` would add a third-party dependency to a
 * plugin that runs inside the user's harness, so this module implements only the
 * slice of the format a package tarball actually uses, on top of `node:zlib`.
 *
 * The input is untrusted, so two properties matter more than format coverage:
 *
 *   - **No escaping path ever leaves this module.** An absolute name, a `..`
 *     segment, or a backslash rejects the whole archive instead of being
 *     sanitised entry by entry. The caller therefore never re-checks paths, and
 *     a hostile tarball cannot write outside the folder it is unpacked into.
 *   - **Everything is bounded.** Inflated size and entry count are capped, so a
 *     gzip bomb fails the download instead of the Host.
 *
 * Metadata headers (pax `x`/`g`, GNU `L`) are consumed and skipped rather than
 * rejected: real tarballs use them, and only the names they carry matter. Those
 * names are applied to the entry that follows.
 */
import { gunzipSync } from 'node:zlib'

/** One extracted archive entry. */
export interface TarEntry {
  /** POSIX-style relative path, e.g. `package/package.json`. */
  readonly path: string
  readonly bytes: Uint8Array
  /** True when the entry is a directory (bytes is empty). */
  readonly directory: boolean
}

/** Why an archive was rejected. */
export type TarFailure =
  | 'not-gzip'
  | 'not-tar'
  | 'truncated'
  | 'too-large'
  | 'unsafe-path'
  | 'too-many-entries'

/** The outcome of {@link extractTarball}: the entries, or the reason it refused. */
export type TarResult =
  | { readonly ok: true; readonly entries: readonly TarEntry[] }
  | { readonly ok: false; readonly reason: TarFailure; readonly detail?: string }

/** One tar header is always exactly this many bytes. */
const BLOCK_SIZE = 512

/** Inflated-size ceiling; a package tarball is a few hundred KiB in practice. */
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024

/** Entry ceiling; the largest real workbench tarball holds a few hundred files. */
const DEFAULT_MAX_ENTRIES = 4096

/** Shared empty payload for directory entries. */
const EMPTY_BYTES = new Uint8Array(0)

/** Header fields are NUL-terminated byte strings; names are UTF-8 in practice. */
const utf8 = new TextDecoder('utf-8', { fatal: false })

/** Build a failed result, omitting `detail` when there is nothing to report. */
function failure(reason: TarFailure, detail?: string): TarResult {
  return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail }
}

/** The original message of a thrown value, for `detail`. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `node:zlib` signals its output cap with an error rather than a return value. */
function isOutputTooLarge(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = (error as { code?: unknown }).code
  if (code === 'ERR_BUFFER_TOO_LARGE') return true
  // The wording differs across Node releases, so the message is only a fallback;
  // the error code above is what current versions actually set.
  const message = error instanceof Error ? error.message : ''
  return /maximum output length|maxOutputLength|larger than .* bytes|too large/i.test(message)
}

/** Read a NUL-terminated header field as UTF-8. */
function readField(bytes: Uint8Array, offset: number, length: number): string {
  const end = Math.min(bytes.byteLength, offset + length)
  let stop = offset
  while (stop < end && (bytes[stop] ?? 0) !== 0) stop += 1
  return utf8.decode(bytes.subarray(offset, stop))
}

/**
 * Read a payload as a NUL-terminated UTF-8 string, which is how GNU stores a long
 * name. Slicing bytes rather than decoding the whole block keeps the name from
 * being extended by whatever follows the terminator.
 */
function readCString(bytes: Uint8Array, start: number, end: number): string {
  let stop = start
  while (stop < end && (bytes[stop] ?? 0) !== 0) stop += 1
  return utf8.decode(bytes.subarray(start, stop))
}

/** Parse an octal (or GNU base-256) numeric header field. */
function parseNumber(bytes: Uint8Array, offset: number, length: number): number | undefined {
  const first = bytes[offset] ?? 0
  if ((first & 0x80) !== 0) {
    let value = first & 0x7f
    for (let index = 1; index < length; index += 1) {
      value = value * 256 + (bytes[offset + index] ?? 0)
      if (!Number.isSafeInteger(value)) return undefined
    }
    return value
  }
  const text = readField(bytes, offset, length).trim()
  if (text.length === 0) return 0
  if (!/^[0-7]+$/.test(text)) return undefined
  const value = Number.parseInt(text, 8)
  return Number.isSafeInteger(value) ? value : undefined
}

/** A block of 512 zero bytes marks the end of the archive. */
function isZeroBlock(bytes: Uint8Array, offset: number): boolean {
  for (let index = 0; index < BLOCK_SIZE; index += 1) {
    if ((bytes[offset + index] ?? 0) !== 0) return false
  }
  return true
}

/** ustar splits long names between a `prefix` field and the short `name` field. */
function joinHeaderName(prefix: string, name: string): string {
  return prefix.length > 0 ? `${prefix}/${name}` : name
}

/**
 * Canonicalise an entry name.
 *
 * Leading `./` is noise (both npm and GitHub add it), and a trailing slash on a
 * directory carries no information once `directory` is known.
 */
function normalizeName(raw: string): string {
  let name = raw
  while (name.startsWith('./')) name = name.slice(2)
  while (name.endsWith('/')) name = name.slice(0, -1)
  return name
}

/**
 * Reject the three shapes that could escape the extraction folder.
 *
 * Checked per archive rather than per entry: a tarball with one hostile name is
 * a hostile tarball, and the caller should not have to reason about which
 * entries it may trust.
 */
function isUnsafeName(name: string): boolean {
  if (name.startsWith('/')) return true
  if (name.includes('\\')) return true
  return name.split('/').includes('..')
}

/** Byte-wise search, because pax lengths count bytes rather than characters. */
function indexOfByte(bytes: Uint8Array, start: number, end: number, byte: number): number {
  for (let index = start; index < end; index += 1) {
    if ((bytes[index] ?? 0) === byte) return index
  }
  return -1
}

/**
 * Extract the `path=` record from a pax extended header.
 *
 * Pax records are `"<length> <key>=<value>\n"` where the length counts itself in
 * *bytes*, which is why the walk stays on the raw payload: decoding first would
 * misplace every record after a multi-byte character.
 */
function paxPath(bytes: Uint8Array, start: number, end: number): string | undefined {
  let cursor = start
  while (cursor < end) {
    const space = indexOfByte(bytes, cursor, end, 0x20)
    if (space === -1) return undefined
    const length = Number.parseInt(utf8.decode(bytes.subarray(cursor, space)), 10)
    if (!Number.isSafeInteger(length) || length <= 0) return undefined
    // A record ends exactly `length` bytes after its own start, so the trailing
    // newline is stripped by position rather than by searching for one.
    const recordEnd = cursor + length
    if (recordEnd > end) return undefined
    const equals = indexOfByte(bytes, space + 1, recordEnd, 0x3d)
    if (equals === -1) return undefined
    const key = utf8.decode(bytes.subarray(space + 1, equals))
    let valueEnd = recordEnd
    while (valueEnd > equals + 1) {
      const last = bytes[valueEnd - 1] ?? 0
      if (last === 0x0a || last === 0) valueEnd -= 1
      else break
    }
    if (key === 'path') return utf8.decode(bytes.subarray(equals + 1, valueEnd))
    cursor = recordEnd
  }
  return undefined
}

/** A decompressed payload, or why zlib refused it. */
type Inflated =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly tooLarge: boolean; readonly message: string }

/**
 * Gunzip with the output capped inside zlib.
 *
 * A gzip bomb has to fail before its bytes are materialised, which is why the cap
 * is passed to `gunzipSync` rather than checked afterwards. `maxOutputLength: 0`
 * means "no limit" to zlib, so a zero budget becomes one byte.
 */
function inflate(input: Uint8Array, maxBytes: number): Inflated {
  try {
    const decompressed = gunzipSync(input, { maxOutputLength: maxBytes > 0 ? maxBytes + 1 : 1 })
    // Re-wrap as a plain `Uint8Array` rather than keeping the `Buffer`: `Buffer`
    // overrides `slice` to return a view, and entries below rely on `slice`
    // copying so one entry cannot pin the whole inflated archive.
    return {
      ok: true,
      bytes: new Uint8Array(decompressed.buffer, decompressed.byteOffset, decompressed.byteLength),
    }
  } catch (error) {
    return { ok: false, tooLarge: isOutputTooLarge(error), message: describe(error) }
  }
}

/** Decompress a `.tgz` payload and parse its tar entries. */
export function extractTarball(
  input: Uint8Array,
  options: { maxBytes?: number; maxEntries?: number } = {},
): TarResult {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  const decompressed = inflate(input, maxBytes)
  if (!decompressed.ok) {
    return decompressed.tooLarge
      ? failure('too-large', `the archive inflates past ${maxBytes} bytes`)
      : failure('not-gzip', decompressed.message)
  }
  const inflated = decompressed.bytes
  if (inflated.byteLength > maxBytes) {
    return failure(
      'too-large',
      `the archive inflates to ${inflated.byteLength} bytes, over the ${maxBytes} byte limit`,
    )
  }
  // A payload that cannot even hold one header block has no `ustar` magic to
  // check, so it is not a tar archive at all rather than a truncated one.
  if (inflated.byteLength < BLOCK_SIZE) {
    return failure('not-tar', 'the payload is shorter than one tar header block')
  }

  const entries: TarEntry[] = []
  let offset = 0
  let zeroBlocks = 0
  let ended = false
  // Counts every header that names an entry, including kinds that are skipped, so
  // an archive cannot dodge the entry cap by filling itself with symlinks.
  let seen = 0
  // A pax or GNU header names the entry that follows it, so the name is carried
  // across one loop iteration instead of being attached to the metadata header.
  let pendingName: string | undefined

  while (offset + BLOCK_SIZE <= inflated.byteLength) {
    if (isZeroBlock(inflated, offset)) {
      zeroBlocks += 1
      offset += BLOCK_SIZE
      if (zeroBlocks >= 2) {
        ended = true
        break
      }
      continue
    }
    zeroBlocks = 0
    const magic = readField(inflated, offset + 257, 6)
    if (!magic.startsWith('ustar')) {
      return failure('not-tar', `the ustar magic is missing at offset ${offset}`)
    }
    const size = parseNumber(inflated, offset + 124, 12)
    if (size === undefined || size < 0) {
      return failure('not-tar', `the size field is invalid at offset ${offset}`)
    }
    const dataStart = offset + BLOCK_SIZE
    const dataEnd = dataStart + size
    if (dataEnd > inflated.byteLength) {
      return failure('truncated', `entry data at offset ${offset} runs past the end of the archive`)
    }
    // Tar pads every payload to a 512-byte boundary, so the next header can only
    // start there. A last entry whose padding was trimmed is tolerated: the bytes
    // it claims are present, and rejecting it would fail archives that unpack fine.
    const advance = Math.min(
      dataStart + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE,
      inflated.byteLength,
    )
    const typeflag = readField(inflated, offset + 156, 1)
    const headerName = joinHeaderName(
      readField(inflated, offset + 345, 155),
      readField(inflated, offset, 100),
    )
    if (typeflag === 'x' || typeflag === 'g' || typeflag === 'L' || typeflag === 'K') {
      // Metadata headers name the entry that follows instead of being one, so they
      // are stepped over here and never counted, named, or extracted. The `K` kind
      // carries the *link* target, which this module does not extract, so it must
      // leave any name an earlier `L` announced intact.
      if (typeflag === 'x') {
        // Only a local pax header can rename the next entry; a global one
        // describes the archive as a whole.
        const path = paxPath(inflated, dataStart, dataEnd)
        if (path !== undefined) pendingName = path
      } else if (typeflag === 'L') {
        const longName = readCString(inflated, dataStart, dataEnd).replace(/\n$/, '')
        if (longName.length > 0) pendingName = longName
      }
    } else {
      seen += 1
      if (seen > maxEntries) {
        return failure('too-many-entries', `the archive holds more than ${maxEntries} entries`)
      }
      // The name check runs for every entry kind, not only the ones that are
      // extracted: a hostile name means the archive is hostile, and callers must
      // not have to reason about which entry types they were handed.
      const name = normalizeName(pendingName ?? headerName)
      pendingName = undefined
      if (name.length > 0) {
        if (isUnsafeName(name)) return failure('unsafe-path', name)
        if (typeflag === '5') {
          entries.push({ path: name, bytes: EMPTY_BYTES, directory: true })
        } else if (typeflag === '0' || typeflag === '') {
          // `slice`, not `subarray`: each entry owns its bytes instead of keeping
          // the whole inflated archive alive through one small view.
          entries.push({ path: name, bytes: inflated.slice(dataStart, dataEnd), directory: false })
        }
        // Symlinks, devices and other kinds are never extracted; they were only
        // stepped over so `offset` stayed in sync.
      }
    }
    offset = advance
  }
  if (!ended && offset < inflated.byteLength) {
    return failure('truncated', 'the archive ends in a partial block')
  }
  return { ok: true, entries }
}

/**
 * Strip a single shared top-level directory from the entry list.
 *
 * npm and GitHub tarballs wrap everything in one directory (`package/`) and the
 * caller wants paths relative to the package root. When the entries do not share
 * exactly one top-level directory they are returned unchanged, so the caller can
 * decide what that layout means instead of this function guessing.
 */
export function selectPackageRoot(entries: readonly TarEntry[]): readonly TarEntry[] {
  if (entries.length === 0) return entries
  let root: string | undefined
  for (const entry of entries) {
    const slash = entry.path.indexOf('/')
    if (slash === -1) {
      // A bare file at the top level means there is no single package folder.
      if (!entry.directory) return entries
      if (root === undefined) root = entry.path
      else if (root !== entry.path) return entries
      continue
    }
    const top = entry.path.slice(0, slash)
    if (top.length === 0) return entries
    if (root === undefined) root = top
    else if (root !== top) return entries
  }
  if (root === undefined) return entries
  const prefix = `${root}/`
  const stripped: TarEntry[] = []
  for (const entry of entries) {
    if (!entry.path.startsWith(prefix)) continue
    const path = entry.path.slice(prefix.length)
    if (path.length === 0) continue
    stripped.push({ path, bytes: entry.bytes, directory: entry.directory })
  }
  return stripped
}

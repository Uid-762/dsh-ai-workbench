/**
 * The dsh-desktop workbench market: catalog fetch, validation, and download.
 *
 * The market is a static `index.json` plus tarballs hosted on GitHub and npm, and
 * this module is the only place the plugin talks to it. Two decisions shape it:
 *
 *   - **No network of its own.** `fetch` is injected (`FetchLike`) and defaults to
 *     the global one, so the whole path can be exercised offline in tests and the
 *     shell can hand in a proxied fetch later without touching this file.
 *   - **Fail closed.** The catalog decides what the user may install, so one
 *     malformed entry rejects the whole index instead of being dropped quietly: a
 *     partial catalog would make "this workbench is missing" and "this workbench
 *     was tampered with" look identical to the user.
 *
 * Nothing here touches the filesystem; unpacking is `tar.ts`'s job, and this
 * module returns the raw tarball bytes untouched.
 */

import { createHash } from 'node:crypto'

/** Distribution kinds the dsh-desktop catalog allows. */
export type MarketDistributionType = 'npm' | 'github-release' | 'github-source'

/** How one workbench is published. */
export interface MarketDistribution {
  readonly type: MarketDistributionType
  readonly version: string
  /**
   * The catalog's own download address. Real entries always publish one, and it
   * is authoritative: the release asset is often just `<repository>.tgz` with no
   * version in it, so a URL rebuilt from parts 404s. Deriving one is only the
   * fallback for a hand-built entry.
   */
  readonly url?: string
  /** SHA-256 of the published tarball, when the catalog lists one. */
  readonly sha256?: string
  /** Size of the published tarball, when the catalog lists one. */
  readonly bytes?: number
  /** Commit the source distribution was built from. */
  readonly commit?: string
  /** npm package name; defaults to the repository name when omitted. */
  readonly name?: string
  /** GitHub release asset name; defaults to `<repository>-<version>.tgz`. */
  readonly asset?: string
}

/** A screenshot shown on the workbench's market page. */
export interface MarketScreenshot {
  readonly url: string
  readonly alt?: string
}

/** One installable workbench. */
export interface MarketWorkbench {
  /** Lower-case `owner/repository`. */
  readonly id: string
  readonly owner: string
  readonly repository: string
  /** `https://github.com/<id>`. */
  readonly url: string
  readonly name: string
  readonly category: string
  readonly description: { readonly zh?: string; readonly en?: string }
  readonly version: string
  readonly license?: string
  readonly distribution: MarketDistribution
  readonly screenshots?: readonly MarketScreenshot[]
}

/** A category row in the market's filter bar. */
export interface MarketCategory {
  readonly id: string
  readonly name: { readonly zh?: string; readonly en?: string }
}

/** The validated catalog index. */
export interface MarketCatalog {
  readonly schemaVersion: number
  readonly kind: string
  readonly categories: readonly MarketCategory[]
  readonly workbenches: readonly MarketWorkbench[]
}

/** Why a market request was rejected. */
export type MarketFailure =
  | 'network'
  | 'timeout'
  | 'http-status'
  | 'too-large'
  | 'bad-json'
  | 'bad-schema'
  | 'not-found'

/** The outcome of a market operation. */
export type MarketResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: MarketFailure; readonly detail?: string }

/** The published catalog location. */
export const DEFAULT_CATALOG_URL = 'https://market.dshdesktop.com/index.json'

/** Catalogs are a few KiB; anything past this is not a catalog. */
export const MAX_CATALOG_BYTES = 2 * 1024 * 1024

/** No single request should hang the panel for longer than this. */
export const FETCH_TIMEOUT_MS = 30_000

/**
 * Longer budget for the mirror retry, measured rather than guessed.
 *
 * The direct GitHub request is aborted after 30s so the panel degrades quickly,
 * but that leaves the mirror almost no working time: a UK relay of a 6.6 MB
 * release asset takes 10-90s on the networks where the direct path is blocked
 * (measured: gh-proxy.com served `dsh-site-selection` v1.2.2 in 9.9s with a
 * byte-identical SHA-256, and `dsh-contract-review-workbench` in 15.2s).
 * Reusing the same 30s for the relay is what turned a recoverable download into
 * `did not finish within 30000ms` / `fetch failed`. The catalog's SHA-256 is
 * still verified on the returned bytes, so a longer window only costs patience.
 */
export const PROXY_FETCH_TIMEOUT_MS = 180_000

/** Workbench tarballs are small; the cap keeps a hostile download bounded. */
const MAX_WORKBENCH_BYTES = 16 * 1024 * 1024

/** Cap for one proxied screenshot — generous for a marketing image, tight enough
 * that a poisoned answer cannot tie up memory. */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024

/** Shared empty body for responses whose status was not OK. */
const EMPTY_BYTES = new Uint8Array(0)

/** A `fetch`-shaped function; injected so this module stays testable and dependency-free. */
export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{
  ok: boolean
  status: number
  arrayBuffer(): Promise<ArrayBuffer>
  text(): Promise<string>
}>

/** Optional overrides for every market request. */
export interface MarketOptions {
  readonly fetch?: FetchLike
  readonly timeoutMs?: number
  readonly maxCatalogBytes?: number
  /**
   * Prefix proxy retried when a direct GitHub download fails.
   *
   * Not a mirror and not a trust decision: it only re-sends the same request to
   * the same GitHub path through a relay, and the catalog's published SHA-256 is
   * still verified against whatever comes back. Empty disables the retry.
   */
  readonly proxy?: string
}

/** A settled promise, used to keep every `await` inside one failure vocabulary. */
type Attempt<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown }

/**
 * The default `fetch` adapter.
 *
 * Wrapped in an arrow so the module reads the global lazily: the Host may install
 * a polyfill after this module is imported.
 */
const defaultFetch: FetchLike = async (url, init) => {
  const response = await globalThis.fetch(url, init)
  return {
    ok: response.ok,
    status: response.status,
    arrayBuffer: () => response.arrayBuffer(),
    text: () => response.text(),
  }
}

/** Build a failed result, omitting `detail` when there is nothing to report. */
function failure(
  reason: MarketFailure,
  detail?: string,
): { readonly ok: false; readonly reason: MarketFailure; readonly detail?: string } {
  return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail }
}

/** The original message of a thrown value, for `detail`. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Run one promise-returning step and keep its rejection as data. */
async function attempt<T>(task: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await task() }
  } catch (error) {
    return { ok: false, error }
  }
}

/**
 * Settle `task`, but give up as soon as `signal` aborts.
 *
 * The signal is handed to `fetch` as well, yet an injected `FetchLike` is free to
 * ignore it; racing is what makes `timeoutMs` a guarantee rather than a request.
 * The losing branch is still observed, so it cannot surface as an unhandled
 * rejection after the caller has already returned.
 */
function abortable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const onAbort = (): void => {
      if (settled) return
      settled = true
      reject(new Error('the request was aborted'))
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    // The handlers are attached even after an early abort so a request that loses
    // the race still settles somewhere instead of becoming an unhandled rejection.
    task.then(
      (value) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/** A request's timeout budget, shared by the two download paths. */
interface Deadline {
  readonly signal: AbortSignal
  /** True once the timer fired; distinguishes a timeout from a real network error. */
  readonly expired: () => boolean
  readonly stop: () => void
}

/** Start a timeout budget that also aborts the request it is handed to. */
function startDeadline(timeoutMs: number): Deadline {
  const controller = new AbortController()
  let expired = false
  const timer = setTimeout(() => {
    expired = true
    controller.abort()
  }, timeoutMs)
  return {
    signal: controller.signal,
    expired: () => expired,
    stop: () => clearTimeout(timer),
  }
}

/** A completed HTTP exchange: the status, plus the body when the status was OK. */
interface FetchPayload {
  readonly ok: boolean
  readonly status: number
  readonly bytes: Uint8Array
}

/**
 * Fetch a URL and read its body as bytes.
 *
 * Both market requests need the same four failure modes (timeout, network,
 * HTTP status, size), so the order in which they are checked lives here once.
 * A non-OK status is reported as a payload rather than a failure because the two
 * callers disagree about what it means: for a tarball a 404 is "this version was
 * never published", for an index it is a broken catalog URL.
 */
async function fetchBytes(
  url: string,
  accept: string,
  options: MarketOptions,
  maxBytes: number,
): Promise<MarketResult<FetchPayload>> {
  const fetchImpl = options.fetch ?? defaultFetch
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS
  const deadline = startDeadline(timeoutMs)
  try {
    const answered = await attempt(() =>
      abortable(fetchImpl(url, { signal: deadline.signal, headers: { accept } }), deadline.signal),
    )
    if (!answered.ok) {
      return deadline.expired()
        ? failure('timeout', `${url} did not answer within ${timeoutMs}ms`)
        : failure('network', describe(answered.error))
    }
    const response = answered.value
    if (!response.ok) {
      return { ok: true, value: { ok: false, status: response.status, bytes: EMPTY_BYTES } }
    }
    const body = await attempt(() => abortable(response.arrayBuffer(), deadline.signal))
    if (!body.ok) {
      return deadline.expired()
        ? failure('timeout', `${url} did not finish within ${timeoutMs}ms`)
        : failure('network', describe(body.error))
    }
    // `FetchLike` has no streaming reader, so the cap is enforced on the finished
    // body; a chunked reader would be the only way to stop downloading earlier.
    const bytes = new Uint8Array(body.value)
    if (bytes.byteLength > maxBytes) {
      return failure('too-large', `${url} is ${bytes.byteLength} bytes, over ${maxBytes}`)
    }
    return { ok: true, value: { ok: true, status: response.status, bytes } }
  } finally {
    deadline.stop()
  }
}

/** Narrow an untrusted value to a plain object, rejecting arrays and null. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** Read an untrusted value as a list of still-untrusted items. */
function asArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? (value as readonly unknown[]) : undefined
}

/** A non-empty, non-blank string; blank strings are as useless as missing ones. */
function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

/** Read an optional `{ zh, en }` label object, dropping non-string fields. */
function asLocalized(value: unknown): { zh?: string; en?: string } {
  const record = asRecord(value)
  const text: { zh?: string; en?: string } = {}
  if (record !== undefined) {
    if (typeof record.zh === 'string') text.zh = record.zh
    if (typeof record.en === 'string') text.en = record.en
  }
  return text
}

/** Read the optional screenshot list, dropping entries without a usable URL. */
function asScreenshots(value: unknown): readonly MarketScreenshot[] | undefined {
  const items = asArray(value)
  if (items === undefined) return undefined
  const screenshots: MarketScreenshot[] = []
  for (const item of items) {
    const record = asRecord(item)
    if (record === undefined) continue
    const url = asText(record.url)
    if (url === undefined) continue
    screenshots.push(typeof record.alt === 'string' ? { url, alt: record.alt } : { url })
  }
  return screenshots.length > 0 ? screenshots : undefined
}

/** Type guard for the three distribution kinds, so `unknown` narrows properly. */
function isDistributionType(value: unknown): value is MarketDistributionType {
  return value === 'npm' || value === 'github-release' || value === 'github-source'
}

/** Validate an already-parsed JSON value against the catalog contract. */
export function parseCatalog(value: unknown): MarketResult<MarketCatalog> {
  const bad = (detail: string): MarketResult<MarketCatalog> => failure('bad-schema', detail)
  const root = asRecord(value)
  if (root === undefined) return bad('the catalog is not a JSON object')
  if (root.schemaVersion !== 2) return bad('schemaVersion must be 2')
  if (root.kind !== 'catalog') return bad('kind must be "catalog"')
  const items = asArray(root.workbenches)
  if (items === undefined) return bad('workbenches must be an array')

  // Categories are cosmetic; a malformed one is skipped rather than costing the
  // user the whole catalog. Workbench entries below are the fail-closed part.
  const categories: MarketCategory[] = []
  if (root.categories !== undefined) {
    const rawCategories = asArray(root.categories)
    if (rawCategories === undefined) return bad('categories must be an array')
    for (const item of rawCategories) {
      const record = asRecord(item)
      if (record === undefined) continue
      const id = asText(record.id)
      if (id === undefined) continue
      categories.push({ id, name: asLocalized(record.name) })
    }
  }

  const workbenches: MarketWorkbench[] = []
  for (let index = 0; index < items.length; index += 1) {
    const record = asRecord(items[index])
    if (record === undefined) return bad(`#${index}: the workbench entry is not an object`)
    const label = asText(record.id) ?? `#${index}`
    const id = asText(record.id)
    const owner = asText(record.owner)
    const repository = asText(record.repository)
    const name = asText(record.name)
    const version = asText(record.version)
    if (id === undefined) return bad(`${label}: id must be a non-empty string`)
    if (owner === undefined) return bad(`${label}: owner must be a non-empty string`)
    if (repository === undefined) return bad(`${label}: repository must be a non-empty string`)
    if (name === undefined) return bad(`${label}: name must be a non-empty string`)
    if (version === undefined) return bad(`${label}: version must be a non-empty string`)

    const expectedId = `${owner}/${repository}`.toLowerCase()
    if (id !== expectedId) return bad(`${id}: id must be "${expectedId}"`)
    const expectedUrl = `https://github.com/${id}`
    // GitHub owner and repository names are case-insensitive in URLs, and real
    // catalog entries do mix the two (`id: oliverliy/projecthub` publishing
    // `url: …/OliverLiy/projectHub`). Comparing byte-for-byte rejected the one
    // entry and, because the loop is fail-closed, emptied the whole market.
    if (typeof record.url !== 'string' || record.url.toLowerCase() !== expectedUrl.toLowerCase()) {
      return bad(`${id}: url must be "${expectedUrl}"`)
    }

    const rawDistribution = asRecord(record.distribution)
    if (rawDistribution === undefined) return bad(`${id}: distribution must be an object`)
    const type = rawDistribution.type
    if (!isDistributionType(type)) {
      return bad(`${id}: distribution.type must be npm, github-release or github-source`)
    }
    if (rawDistribution.version !== version) {
      return bad(`${id}: distribution.version must equal version`)
    }
    const distributionName = asText(rawDistribution.name)
    const distributionAsset = asText(rawDistribution.asset)
    const publishedUrl = asText(rawDistribution.url)
    const distributionSha = asText(rawDistribution.sha256)
    const distributionBytes =
      typeof rawDistribution.bytes === 'number' && Number.isSafeInteger(rawDistribution.bytes)
        ? rawDistribution.bytes
        : undefined
    const distributionCommit = asText(rawDistribution.commit)
    const distribution: MarketDistribution = {
      type,
      version,
      ...(publishedUrl === undefined ? {} : { url: publishedUrl }),
      ...(distributionSha === undefined ? {} : { sha256: distributionSha }),
      ...(distributionBytes === undefined ? {} : { bytes: distributionBytes }),
      ...(distributionCommit === undefined ? {} : { commit: distributionCommit }),
      ...(distributionName === undefined ? {} : { name: distributionName }),
      ...(distributionAsset === undefined ? {} : { asset: distributionAsset }),
    }

    const license =
      typeof record.license === 'string' && record.license.length > 0 ? record.license : undefined
    const screenshots = asScreenshots(record.screenshots)
    workbenches.push({
      id,
      owner,
      repository,
      url: expectedUrl,
      name,
      category: typeof record.category === 'string' ? record.category : '',
      description: asLocalized(record.description),
      version,
      distribution,
      ...(license === undefined ? {} : { license }),
      ...(screenshots === undefined ? {} : { screenshots }),
    })
  }

  return { ok: true, value: { schemaVersion: 2, kind: 'catalog', categories, workbenches } }
}

/**
 * The git tag for a GitHub *source* download.
 *
 * The catalog stores bare versions (`0.2.1`) while codeload addresses tags, so a
 * bare version gains the project's `v` prefix; one that already carries it must
 * not become `vv0.2.1`.
 */
function tagName(version: string): string {
  return version.startsWith('v') ? version : `v${version}`
}

/** Resolve the tarball URL for one workbench entry. */
export function distributionUrl(entry: MarketWorkbench): string {
  const distribution = entry.distribution
  const version = asText(distribution.version) ?? entry.version
  // The catalog's own URL wins for every distribution kind. Real entries publish
  // `…/releases/download/v0.7.2/cross-platform-account-dashboard.tgz` — no version
  // in the asset name — so rebuilding the path from `<repository>-<version>.tgz`
  // 404s on 13 of the 16 live entries. Deriving a URL stays as the fallback for a
  // hand-built entry that carries no `url`.
  const published = asText(distribution.url)
  if (published !== undefined) {
    if (distribution.type === 'github-source') {
      // A source entry points at the repository, not at an archive, so it still
      // needs converting; the pinned commit is what makes the download reproducible.
      const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)\/?$/.exec(published)
      if (match !== null) {
        const [, owner, repo] = match
        const commit = asText(distribution.commit)
        return `https://codeload.github.com/${owner}/${repo}/tar.gz/${commit ?? tagName(version)}`
      }
      return published
    }
    return published
  }
  if (distribution.type === 'npm') {
    // The catalog may name a package that differs from the repository, so the
    // explicit name wins; otherwise npm-style repos are assumed to match. There is
    // deliberately no further guessing: a package name that cannot be derived is a
    // catalog bug, and downloading from an invented URL would hide it.
    const packageName = asText(distribution.name) ?? entry.repository
    if (packageName.length === 0) {
      throw new RangeError('an npm distribution needs a package name')
    }
    return `https://registry.npmjs.org/${packageName}/-/${packageName}-${version}.tgz`
  }
  if (distribution.type === 'github-release') {
    // The catalog stores bare versions (`0.2.1`) and GitHub release tags carry a
    // `v`; the asset name is only overridden when the catalog names one.
    const asset = asText(distribution.asset) ?? `${entry.repository}-${version}.tgz`
    return `https://github.com/${entry.id}/releases/download/v${version}/${asset}`
  }
  return `https://codeload.github.com/${entry.id}/tar.gz/refs/tags/${tagName(version)}`
}

/** Fetch and validate a catalog index. */
export async function fetchCatalog(
  url: string,
  options: MarketOptions = {},
): Promise<MarketResult<MarketCatalog>> {
  const maxBytes = options.maxCatalogBytes ?? MAX_CATALOG_BYTES
  const fetched = await fetchBytes(url, 'application/json', options, maxBytes)
  if (!fetched.ok) return fetched
  const payload = fetched.value
  if (!payload.ok) {
    return failure('http-status', `${url} answered HTTP ${payload.status}`)
  }
  // Decoded with `fatal` so invalid UTF-8 is reported as a decode failure rather
  // than U+FFFD soup that `JSON.parse` then blames on a misleading position.
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(payload.bytes)
  } catch (error) {
    return failure('bad-json', describe(error))
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return failure('bad-json', describe(error))
  }
  return parseCatalog(parsed)
}

/**
 * Fetch one screenshot image, bounded.
 *
 * The browser cannot load these directly on the networks this plugin is used on:
 * `raw.githubusercontent.com` is frequently DNS-poisoned or unreachable from
 * mainland China while the catalog host answers fine — the user sees a card with
 * a caption but a blank picture. The Host fetches the image instead, with the
 * same prefix-proxy retry the tarball download uses, and serves it same-origin.
 */
export async function fetchImage(
  url: string,
  options: MarketOptions & { maxBytes?: number } = {},
): Promise<MarketResult<Uint8Array>> {
  const maxBytes = options.maxBytes ?? MAX_IMAGE_BYTES
  const accept = 'image/png, image/jpeg, image/webp, image/gif, image/svg+xml, */*'
  let fetched = await fetchBytes(url, accept, options, maxBytes)
  const proxy = (options.proxy ?? '').trim()
  const transportFailure =
    !fetched.ok && (fetched.reason === 'network' || fetched.reason === 'timeout')
  // Same relay rule as the tarball path: only GitHub hosts go through the proxy,
  // and only for a transport failure — a 404 from the origin is a real answer
  // ("the catalog points at a screenshot that no longer exists").
  if (transportFailure && proxy.length > 0 && /^https:\/\/raw\.githubusercontent\.com\//.test(url)) {
    const relayed = await fetchBytes(`${proxy}/${url}`, accept, {
      ...options,
      timeoutMs: Math.max(options.timeoutMs ?? 0, PROXY_FETCH_TIMEOUT_MS),
    }, maxBytes)
    if (relayed.ok) fetched = relayed
  }
  if (!fetched.ok) return fetched
  const payload = fetched.value
  if (!payload.ok) {
    return payload.status === 404
      ? failure('not-found', url)
      : failure('http-status', `${url} answered HTTP ${payload.status}`)
  }
  return { ok: true, value: payload.bytes }
}

/** Download one workbench tarball (bounded; the bytes are not unpacked here). */
export async function downloadWorkbench(entry: MarketWorkbench,
  options: MarketOptions & { maxBytes?: number } = {},
): Promise<MarketResult<Uint8Array>> {
  let url: string
  try {
    url = distributionUrl(entry)
  } catch (error) {
    // Only reachable for a hand-built entry; a catalog entry always names its
    // repository, so this reports the entry as malformed rather than throwing.
    return failure('bad-schema', describe(error))
  }
  const maxBytes = options.maxBytes ?? MAX_WORKBENCH_BYTES
  const accept = 'application/gzip, application/octet-stream'
  let fetched = await fetchBytes(url, accept, options, maxBytes)
  // GitHub is the one host this market cannot avoid and the one most likely to be
  // unreachable: release assets and codeload routinely time out from mainland
  // China while npm and the catalog answer fine. So one retry goes through the
  // prefix proxy, and only for a transport failure — an HTTP status is the origin's
  // answer and is reported as such rather than retried.
  const proxy = (options.proxy ?? '').trim()
  const transportFailure =
    !fetched.ok && (fetched.reason === 'network' || fetched.reason === 'timeout')
  if (transportFailure && proxy.length > 0 && /^https:\/\/(?:codeload\.)?github\.com\//.test(url)) {
    // The relay gets its own, longer budget (see PROXY_FETCH_TIMEOUT_MS): the
    // direct request stays fast so the panel degrades quickly, while the mirror
    // is given the 10-90s a 6 MB release asset actually needs on this network.
    const relayed = await fetchBytes(`${proxy}/${url}`, accept, {
      ...options,
      timeoutMs: Math.max(options.timeoutMs ?? 0, PROXY_FETCH_TIMEOUT_MS),
    }, maxBytes)
    const directReason: MarketFailure | undefined =
      fetched.ok ? undefined : fetched.reason
    if (relayed.ok) {
      fetched = relayed
    } else if (directReason === 'timeout' && relayed.reason === 'timeout') {      // Both budgets ran out. Reporting the direct URL is right — it is what the
      // user's own network blocks — but a 180s mirror that also stalled is worth
      // its own line, otherwise the panel says "github.com timed out" when the
      // relay never finished either.
      return failure('timeout',
        `${url} did not finish within ${options.timeoutMs ?? FETCH_TIMEOUT_MS}ms, ` +
        `and the mirror did not finish within ${PROXY_FETCH_TIMEOUT_MS}ms`)
    }
  }
  if (!fetched.ok) return fetched
  const payload = fetched.value
  if (!payload.ok) {
    // A 404 is the normal "this version was never published" answer, and the panel
    // shows it as a missing release rather than as a broken network.
    return payload.status === 404
      ? failure('not-found', url)
      : failure('http-status', `${url} answered HTTP ${payload.status}`)
  }
  // A published digest is the catalog's own tamper check, so it is verified before
  // the bytes reach the unpacker. Skipping it would let a modified release install
  // as if it were the reviewed one.
  const expected = asText(entry.distribution.sha256)
  if (expected !== undefined) {
    const actual = createHash('sha256').update(payload.bytes).digest('hex')
    if (actual !== expected.toLowerCase()) {
      return failure('bad-schema', `${entry.id}: the download does not match the catalog's sha256`)
    }
  }
  return { ok: true, value: payload.bytes }
}

import type { ConnectionConfig } from '@solana/web3.js'

// RPC failover for ConnectionConfig.fetch. One wrapper per cluster: it owns an
// ordered endpoint list (primary first) and remembers which one last answered.

export type RpcFetch = NonNullable<ConnectionConfig['fetch']>

/** Backoff before each retry of an HTTP 429 (rate limited) answer from the first endpoint tried. */
export const RATE_LIMIT_RETRIES_MS: readonly number[] = [600, 1200]

/**
 * After a failover, the endpoint that answered is tried first for this long;
 * then the primary (usually the operator's own provider) gets another chance.
 */
export const PREFER_HEALTHY_MS = 60_000

/**
 * Each attempt (one endpoint: headers and the whole body) gives up after this
 * long and counts as a network error: the next endpoint is tried, or the
 * request fails. Browser fetch has no timeout of its own, so without this a
 * node that accepts the connection but never answers would hang the app.
 */
export const RPC_ATTEMPT_TIMEOUT_MS = 15_000

/** Thrown (and failed over) when an attempt exceeds its timeout. */
export class RpcTimeoutError extends Error {
  constructor(ms: number) {
    super(`RPC request timed out after ${Math.round(ms / 1000)} s`)
    this.name = 'RpcTimeoutError'
  }
}

export interface FailoverFetchOptions {
  /** Primary endpoint first, then fallbacks in order. */
  endpoints: readonly string[]
  /** Underlying fetch (default: globalThis.fetch). */
  fetch?: typeof globalThis.fetch
  rateLimitRetriesMs?: readonly number[]
  preferHealthyMs?: number
  /** Per-attempt timeout (default RPC_ATTEMPT_TIMEOUT_MS); 0 → none. */
  attemptTimeoutMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface FailoverFetch extends RpcFetch {
  /** The endpoint the next request will try first. */
  activeEndpoint(): string
}

/**
 * HTTP answers that mean "this endpoint can't serve us right now" (bad or
 * revoked API key, credits used up, wrong path, overloaded…). JSON-RPC level
 * errors come back as HTTP 200, so these never mask a method-level error.
 */
const FAILOVER_STATUSES: ReadonlySet<number> = new Set([401, 402, 403, 404, 408, 410, 429])
export function isFailoverStatus(status: number): boolean {
  return FAILOVER_STATUSES.has(status) || status >= 500
}

function normalize(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

function urlOf(input: unknown): string | null {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return null
}

function isAbort(err: unknown, init: RequestInit | undefined): boolean {
  if (init?.signal?.aborted) return true
  return Boolean(err && typeof err === 'object' && (err as { name?: unknown }).name === 'AbortError')
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Null-body statuses can't be rebuilt with a body. */
const NULL_BODY = new Set([101, 103, 204, 205, 304])

/** Reads the whole body now (inside the attempt's timeout) and returns an equivalent Response. */
async function buffered(res: Response): Promise<Response> {
  if (typeof res?.text !== 'function' || res.status < 200 || res.status > 599) return res
  const text = await res.text()
  return new Response(NULL_BODY.has(res.status) ? null : text, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  })
}

/**
 * A fetch for web3.js that tries the preferred endpoint and, on a network
 * error, a timeout (RPC_ATTEMPT_TIMEOUT_MS) or an HTTP 5xx / 401 / 402 / 403 /
 * 404 / 408 / 410 / 429 (429 only after a short backoff on the
 * first endpoint tried), re-sends the exact same request (same body, same
 * init) to the next endpoint in the list. The request body is never touched,
 * so re-sending a signed transaction to another endpoint is the same
 * transaction (same signature; it can land at most once).
 *
 * When every endpoint fails, the first endpoint's HTTP answer is returned
 * (e.g. its 429, so the app can say "rate limited"); with no HTTP answer at
 * all, the first network error is rethrown. Requests for URLs outside the
 * list (or with a single endpoint) are passed through with only the 429
 * backoff and the per-attempt timeout.
 */
export function createFailoverFetch(options: FailoverFetchOptions): FailoverFetch {
  const endpoints = options.endpoints.map((e) => e.trim()).filter((e) => e.length > 0)
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args))
  const retries = options.rateLimitRetriesMs ?? RATE_LIMIT_RETRIES_MS
  const preferMs = options.preferHealthyMs ?? PREFER_HEALTHY_MS
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep
  const timeoutMs = options.attemptTimeoutMs ?? RPC_ATTEMPT_TIMEOUT_MS

  let preferred = 0
  let preferredUntil = 0

  /**
   * One request to one endpoint, bounded by `timeoutMs` (headers + body). The
   * caller's signal still aborts it; a timeout aborts the underlying fetch and
   * rejects with RpcTimeoutError. Same body; only the signal is ours.
   */
  const attempt = async (url: string | URL | Request, init: RequestInit | undefined): Promise<Response> => {
    if (!(timeoutMs > 0) || !Number.isFinite(timeoutMs)) return doFetch(url, init)
    const controller = new AbortController()
    const outer = init?.signal ?? null
    const onOuterAbort = () => controller.abort(outer?.reason)
    if (outer?.aborted) controller.abort(outer.reason)
    else outer?.addEventListener('abort', onOuterAbort, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new RpcTimeoutError(timeoutMs)
        reject(err)
        controller.abort(err)
      }, timeoutMs)
    })
    try {
      return await Promise.race([
        (async () => buffered(await doFetch(url, { ...init, signal: controller.signal })))(),
        timeout,
      ])
    } finally {
      clearTimeout(timer)
      outer?.removeEventListener('abort', onOuterAbort)
    }
  }

  const fetchWithShortRetry = async (url: string | URL | Request, init: RequestInit | undefined): Promise<Response> => {
    let res = await attempt(url, init)
    for (const wait of retries) {
      if (res.status !== 429) break
      await sleep(wait)
      if (init?.signal?.aborted) break
      res = await attempt(url, init)
    }
    return res
  }

  const startIndex = () => (preferred !== 0 && now() < preferredUntil ? preferred : 0)

  const wrapped = (async (input: Parameters<RpcFetch>[0], init?: Parameters<RpcFetch>[1]) => {
    const requestInit = init as RequestInit | undefined
    const url = urlOf(input)
    const listed = url === null ? -1 : endpoints.findIndex((e) => normalize(e) === normalize(url))
    if (listed === -1 || endpoints.length < 2) {
      return fetchWithShortRetry(input as string | URL | Request, requestInit)
    }

    const start = startIndex()
    const order = endpoints.map((_, k) => (start + k) % endpoints.length)
    let firstResponse: Response | null = null
    let firstError: unknown = null

    for (const [k, idx] of order.entries()) {
      if (k > 0 && requestInit?.signal?.aborted) break
      try {
        const res =
          k === 0 ? await fetchWithShortRetry(endpoints[idx], requestInit) : await attempt(endpoints[idx], requestInit)
        if (!isFailoverStatus(res.status)) {
          if (k > 0) {
            // Failed over: stick with the endpoint that answered for a while.
            preferred = idx
            preferredUntil = idx === 0 ? 0 : now() + preferMs
          }
          return res
        }
        firstResponse ??= res
      } catch (err) {
        if (isAbort(err, requestInit)) throw err
        if (firstError === null) firstError = err
      }
    }

    if (firstResponse) return firstResponse
    throw firstError ?? new Error('RPC request failed')
  }) as FailoverFetch

  wrapped.activeEndpoint = () => endpoints[startIndex()] ?? ''
  return wrapped
}

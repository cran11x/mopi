// @vitest-environment node
import { Connection, Keypair } from '@solana/web3.js'
import { describe, expect, it, vi } from 'vitest'
import { readRpcFallbacks, defaultMainnetFallbacks, DEFAULT_MAINNET_RPC_FALLBACK } from '../../config'
import { PREFER_HEALTHY_MS, RPC_ATTEMPT_TIMEOUT_MS, RpcTimeoutError, createFailoverFetch, isFailoverStatus } from './rpc'

const A = 'https://primary.example'
const B = 'https://fallback-one.example'
const C = 'https://fallback-two.example'

type Answer = number | 'network' | ((body: string) => Response)

/** A fake fetch: per endpoint, a queue of answers (the last one repeats). */
function fakeFetch(plan: Record<string, Answer[]>) {
  const calls: Array<{ url: string; body: string; init: RequestInit | undefined }> = []
  const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const body = String(init?.body)
    calls.push({ url, body, init })
    const queue = plan[url] ?? ['network']
    const answer = queue.length > 1 ? queue.shift()! : queue[0]
    if (answer === 'network') throw new TypeError('Failed to fetch')
    if (typeof answer === 'function') return answer(body)
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: '1', result: `${url}:${answer}` }), { status: answer })
  })
  return { fn, calls }
}

function setup(plan: Record<string, Answer[]>, endpoints = [A, B, C]) {
  let clock = 1_000_000
  const sleeps: number[] = []
  const { fn, calls } = fakeFetch(plan)
  const f = createFailoverFetch({
    endpoints,
    fetch: fn as unknown as typeof fetch,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
  })
  const init = { method: 'POST', body: '{"jsonrpc":"2.0","id":"1","method":"getBalance","params":["x"]}' }
  return {
    f,
    calls,
    sleeps,
    init,
    advance: (ms: number) => (clock += ms),
    call: () => f(A, init as never),
  }
}

describe('isFailoverStatus', () => {
  it('fails over on endpoint-level answers (bad key, no credits, wrong path, timeout, rate limit, 5xx) only', () => {
    for (const s of [401, 402, 403, 404, 408, 410, 429, 500, 502, 503, 504, 524]) expect(isFailoverStatus(s)).toBe(true)
    // 200 carries JSON-RPC errors; 400 / 413 are about the request itself.
    for (const s of [200, 400, 405, 413, 415]) expect(isFailoverStatus(s)).toBe(false)
  })
})

describe('createFailoverFetch', () => {
  it('uses the primary while it is healthy (no extra requests)', async () => {
    const t = setup({ [A]: [200] })
    const res = await t.call()
    expect(res.status).toBe(200)
    expect(t.calls.map((c) => c.url)).toEqual([A])
  })

  it('a network error re-sends the exact same request to the next endpoint', async () => {
    const t = setup({ [A]: ['network'], [B]: [200] })
    const res = await t.call()
    expect(res.status).toBe(200)
    expect(t.calls.map((c) => c.url)).toEqual([A, B])
    expect(t.calls[1].body).toBe(t.init.body)
    // Same request (method, body); only the per-attempt timeout signal is added.
    expect(t.calls[1].init).toMatchObject(t.init)
    expect(t.calls[1].init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('a 401 (bad or revoked API key) on the primary fails over', async () => {
    const t = setup({ [A]: [401], [B]: [200] })
    expect((await t.call()).status).toBe(200)
    expect(t.calls.map((c) => c.url)).toEqual([A, B])
  })

  it('HTTP 5xx and 403 fail over immediately; a 429 first gets the short backoff', async () => {
    const t1 = setup({ [A]: [503], [B]: [403], [C]: [200] })
    expect((await t1.call()).status).toBe(200)
    expect(t1.calls.map((c) => c.url)).toEqual([A, B, C])
    expect(t1.sleeps).toEqual([])

    const t2 = setup({ [A]: [429], [B]: [200] })
    expect((await t2.call()).status).toBe(200)
    expect(t2.calls.map((c) => c.url)).toEqual([A, A, A, B])
    expect(t2.sleeps).toEqual([600, 1200])

    // A 429 that clears during the backoff stays on the primary.
    const t3 = setup({ [A]: [429, 200], [B]: [200] })
    expect((await t3.call()).status).toBe(200)
    expect(t3.calls.map((c) => c.url)).toEqual([A, A])
  })

  it('remembers the healthy endpoint for later calls, then gives the primary another chance', async () => {
    const t = setup({ [A]: ['network'], [B]: [200] })
    await t.call()
    expect(t.f.activeEndpoint()).toBe(B)
    t.calls.length = 0
    await t.call()
    expect(t.calls.map((c) => c.url)).toEqual([B]) // no wasted request to the dead primary

    t.advance(PREFER_HEALTHY_MS + 1)
    expect(t.f.activeEndpoint()).toBe(A)
    t.calls.length = 0
    await t.call()
    expect(t.calls.map((c) => c.url)).toEqual([A, B])
  })

  it('a failing remembered endpoint fails over onward, wrapping around to the primary', async () => {
    const t = setup({ [A]: ['network', 200], [B]: [200, 500] })
    await t.call() // A down → B
    t.calls.length = 0
    const res = await t.call() // B now 500 → C (network) → A (up again)
    expect(res.status).toBe(200)
    expect(t.calls.map((c) => c.url)).toEqual([B, C, A])
    expect(t.f.activeEndpoint()).toBe(A)
  })

  it('every endpoint failing: returns the first HTTP answer (e.g. the primary 429), else rethrows the first error', async () => {
    const t1 = setup({ [A]: [429], [B]: ['network'], [C]: [503] })
    const res = await t1.call()
    expect(res.status).toBe(429)
    expect(await res.json()).toMatchObject({ result: `${A}:429` })

    const t2 = setup({ [A]: ['network'], [B]: ['network'], [C]: ['network'] })
    await expect(t2.call()).rejects.toThrow('Failed to fetch')
    expect(t2.calls).toHaveLength(3)
  })

  it('JSON-RPC errors inside a 200 are answers, not failovers', async () => {
    const t = setup({
      [A]: [() => new Response(JSON.stringify({ jsonrpc: '2.0', id: '1', error: { code: -32601, message: 'Method not found' } }), { status: 200 })],
    })
    const res = await t.call()
    expect(await res.json()).toMatchObject({ error: { code: -32601 } })
    expect(t.calls).toHaveLength(1)
  })

  it('an endpoint that never answers times out and the same request goes to the next endpoint', async () => {
    vi.useFakeTimers()
    try {
      const signals: AbortSignal[] = []
      const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
        if (String(input) === A) {
          signals.push(init!.signal!)
          return new Promise<Response>(() => {}) // TCP open, no answer
        }
        return new Response('{"ok":1}', { status: 200 })
      })
      const f = createFailoverFetch({ endpoints: [A, B], fetch: fn as unknown as typeof fetch, attemptTimeoutMs: 1_000 })
      const pending = f(A, { method: 'POST', body: '{}' } as never)
      await vi.advanceTimersByTimeAsync(999)
      expect(fn).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      const res = await pending
      expect(res.status).toBe(200)
      expect(fn.mock.calls.map((c) => String(c[0]))).toEqual([A, B])
      expect(signals[0].aborted).toBe(true) // the hung fetch is cancelled, not left dangling
      expect(f.activeEndpoint()).toBe(B)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a stalled body counts too; with no endpoint left the timeout is thrown (an Error, so web3.js rejects)', async () => {
    vi.useFakeTimers()
    try {
      const stalledBody = () =>
        new Response(new ReadableStream({ start() {} }), { status: 200 }) // headers arrive, body never ends
      const fn = vi.fn(async () => stalledBody())
      const f = createFailoverFetch({ endpoints: [A], fetch: fn as unknown as typeof fetch, attemptTimeoutMs: 500 })
      const pending = f(A, { method: 'POST', body: '{}' } as never)
      const settled = expect(pending).rejects.toBeInstanceOf(RpcTimeoutError)
      await vi.advanceTimersByTimeAsync(500)
      await settled
      await expect(pending).rejects.toBeInstanceOf(Error)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a stalled sendTransaction through a real Connection fails over instead of hanging', async () => {
    vi.useFakeTimers()
    try {
      const fn = async (input: unknown, init?: RequestInit) => {
        if (String(input) === A) return new Promise<Response>(() => {})
        const req = JSON.parse(String(init?.body)) as { id: string }
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { context: { slot: 1 }, value: 7 } }), { status: 200 })
      }
      const connection = new Connection(A, {
        commitment: 'confirmed',
        disableRetryOnRateLimit: true,
        fetch: createFailoverFetch({ endpoints: [A, B], fetch: fn as unknown as typeof fetch }) as never,
      })
      const balance = connection.getBalance(Keypair.generate().publicKey)
      await vi.advanceTimersByTimeAsync(RPC_ATTEMPT_TIMEOUT_MS)
      expect(await balance).toBe(7)
    } finally {
      vi.useRealTimers()
    }
  })

  it('an aborted request is not retried elsewhere', async () => {
    const ac = new AbortController()
    const { fn } = fakeFetch({})
    fn.mockImplementationOnce(async () => {
      ac.abort()
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    })
    const f = createFailoverFetch({ endpoints: [A, B], fetch: fn as unknown as typeof fetch })
    await expect(f(A, { method: 'POST', body: '{}', signal: ac.signal } as never)).rejects.toMatchObject({ name: 'AbortError' })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('URLs outside the list, or a single endpoint, pass through with only the 429 backoff', async () => {
    const t = setup({ 'https://other.example': [429, 200], [A]: ['network'] }, [A])
    expect((await t.f('https://other.example', t.init as never)).status).toBe(200)
    expect(t.sleeps).toEqual([600])
    await expect(t.call()).rejects.toThrow('Failed to fetch')
    expect(t.calls.map((c) => c.url)).toEqual(['https://other.example', 'https://other.example', A])
  })

  it('works as ConnectionConfig.fetch: a real Connection fails over and keeps the JSON-RPC body intact', async () => {
    const bodies: Array<{ url: string; body: string }> = []
    const fn = async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      bodies.push({ url, body: String(init?.body) })
      if (url === A) return new Response('bad gateway', { status: 502 })
      const req = JSON.parse(String(init?.body)) as { id: string }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { context: { slot: 1 }, value: 42 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const connection = new Connection(A, {
      commitment: 'confirmed',
      disableRetryOnRateLimit: true,
      fetch: createFailoverFetch({ endpoints: [A, B], fetch: fn as unknown as typeof fetch }) as never,
    })
    const balance = await connection.getBalance(Keypair.generate().publicKey)
    expect(balance).toBe(42)
    expect(bodies.map((b) => b.url)).toEqual([A, B])
    expect(bodies[1].body).toBe(bodies[0].body)
  })
})

describe('readRpcFallbacks', () => {
  it('defaults, "none", https-only, dedupe and primary exclusion', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(readRpcFallbacks(undefined, [DEFAULT_MAINNET_RPC_FALLBACK], A)).toEqual([DEFAULT_MAINNET_RPC_FALLBACK])
    expect(readRpcFallbacks('  ', [DEFAULT_MAINNET_RPC_FALLBACK], A)).toEqual([DEFAULT_MAINNET_RPC_FALLBACK])
    expect(readRpcFallbacks('none', [DEFAULT_MAINNET_RPC_FALLBACK], A)).toEqual([])
    expect(readRpcFallbacks(undefined, [], A)).toEqual([])
    expect(readRpcFallbacks(` ${B}, ${C} ,${B}/,http://insecure.example, not a url, ${A}/`, [], A)).toEqual([B, C])
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })
})

describe('defaultMainnetFallbacks', () => {
  it('the public fallback is a default only for the public primary, never behind an operator-chosen RPC', () => {
    expect(defaultMainnetFallbacks(undefined)).toEqual([DEFAULT_MAINNET_RPC_FALLBACK])
    expect(defaultMainnetFallbacks('  ')).toEqual([DEFAULT_MAINNET_RPC_FALLBACK])
    expect(defaultMainnetFallbacks('https://mainnet.helius-rpc.com/?api-key=x')).toEqual([])
    // An explicit list still applies with a custom primary.
    expect(readRpcFallbacks(B, defaultMainnetFallbacks(A), A)).toEqual([B])
    expect(readRpcFallbacks(undefined, defaultMainnetFallbacks(A), A)).toEqual([])
  })
})

describe('RPC failover: bodies only go to operator-configured endpoints', () => {
  it('re-sends the identical body only to listed endpoints; unlisted URLs are passed through untouched', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body })
      return new Response('down', { status: 503 })
    })
    const f = createFailoverFetch({ endpoints: [A, B], fetch: fetchImpl as never, sleep: async () => {} })
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: ['AQ…'] })
    const res = await f(A, { method: 'POST', body })
    expect(res.status).toBe(503)
    expect(new Set(calls.map((c) => c.url))).toEqual(new Set([A, B]))
    expect(calls.every((c) => c.body === body)).toBe(true)

    calls.length = 0
    await f('https://elsewhere.example/', { method: 'POST', body })
    expect(calls.map((c) => c.url)).toEqual(['https://elsewhere.example/'])
  })

  it('readRpcFallbacks drops non-https / junk entries and the primary', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = readRpcFallbacks(
      'http://plain.example, javascript:alert(1), wss://ws.example, //proto-rel.example, https://ok.example/, https://primary.example/, not a url',
      [],
      'https://primary.example',
    )
    expect(out).toEqual(['https://ok.example/'])
    expect(readRpcFallbacks('none', ['https://x.example'], A)).toEqual([])
    warn.mockRestore()
  })
})


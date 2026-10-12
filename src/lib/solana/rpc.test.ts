// @vitest-environment node
import { Connection, Keypair } from '@solana/web3.js'
import { describe, expect, it, vi } from 'vitest'
import { readRpcFallbacks, DEFAULT_MAINNET_RPC_FALLBACK } from '../../config'
import { PREFER_HEALTHY_MS, createFailoverFetch, isFailoverStatus } from './rpc'

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
  it('fails over on 403, 429 and 5xx only', () => {
    for (const s of [403, 429, 500, 502, 503, 504]) expect(isFailoverStatus(s)).toBe(true)
    for (const s of [200, 400, 401, 404, 413]) expect(isFailoverStatus(s)).toBe(false)
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
    expect(t.calls[1].init).toBe(t.calls[0].init) // same init object, untouched
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

// @vitest-environment node
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONFIG } from '../../config'
import {
  PRIORITY_FEE_ACCOUNTS,
  PRIORITY_FEE_TIMEOUT_MS,
  defaultPriorityFeeBounds,
  estimatePriorityFee,
  percentile,
  pickPriorityFee,
} from './priority'

const bounds = { floor: 20_000, cap: 1_000_000 }
const samples = (...fees: number[]) => fees.map((prioritizationFee, slot) => ({ slot, prioritizationFee }))

function conn(impl: (config?: { lockedWritableAccounts?: PublicKey[] }) => Promise<unknown>) {
  const getRecentPrioritizationFees = vi.fn(impl)
  return { getRecentPrioritizationFees, connection: { getRecentPrioritizationFees } as unknown as Connection }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('percentile', () => {
  it('nearest rank', () => {
    expect(percentile([1, 2, 3, 4], 0.75)).toBe(3)
    expect(percentile([4, 1, 3, 2], 0.75)).toBe(3)
    expect(percentile([10], 0.75)).toBe(10)
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8], 0.75)).toBe(6)
    expect(percentile([5, 1], 1)).toBe(5)
    expect(percentile([5, 1], 0)).toBe(1)
    expect(Number.isNaN(percentile([], 0.75))).toBe(true)
  })
})

describe('pickPriorityFee', () => {
  it('75th percentile of the non-zero prices', () => {
    // Zeros (idle slots) are ignored: non-zero = 30k, 40k, 50k, 60k → p75 = 50k.
    expect(pickPriorityFee(samples(0, 0, 0, 60_000, 30_000, 0, 50_000, 40_000), bounds)).toBe(50_000)
  })

  it('clamps to [floor, cap]', () => {
    expect(pickPriorityFee(samples(1, 2, 3), bounds)).toBe(20_000)
    expect(pickPriorityFee(samples(5_000_000, 9_000_000, 7_000_000), bounds)).toBe(1_000_000)
  })

  it('no usable sample → floor; junk entries are ignored', () => {
    expect(pickPriorityFee([], bounds)).toBe(20_000)
    expect(pickPriorityFee(samples(0, 0, 0), bounds)).toBe(20_000)
    expect(pickPriorityFee(null, bounds)).toBe(20_000)
    expect(pickPriorityFee({ value: [] }, bounds)).toBe(20_000)
    expect(pickPriorityFee([null, { prioritizationFee: 'x' }, { prioritizationFee: Number.NaN }, { prioritizationFee: 80_000 }], bounds)).toBe(80_000)
  })

  it('returns whole micro-lamports and tolerates odd bounds', () => {
    expect(pickPriorityFee(samples(33_333.4), bounds)).toBe(33_334)
    expect(pickPriorityFee(samples(50_000), { floor: 30_000, cap: 10_000 })).toBe(30_000) // cap below floor → floor
  })

  it('defaults come from CONFIG', () => {
    expect(defaultPriorityFeeBounds()).toEqual({ floor: CONFIG.priorityFeeMicroLamports, cap: CONFIG.maxPriorityFeeMicroLamports })
    expect(CONFIG.maxPriorityFeeMicroLamports).toBe(1_000_000)
    expect(pickPriorityFee(samples(1))).toBe(CONFIG.priorityFeeMicroLamports)
  })
})

describe('estimatePriorityFee', () => {
  it('asks for fees locking the owner + a few closed accounts as writable', async () => {
    const owner = Keypair.generate().publicKey
    const accounts = Array.from({ length: 10 }, () => Keypair.generate().publicKey.toBase58())
    const { connection, getRecentPrioritizationFees } = conn(async () => samples(100_000, 200_000, 300_000, 400_000))
    const fee = await estimatePriorityFee(connection, [owner, ...accounts, owner.toBase58(), 'not-a-key'], bounds)
    expect(fee).toBe(300_000)
    const keys = getRecentPrioritizationFees.mock.calls[0][0]!.lockedWritableAccounts!.map((k) => k.toBase58())
    expect(keys).toHaveLength(PRIORITY_FEE_ACCOUNTS)
    expect(keys).toEqual([owner.toBase58(), ...accounts.slice(0, PRIORITY_FEE_ACCOUNTS - 1)])
  })

  it('falls back to the floor on any RPC error, a missing method or junk', async () => {
    expect(await estimatePriorityFee(conn(async () => Promise.reject(new Error('Method not found'))).connection, [], bounds)).toBe(20_000)
    expect(await estimatePriorityFee({} as unknown as Connection, [], bounds)).toBe(20_000)
    expect(await estimatePriorityFee(conn(async () => 'garbage').connection, [], bounds)).toBe(20_000)
  })

  it('a hanging RPC falls back to the floor after the timeout', async () => {
    vi.useFakeTimers()
    const p = estimatePriorityFee(conn(() => new Promise(() => {})).connection, [], bounds)
    await vi.advanceTimersByTimeAsync(PRIORITY_FEE_TIMEOUT_MS + 1)
    expect(await p).toBe(20_000)
  })

  it('through a real Connection: the wire request and a realistic answer', async () => {
    const owner = Keypair.generate().publicKey
    const bodies: Array<{ method: string; params: unknown[] }> = []
    const connection = new Connection('http://127.0.0.1:8899', {
      commitment: 'confirmed',
      fetch: (async (_url: unknown, init?: { body?: unknown }) => {
        const req = JSON.parse(String(init?.body)) as { id: string; method: string; params: unknown[] }
        bodies.push(req)
        const result = Array.from({ length: 150 }, (_, i) => ({ slot: 300_000_000 + i, prioritizationFee: i % 3 === 0 ? 0 : i * 1_000 }))
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }) as unknown as typeof fetch,
    })
    const fee = await estimatePriorityFee(connection, [owner], bounds)
    expect(bodies[0].method).toBe('getRecentPrioritizationFees')
    expect(bodies[0].params).toEqual([[owner.toBase58()]])
    const nonZero = Array.from({ length: 150 }, (_, i) => i).filter((i) => i % 3 !== 0).map((i) => i * 1_000)
    expect(fee).toBe(percentile(nonZero, 0.75))
    expect(fee).toBeGreaterThan(bounds.floor)
  })
})

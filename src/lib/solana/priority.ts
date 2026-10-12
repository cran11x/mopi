import { PublicKey, type Connection, type RecentPrioritizationFees } from '@solana/web3.js'
import { CONFIG } from '../../config'

// Dynamic priority fee: what recently landed transactions touching the same
// accounts paid per compute unit, clamped to the deployment's floor and cap.
//
// In practice this is "the floor, with rare bumps": with lockedWritableAccounts
// the RPC reports, per slot, the larger of the block's lowest landed price
// (usually 0 on mainnet) and the lowest price paid by txs that locked those
// accounts — and nobody else writes to the owner's wallet or token accounts.
// The floor (CONFIG.priorityFeeMicroLamports) is what actually prices most
// cleanups; a provider estimator (e.g. Helius getPriorityFeeEstimate) would be
// needed to track real congestion.

/** Percentile of recent non-zero prices used as the estimate. */
export const PRIORITY_FEE_PERCENTILE = 0.75
/** Accounts passed as lockedWritableAccounts: the owner plus a few of the accounts being closed. */
export const PRIORITY_FEE_ACCOUNTS = 5
/** An estimate that takes longer than this falls back to the floor. */
export const PRIORITY_FEE_TIMEOUT_MS = 5_000

export interface PriorityFeeBounds {
  /** Lowest price ever used (µlamports/CU); also the fallback. */
  floor: number
  /** Highest price ever used (µlamports/CU). */
  cap: number
}

export function defaultPriorityFeeBounds(): PriorityFeeBounds {
  return { floor: CONFIG.priorityFeeMicroLamports, cap: CONFIG.maxPriorityFeeMicroLamports }
}

function sane(bounds: PriorityFeeBounds): PriorityFeeBounds {
  const floor = Number.isFinite(bounds.floor) ? Math.max(0, Math.floor(bounds.floor)) : 0
  const cap = Number.isFinite(bounds.cap) ? Math.max(floor, Math.floor(bounds.cap)) : floor
  return { floor, cap }
}

/** Nearest-rank percentile of `values` (p in 0..1); NaN for an empty list. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil(Math.min(1, Math.max(0, p)) * sorted.length)
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]
}

/**
 * The estimate for a getRecentPrioritizationFees answer: the 75th percentile
 * of the non-zero prices, clamped to [floor, cap]; the floor when there is no
 * usable sample.
 */
export function pickPriorityFee(samples: unknown, bounds: PriorityFeeBounds = defaultPriorityFeeBounds()): number {
  const { floor, cap } = sane(bounds)
  if (!Array.isArray(samples)) return floor
  const prices = samples
    .map((s) => (s && typeof s === 'object' ? (s as Partial<RecentPrioritizationFees>).prioritizationFee : undefined))
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0)
  if (prices.length === 0) return floor
  const p = Math.ceil(percentile(prices, PRIORITY_FEE_PERCENTILE))
  return Math.min(cap, Math.max(floor, p))
}

function toKey(account: PublicKey | string): PublicKey | null {
  try {
    return typeof account === 'string' ? new PublicKey(account) : account
  } catch {
    return null
  }
}

/**
 * Priority fee price (µlamports per CU) for a cleanup touching `accounts`
 * (the owner first, then closed accounts; only the first few are used). Never
 * throws: any RPC error, timeout or odd answer gives the floor.
 */
export async function estimatePriorityFee(
  connection: Pick<Connection, 'getRecentPrioritizationFees'>,
  accounts: readonly (PublicKey | string)[],
  bounds: PriorityFeeBounds = defaultPriorityFeeBounds(),
): Promise<number> {
  const { floor } = sane(bounds)
  const seen = new Set<string>()
  const keys: PublicKey[] = []
  for (const a of accounts) {
    const key = toKey(a)
    if (!key || seen.has(key.toBase58())) continue
    seen.add(key.toBase58())
    keys.push(key)
    if (keys.length >= PRIORITY_FEE_ACCOUNTS) break
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const samples = await Promise.race([
      connection.getRecentPrioritizationFees(keys.length > 0 ? { lockedWritableAccounts: keys } : undefined),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('priority fee estimate timed out')), PRIORITY_FEE_TIMEOUT_MS)
      }),
    ])
    return pickPriorityFee(samples, bounds)
  } catch {
    return floor
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

import { PublicKey } from '@solana/web3.js'
import type { Cluster } from './lib/types'

// Runtime configuration. Everything here ships in the client bundle — none of
// it is secret. See .env.example.

const env = import.meta.env

function readInt(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value.trim() === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function readPubkey(value: string | undefined): string | null {
  if (!value || value.trim() === '') return null
  try {
    return new PublicKey(value.trim()).toBase58()
  } catch {
    console.warn(`[mopi] ignoring invalid public key in env: ${value}`)
    return null
  }
}

export const RPC_URLS: Record<Cluster, string> = {
  'mainnet-beta': env.VITE_SOLANA_RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com',
  devnet: env.VITE_SOLANA_DEVNET_RPC_URL?.trim() || 'https://api.devnet.solana.com',
}

/** Free public mainnet endpoint (CORS enabled) used when the public default primary fails, unless configured otherwise. */
export const DEFAULT_MAINNET_RPC_FALLBACK = 'https://solana-rpc.publicnode.com'

/**
 * Comma-separated https endpoints. Unset or empty → `fallback`; "none" → no
 * fallbacks. Invalid or non-https entries and the primary itself are dropped.
 */
export function readRpcFallbacks(value: string | undefined, fallback: readonly string[], primary: string): string[] {
  const raw = value === undefined || value.trim() === '' ? fallback.join(',') : value
  if (raw.trim().toLowerCase() === 'none') return []
  const norm = (u: string) => u.trim().replace(/\/+$/, '')
  const out: string[] = []
  for (const entry of raw.split(',')) {
    const url = entry.trim()
    if (!url) continue
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      console.warn(`[mopi] ignoring invalid RPC fallback URL: ${url}`)
      continue
    }
    if (parsed.protocol !== 'https:') {
      console.warn(`[mopi] ignoring non-https RPC fallback URL: ${url}`)
      continue
    }
    if (norm(url) === norm(primary) || out.some((u) => norm(u) === norm(url))) continue
    out.push(url)
  }
  return out
}

/**
 * The public fallback is only a default for the public primary: an operator
 * who set their own VITE_SOLANA_RPC_URL never has wallet addresses, scans or
 * signed transactions sent to a third party they didn't choose (list it in
 * VITE_SOLANA_RPC_FALLBACKS to opt in).
 */
export function defaultMainnetFallbacks(primaryFromEnv: string | undefined): string[] {
  return primaryFromEnv?.trim() ? [] : [DEFAULT_MAINNET_RPC_FALLBACK]
}

/** Endpoints tried, in order, after the primary RPC fails (network error, timeout, endpoint-level HTTP error). */
export const RPC_FALLBACKS: Record<Cluster, string[]> = {
  'mainnet-beta': readRpcFallbacks(
    env.VITE_SOLANA_RPC_FALLBACKS,
    defaultMainnetFallbacks(env.VITE_SOLANA_RPC_URL),
    RPC_URLS['mainnet-beta'],
  ),
  devnet: readRpcFallbacks(env.VITE_SOLANA_DEVNET_RPC_FALLBACKS, [], RPC_URLS.devnet),
}

export const CLUSTER_LABELS: Record<Cluster, string> = {
  'mainnet-beta': 'Mainnet',
  devnet: 'Devnet',
}

export const CONFIG = {
  /** Fee recipient. null → no service fee is charged at all. */
  feeWallet: readPubkey(env.VITE_FEE_WALLET),
  /** Standard service fee, bps of reclaimed account SOL. Capped at 10%. */
  serviceFeeBps: readInt(env.VITE_SERVICE_FEE_BPS, 400, 0, 1000),
  /** $MOPI holder service fee, bps. */
  holderFeeBps: readInt(env.VITE_HOLDER_FEE_BPS, 200, 0, 1000),
  /** $MOPI mint; null until the token exists. */
  mopiMint: readPubkey(env.VITE_MOPI_MINT),
  /** Whole $MOPI tokens needed for holder access. */
  holderMin: readInt(env.VITE_MOPI_HOLDER_MIN, 100_000, 0, Number.MAX_SAFE_INTEGER),

  /** Solana base fee per signature. */
  baseFeeLamportsPerSignature: 5_000,
  /**
   * Priority fee price floor, micro-lamports per CU. Demo quotes use exactly
   * this; real cleanups use the recent-fee estimate clamped to
   * [priorityFeeMicroLamports, maxPriorityFeeMicroLamports].
   */
  priorityFeeMicroLamports: 20_000,
  /** Highest priority fee price a real cleanup will pay, micro-lamports per CU. */
  maxPriorityFeeMicroLamports: 1_000_000,
  /** CU reserved per CloseAccount (Token-2022 closes cost more than SPL Token). */
  computeUnitsPerClose: 6_000,
  /** CU reserved for compute-budget + fee transfer instructions. */
  computeUnitsBase: 2_000,
  /** CloseAccount instructions per transaction. 20 keeps a v0 tx well under 1232 bytes. */
  maxClosesPerTx: 20,

  /** Saved wallets allowed without holder access. */
  freeWatchlistLimit: 1,
} as const

export const LAMPORTS_PER_SOL = 1_000_000_000

export function explorerTxUrl(signature: string, cluster: Cluster): string {
  const suffix = cluster === 'mainnet-beta' ? '' : `?cluster=${cluster}`
  return `https://solscan.io/tx/${signature}${suffix}`
}

export function explorerAccountUrl(address: string, cluster: Cluster): string {
  const suffix = cluster === 'mainnet-beta' ? '' : `?cluster=${cluster}`
  return `https://solscan.io/account/${address}${suffix}`
}

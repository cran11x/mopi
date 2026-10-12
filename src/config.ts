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
  /** Priority fee price, micro-lamports per CU. */
  priorityFeeMicroLamports: 20_000,
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

import type { Connection } from '@solana/web3.js'
import type { BatchProgress, CleanupQuote, CleanupWallet, FeeConfig } from '../types'

export interface ExecuteCleanupParams {
  connection: Connection
  wallet: CleanupWallet
  quote: CleanupQuote
  fee: FeeConfig
  /** Called with a fresh array every time any batch changes status. */
  onProgress: (progress: BatchProgress[]) => void
  signal?: AbortSignal
}

/**
 * Builds, verifies (assertSafeCleanupTransaction), simulates, signs (one
 * signAllTransactions prompt when available, else one prompt per batch),
 * sends and confirms every batch. A failed simulation marks that batch
 * failed and skips it; it never sends a transaction that failed simulation.
 * Resolves with the final progress (never rejects for per-batch failures;
 * rejects only on wallet-level errors such as the user declining to sign).
 */
export async function executeCleanup(_params: ExecuteCleanupParams): Promise<BatchProgress[]> {
  throw new Error('executeCleanup: not implemented')
}

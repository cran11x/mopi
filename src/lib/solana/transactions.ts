import type { Connection, PublicKey, TransactionInstruction, VersionedTransaction } from '@solana/web3.js'
import type { CleanupBatch, CleanupQuote, FeeConfig } from '../types'

/** SPL Token / Token-2022 CloseAccount (instruction index 9): account (w), destination (w), authority (signer). */
export function createCloseAccountInstruction(
  _account: PublicKey,
  _destination: PublicKey,
  _authority: PublicKey,
  _programId: PublicKey,
): TransactionInstruction {
  throw new Error('createCloseAccountInstruction: not implemented')
}

/** Instructions for one batch: compute budget, CloseAccount × n (destination = owner), optional fee transfer. */
export function buildBatchInstructions(_owner: PublicKey, _batch: CleanupBatch, _fee: FeeConfig): TransactionInstruction[] {
  throw new Error('buildBatchInstructions: not implemented')
}

export interface BuiltCleanupTransactions {
  transactions: VersionedTransaction[]
  blockhash: string
  lastValidBlockHeight: number
}

/** One v0 transaction per quote batch, sharing a fresh blockhash, fee payer = owner. */
export async function buildCleanupTransactions(_params: {
  connection: Connection
  owner: PublicKey
  quote: CleanupQuote
  fee: FeeConfig
}): Promise<BuiltCleanupTransactions> {
  throw new Error('buildCleanupTransactions: not implemented')
}

/**
 * Defense in depth: throws unless every instruction in `tx` is a ComputeBudget
 * instruction, a CloseAccount on an expected account whose destination AND
 * authority are `owner`, or a single SystemProgram transfer owner → feeWallet
 * of exactly `batch.serviceFeeLamports`. Called right before signing.
 */
export function assertSafeCleanupTransaction(
  _tx: VersionedTransaction,
  _owner: PublicKey,
  _batch: CleanupBatch,
  _fee: FeeConfig,
): void {
  throw new Error('assertSafeCleanupTransaction: not implemented')
}

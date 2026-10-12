import { CONFIG } from '../../config'
import type { CleanupBatch, CleanupQuote, FeeConfig, TokenAccountInfo } from '../types'

export function defaultFeeConfig(isHolder: boolean): FeeConfig {
  const feeWallet = CONFIG.feeWallet
  return {
    serviceFeeBps: feeWallet ? (isHolder ? CONFIG.holderFeeBps : CONFIG.serviceFeeBps) : 0,
    feeWallet,
    baseFeeLamportsPerSignature: CONFIG.baseFeeLamportsPerSignature,
    priorityFeeMicroLamports: CONFIG.priorityFeeMicroLamports,
    computeUnitsPerClose: CONFIG.computeUnitsPerClose,
    computeUnitsBase: CONFIG.computeUnitsBase,
    maxClosesPerTx: CONFIG.maxClosesPerTx,
  }
}

/** Service fee for one batch: floor(feeBasis * bps / 10_000); 0 without a fee wallet. */
export function serviceFeeFor(feeBasisLamports: number, fee: FeeConfig): number {
  if (!fee.feeWallet || fee.serviceFeeBps <= 0 || feeBasisLamports <= 0) return 0
  return Math.floor((feeBasisLamports * fee.serviceFeeBps) / 10_000)
}

/** Rent-exempt minimum for an account with `dataLen` bytes of data (128-byte header, 3480 lamports/byte-year, 2 years). */
export function rentExemptMinimum(dataLen: number): number {
  return (128 + dataLen) * 3_480 * 2
}

/** An SPL Token account is always exactly 165 bytes. */
export const SPL_TOKEN_ACCOUNT_SPACE = 165
/**
 * Largest Token-2022 account mopi will close: 165-byte base + 1-byte account
 * type + a TLV entry (4-byte header + value) for every allowlisted account
 * extension: immutableOwner 0, transferFeeAmount 8, memoTransfer 1, cpiGuard 1,
 * nonTransferableAccount 0, transferHookAccount 1, pausableAccount 0.
 */
export const MAX_TOKEN_2022_ACCOUNT_SPACE = 165 + 1 + 7 * 4 + 8 + 1 + 1 + 1

/**
 * The most account SOL a closable token account can hold without someone
 * having donated SOL to it: its rent-exempt deposit at the largest size mopi
 * accepts for its program.
 */
export function maxRentDepositFor(account: Pick<TokenAccountInfo, 'program'>): number {
  return rentExemptMinimum(account.program === 'token-2022' ? MAX_TOKEN_2022_ACCOUNT_SPACE : SPL_TOKEN_ACCOUNT_SPACE)
}

/**
 * Lamports of `accounts` the service fee is charged on. Each account counts at
 * most its plausible rent deposit, so an RPC that over-reports `lamports` can
 * never make the fee exceed what the closes actually return (fee ≤ 10% of a
 * deposit that is really there). SOL donated on top of the deposit still goes
 * back to the owner — it just isn't charged.
 */
export function feeBasisFor(accounts: readonly TokenAccountInfo[]): number {
  return accounts.reduce((sum, a) => sum + Math.max(0, Math.min(a.lamports, maxRentDepositFor(a))), 0)
}

export function computeUnitLimitFor(closeCount: number, fee: FeeConfig): number {
  return fee.computeUnitsBase + closeCount * fee.computeUnitsPerClose
}

/** Base fee (one signature) plus priority fee for one transaction. */
export function networkFeeFor(computeUnitLimit: number, fee: FeeConfig): number {
  const priority =
    fee.priorityFeeMicroLamports > 0
      ? Math.ceil((computeUnitLimit * fee.priorityFeeMicroLamports) / 1_000_000)
      : 0
  return fee.baseFeeLamportsPerSignature + priority
}

/**
 * Splits the selected (eligible) accounts into transaction-sized batches and
 * prices them. Pure — the same quote drives the preview card, the review
 * modal and the transaction builder, so what the user sees is what they sign.
 * Accounts that are not `eligible`, and repeated addresses, are ignored
 * defensively. The service fee is charged on `feeBasisFor` (capped per
 * account), not on the raw reported lamports.
 */
export function buildQuote(
  accounts: TokenAccountInfo[],
  fee: FeeConfig,
  opts: { isHolderRate?: boolean } = {},
): CleanupQuote {
  // Eligible only, and each address once: a duplicate would be quoted twice
  // but can only be closed once.
  const seen = new Set<string>()
  const closable = accounts.filter((a) => {
    if (a.status !== 'eligible' || seen.has(a.address)) return false
    seen.add(a.address)
    return true
  })
  const size = Math.max(1, Math.floor(fee.maxClosesPerTx))
  const batches: CleanupBatch[] = []

  for (let i = 0; i < closable.length; i += size) {
    const slice = closable.slice(i, i + size)
    const reclaimLamports = slice.reduce((sum, a) => sum + a.lamports, 0)
    const computeUnitLimit = computeUnitLimitFor(slice.length, fee)
    batches.push({
      index: batches.length,
      accounts: slice,
      reclaimLamports,
      serviceFeeLamports: serviceFeeFor(feeBasisFor(slice), fee),
      networkFeeLamports: networkFeeFor(computeUnitLimit, fee),
      computeUnitLimit,
    })
  }

  const reclaimLamports = batches.reduce((s, b) => s + b.reclaimLamports, 0)
  const networkFeeLamports = batches.reduce((s, b) => s + b.networkFeeLamports, 0)
  const serviceFeeLamports = batches.reduce((s, b) => s + b.serviceFeeLamports, 0)

  return {
    accountCount: closable.length,
    reclaimLamports,
    networkFeeLamports,
    serviceFeeLamports,
    serviceFeeBps: fee.feeWallet ? fee.serviceFeeBps : 0,
    netLamports: Math.max(0, reclaimLamports - networkFeeLamports - serviceFeeLamports),
    batches,
    isHolderRate: Boolean(opts.isHolderRate),
  }
}

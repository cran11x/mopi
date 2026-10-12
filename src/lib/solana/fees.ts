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

/** Service fee for one batch: floor(reclaim * bps / 10_000); 0 without a fee wallet. */
export function serviceFeeFor(reclaimLamports: number, fee: FeeConfig): number {
  if (!fee.feeWallet || fee.serviceFeeBps <= 0 || reclaimLamports <= 0) return 0
  return Math.floor((reclaimLamports * fee.serviceFeeBps) / 10_000)
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
 * Accounts that are not `eligible` are ignored defensively.
 */
export function buildQuote(
  accounts: TokenAccountInfo[],
  fee: FeeConfig,
  opts: { isHolderRate?: boolean } = {},
): CleanupQuote {
  const closable = accounts.filter((a) => a.status === 'eligible')
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
      serviceFeeLamports: serviceFeeFor(reclaimLamports, fee),
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

import { CONFIG } from '../config'
import { buildQuote, defaultFeeConfig } from './solana/fees'
import type { CleanupQuote, FeeConfig, TokenAccountInfo } from './types'

// Illustrative fee examples shared by the Fees, How it works, Benefits and
// Docs pages (kept out of FeesPage so each lazily loaded page chunk stays
// independent).

/** Rent-exempt deposit of a standard 165-byte SPL token account. */
export const EXAMPLE_ACCOUNT_LAMPORTS = 2_039_280

/** Synthetic eligible accounts for fee illustrations (never sent anywhere). */
export function exampleAccounts(count: number): TokenAccountInfo[] {
  return Array.from({ length: count }, (_, i) => ({
    address: `example-${i}`,
    mint: 'example-mint',
    owner: 'example-owner',
    program: 'spl-token',
    programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    lamports: EXAMPLE_ACCOUNT_LAMPORTS,
    amountRaw: '0',
    decimals: 0,
    uiAmount: '0',
    isNative: false,
    state: 'initialized',
    closeAuthority: null,
    extensions: [],
    status: 'eligible',
  }))
}

/**
 * Fee config used for illustrations: the deployment's real config, or — when
 * no fee wallet is configured — the standard rate with a placeholder
 * recipient so the example still shows what a fee would look like.
 */
export function illustrativeFeeConfig(): { fee: FeeConfig; isPlaceholder: boolean } {
  const base = defaultFeeConfig(false)
  if (CONFIG.feeWallet) return { fee: base, isPlaceholder: false }
  return { fee: { ...base, feeWallet: 'illustration-only', serviceFeeBps: CONFIG.serviceFeeBps }, isPlaceholder: true }
}

export function exampleQuote(count: number): CleanupQuote {
  return buildQuote(exampleAccounts(count), illustrativeFeeConfig().fee)
}

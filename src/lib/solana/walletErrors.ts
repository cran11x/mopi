// Wallet signing errors. wallet-adapter wraps EVERY wallet failure in
// WalletSignTransactionError (message = the wallet's own message, `.error` =
// the wallet's original error), so the class name says nothing about whether
// the user declined. Only the wallet's code / words do.

/** Words wallets use when the user says no. Ledger 0x6985 = "denied on the device". */
const REJECTION_TEXT = /reject|declin|cancel|denied|0x6985/i

/** Ledger Solana app answers that mean "blind signing is off" (or the app can't parse the tx without it). */
const LEDGER_BLIND_SIGNING = /0x6808|0x6a81/i
/** Ledger locked / Solana app not open. */
const LEDGER_LOCKED = /0x5515|0x6e01|0x6d02|0x6511|locked device/i

export const WALLET_MESSAGES = {
  declined: 'You declined the request in your wallet.',
  ledgerBlindSigning:
    'Your Ledger refused to sign. Open the Solana app on the Ledger, turn on blind signing in its settings, then try again.',
  ledgerLocked: 'Unlock your Ledger and open the Solana app, then try again.',
} as const

function field(value: unknown, key: string): unknown {
  return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined
}

/** The error's own message plus the wrapped wallet error's message, if any. */
function messagesOf(err: unknown): string[] {
  if (typeof err === 'string') return [err]
  const inner = field(err, 'error')
  return [field(err, 'message'), typeof inner === 'string' ? inner : field(inner, 'message')].filter(
    (m): m is string => typeof m === 'string' && m.length > 0,
  )
}

/** True only when the wallet says the user declined (EIP-1193 code 4001, or the wallet's own words). */
export function isUserRejection(err: unknown): boolean {
  if (!err) return false
  if (field(err, 'code') === 4001 || field(field(err, 'error'), 'code') === 4001) return true
  return messagesOf(err).some((m) => REJECTION_TEXT.test(m))
}

/** A user-facing sentence for a signing failure, or null when the raw message is the best we have. */
export function describeWalletError(err: unknown): string | null {
  if (isUserRejection(err)) return WALLET_MESSAGES.declined
  const text = messagesOf(err).join(' ')
  if (LEDGER_BLIND_SIGNING.test(text)) return WALLET_MESSAGES.ledgerBlindSigning
  if (LEDGER_LOCKED.test(text)) return WALLET_MESSAGES.ledgerLocked
  return null
}

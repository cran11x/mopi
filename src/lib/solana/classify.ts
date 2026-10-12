import type { TokenAccountInfo } from '../types'

/** Shape of one entry from getParsedTokenAccountsByOwner, reduced to what we read. */
export interface RawParsedTokenAccount {
  pubkey: string
  lamports: number
  /** Owning program id (Token or Token-2022). */
  programId: string
  /** `account.data` exactly as returned with encoding jsonParsed (may be a Buffer if unparsed). */
  data: unknown
}

/**
 * Pure classifier: turns one jsonParsed token account into a TokenAccountInfo
 * with status eligible | has-tokens | unsupported (+ reason / reasonText).
 * Must never throw on malformed input — unknown shapes become `unsupported`
 * with reason `unparsed`.
 *
 * `walletOwner` is the scanned wallet; an account whose on-chain owner differs
 * is `unsupported` / `owner-mismatch`.
 */
export function classifyTokenAccount(_raw: RawParsedTokenAccount, _walletOwner: string): TokenAccountInfo {
  throw new Error('classifyTokenAccount: not implemented')
}

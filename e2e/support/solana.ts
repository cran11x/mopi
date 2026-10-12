import { Keypair, PublicKey } from '@solana/web3.js'

// Deterministic Solana fixtures for the e2e suite. Everything is derived from
// fixed seeds, so addresses are real, valid base58 public keys that never
// change between runs.

export const RPC_URL = 'https://api.mainnet-beta.solana.com'
export const RPC_ROUTE = /^https:\/\/api\.mainnet-beta\.solana\.com\/?(\?.*)?$/
export const WS_ROUTE = /^wss:\/\/api\.mainnet-beta\.solana\.com\/?(\?.*)?$/

export const SPL_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
export const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
export const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111'
export const SYSTEM_PROGRAM = '11111111111111111111111111111111'

/** Rent-exempt deposit of a 165-byte SPL token account. */
export const SPL_RENT = 2_039_280
/** Rent-exempt deposit of a Token-2022 account with ImmutableOwner (170 bytes). */
export const T22_IMMUTABLE_RENT = 2_074_080
/** Rent-exempt deposit of a Token-2022 account with ImmutableOwner + TransferFeeAmount (182 bytes). */
export const T22_FEE_RENT = 2_157_600

/** A key derived from a fixed one-byte seed (ed25519 keypair, so it is on-curve like a real wallet). */
export function keyFromSeed(seed: number): PublicKey {
  return Keypair.fromSeed(new Uint8Array(32).fill(seed)).publicKey
}

export function address(seed: number): string {
  return keyFromSeed(seed).toBase58()
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** Minimal base58 encoder (for transaction signatures, which are 64 bytes and not public keys). */
export function base58(bytes: Uint8Array): string {
  const digits: number[] = []
  for (const byte of bytes) {
    let carry = byte
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8
      digits[j] = carry % 58
      carry = (carry / 58) | 0
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = (carry / 58) | 0
    }
  }
  let out = ''
  for (const byte of bytes) {
    if (byte !== 0) break
    out += '1'
  }
  for (let k = digits.length - 1; k >= 0; k--) out += B58[digits[k]]
  return out
}

export interface TokenAccountSpec {
  pubkey: string
  owner: string
  mint: string
  program: 'spl-token' | 'spl-token-2022'
  lamports: number
  amount?: string
  decimals?: number
  state?: 'initialized' | 'frozen' | 'uninitialized'
  closeAuthority?: string
  extensions?: Array<{ extension: string; state?: unknown }>
  space?: number
}

/** One entry of a jsonParsed getTokenAccountsByOwner response, shaped like Agave returns it. */
export function parsedTokenAccount(spec: TokenAccountSpec) {
  const amount = spec.amount ?? '0'
  const decimals = spec.decimals ?? 6
  const ui = Number(amount) / 10 ** decimals
  const info: Record<string, unknown> = {
    isNative: false,
    mint: spec.mint,
    owner: spec.owner,
    state: spec.state ?? 'initialized',
    tokenAmount: {
      amount,
      decimals,
      uiAmount: ui,
      uiAmountString: String(ui),
    },
  }
  if (spec.closeAuthority) info.closeAuthority = spec.closeAuthority
  if (spec.extensions) info.extensions = spec.extensions
  const space = spec.space ?? (spec.program === 'spl-token' ? 165 : 170)
  return {
    pubkey: spec.pubkey,
    account: {
      data: { program: spec.program, parsed: { info, type: 'account' }, space },
      executable: false,
      lamports: spec.lamports,
      owner: spec.program === 'spl-token' ? SPL_TOKEN : TOKEN_2022,
      rentEpoch: 18446744073709552000,
      space,
    },
  }
}

export type ParsedTokenAccount = ReturnType<typeof parsedTokenAccount>

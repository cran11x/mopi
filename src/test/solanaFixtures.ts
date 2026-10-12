// Shared helpers for the src/lib/solana test suites. Not a test file itself.
import { Keypair, PublicKey } from '@solana/web3.js'
import type { FeeConfig, TokenAccountInfo } from '../lib/types'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../lib/solana/programs'
import type { RawParsedTokenAccount } from '../lib/solana/classify'

export const SPL = TOKEN_PROGRAM_ID.toBase58()
export const T22 = TOKEN_2022_PROGRAM_ID.toBase58()
export const RENT = 2_039_280

export const randomKey = (): PublicKey => Keypair.generate().publicKey
export const randomAddress = (): string => randomKey().toBase58()

export interface InfoOverrides {
  mint?: unknown
  owner?: unknown
  state?: unknown
  isNative?: unknown
  amount?: unknown
  decimals?: unknown
  uiAmountString?: unknown
  closeAuthority?: unknown
  delegate?: unknown
  extensions?: unknown
}

/** jsonParsed `account.data` for a token account. */
export function parsedData(owner: string, over: InfoOverrides = {}, program: string = 'spl-token'): unknown {
  const info: Record<string, unknown> = {
    mint: 'mint' in over ? over.mint : randomAddress(),
    owner: 'owner' in over ? over.owner : owner,
    state: 'state' in over ? over.state : 'initialized',
    isNative: 'isNative' in over ? over.isNative : false,
    tokenAmount: {
      amount: 'amount' in over ? over.amount : '0',
      decimals: 'decimals' in over ? over.decimals : 6,
      uiAmount: 0,
      uiAmountString: 'uiAmountString' in over ? over.uiAmountString : '0',
    },
  }
  if (over.closeAuthority !== undefined) info.closeAuthority = over.closeAuthority
  if (over.delegate !== undefined) info.delegate = over.delegate
  if (over.extensions !== undefined) info.extensions = over.extensions
  return { program, parsed: { type: 'account', info }, space: program === 'spl-token' ? 165 : 182 }
}

export function rawAccount(
  owner: string,
  over: InfoOverrides = {},
  opts: { program?: 'spl-token' | 'spl-token-2022'; lamports?: number; pubkey?: string; programId?: string } = {},
): RawParsedTokenAccount {
  const program = opts.program ?? 'spl-token'
  return {
    pubkey: opts.pubkey ?? randomAddress(),
    lamports: opts.lamports ?? RENT,
    programId: opts.programId ?? (program === 'spl-token' ? SPL : T22),
    data: parsedData(owner, over, program),
  }
}

/** An eligible TokenAccountInfo with a real random address. */
export function eligibleAccount(owner: string, over: Partial<TokenAccountInfo> = {}): TokenAccountInfo {
  return {
    address: randomAddress(),
    mint: randomAddress(),
    owner,
    program: 'spl-token',
    programId: SPL,
    lamports: RENT,
    amountRaw: '0',
    decimals: 6,
    uiAmount: '0',
    isNative: false,
    state: 'initialized',
    closeAuthority: null,
    extensions: [],
    status: 'eligible',
    ...over,
  }
}

export function testFeeConfig(over: Partial<FeeConfig> = {}): FeeConfig {
  return {
    serviceFeeBps: 400,
    feeWallet: randomAddress(),
    baseFeeLamportsPerSignature: 5_000,
    priorityFeeMicroLamports: 20_000,
    computeUnitsPerClose: 6_000,
    computeUnitsBase: 2_000,
    maxClosesPerTx: 20,
    ...over,
  }
}

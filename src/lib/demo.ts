import type { Cluster, FeeConfig, ScanResult, TokenAccountInfo } from './types'
import { CONFIG } from '../config'

// Deterministic demo wallet: 24 eligible, 6 with tokens, 1 unsupported.
// Nothing here touches the network. The UI labels it "Demo estimates".

export const DEMO_OWNER = 'GmaDr7kQ2vNw8XpLs4TfHc9ZyB3uMe6RjWnK5aYqAEGB'

/** Rent-exempt deposit of a 165-byte SPL token account. */
export const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280
/** Rent-exempt deposit of a Token-2022 account carrying the ImmutableOwner + TransferFeeAmount extensions. */
const TOKEN_2022_RENT_LAMPORTS = 2_157_600

const SPL_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    // mulberry32
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function fakeAddress(rand: () => number, head = '', tail = ''): string {
  const len = 44 - head.length - tail.length
  let mid = ''
  for (let i = 0; i < len; i++) mid += B58[Math.floor(rand() * B58.length)]
  return head + mid + tail
}

// First four rows match the concept art.
const FIXED_ENDS: Array<[string, string]> = [
  ['5Qx3', '7K9m'],
  ['9LmH', '2vQf'],
  ['F8tR', '6Z1p'],
  ['3NwK', '9D2a'],
]

const HELD: Array<{ ui: string; raw: string; decimals: number }> = [
  { ui: '1250', raw: '1250000000', decimals: 6 },
  { ui: '0.42', raw: '420000000', decimals: 9 },
  { ui: '88000', raw: '88000000000', decimals: 6 },
  { ui: '3', raw: '3', decimals: 0 },
  { ui: '17.5', raw: '17500000', decimals: 6 },
  { ui: '420.69', raw: '42069000', decimals: 5 },
]

export function createDemoScan(cluster: Cluster = 'mainnet-beta', scannedAt = Date.now()): ScanResult {
  const rand = rng(0x6d6f7069) // "mopi"
  const base = (over: Partial<TokenAccountInfo>): TokenAccountInfo => ({
    address: fakeAddress(rand),
    mint: fakeAddress(rand),
    owner: DEMO_OWNER,
    program: 'spl-token',
    programId: SPL_TOKEN,
    lamports: TOKEN_ACCOUNT_RENT_LAMPORTS,
    amountRaw: '0',
    decimals: 6,
    uiAmount: '0',
    isNative: false,
    state: 'initialized',
    closeAuthority: null,
    extensions: [],
    status: 'eligible',
    ...over,
  })

  const eligible: TokenAccountInfo[] = Array.from({ length: 24 }, (_, i) => {
    const ends = FIXED_ENDS[i]
    return base({
      address: ends ? fakeAddress(rand, ends[0], ends[1]) : fakeAddress(rand),
      decimals: [6, 9, 0, 5][i % 4],
    })
  })

  const withTokens: TokenAccountInfo[] = HELD.map((h) =>
    base({
      amountRaw: h.raw,
      uiAmount: h.ui,
      decimals: h.decimals,
      status: 'has-tokens',
      reasonText: 'Holds tokens — mopi never touches accounts with a balance.',
    }),
  )

  const unsupported: TokenAccountInfo[] = [
    base({
      program: 'token-2022',
      programId: TOKEN_2022,
      lamports: TOKEN_2022_RENT_LAMPORTS,
      extensions: ['immutableOwner', 'transferFeeAmount'],
      status: 'unsupported',
      reason: 'withheld-fees',
      reasonText: 'Token-2022 account with withheld transfer fees. They must be harvested before it can close.',
    }),
  ]

  return {
    owner: DEMO_OWNER,
    cluster,
    scannedAt,
    isDemo: true,
    accounts: [...eligible, ...withTokens, ...unsupported],
    eligible,
    withTokens,
    unsupported,
  }
}

/**
 * Fee config used for demo estimates: the standard service fee is always
 * shown (even when this deployment has no fee wallet) so the demo
 * illustrates the full breakdown. Never used to build real transactions.
 */
export function demoFeeConfig(base: FeeConfig, isHolder: boolean): FeeConfig {
  return {
    ...base,
    feeWallet: base.feeWallet ?? 'demo-fee-wallet',
    serviceFeeBps: isHolder ? CONFIG.holderFeeBps : CONFIG.serviceFeeBps,
  }
}

export function isDemoAddress(input: string): boolean {
  const t = input.trim()
  return t === DEMO_OWNER || t === 'GmaD...AEGB' || t === 'GmaD…AEGB'
}

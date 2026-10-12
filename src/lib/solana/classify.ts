import { PublicKey } from '@solana/web3.js'
import type { TokenAccountInfo, TokenProgramKind, UnsupportedReason } from '../types'
import { programKind } from './programs'

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
 * Token-2022 account extensions that can never block a top-level CloseAccount
 * signed by the owner of an empty account. `transferFeeAmount` is only safe
 * while its withheld amount is zero (checked separately).
 */
export const SAFE_ACCOUNT_EXTENSIONS: ReadonlySet<string> = new Set([
  'immutableOwner',
  'transferFeeAmount',
  'memoTransfer',
  'cpiGuard',
  'nonTransferableAccount',
  'transferHookAccount',
  'pausableAccount',
])

export const REASON_TEXT: Record<UnsupportedReason | 'has-tokens', string> = {
  'has-tokens': 'Holds tokens — mopi never touches accounts with a balance.',
  frozen: "Frozen by the token's freeze authority.",
  uninitialized: 'This token account was never initialized.',
  'close-authority': 'Another address controls closing this account.',
  'withheld-fees': 'Token-2022 account with withheld transfer fees. They must be harvested before it can close.',
  extension: "Uses a Token-2022 extension mopi doesn't support yet.",
  'owner-mismatch': 'This account belongs to a different owner.',
  unparsed: "mopi couldn't read this account's data, so it leaves it alone.",
}

function extensionReasonText(name: string): string {
  return `Uses a Token-2022 extension mopi doesn't support yet (${name}).`
}

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array)
}

function isBase58Pubkey(v: unknown): v is string {
  if (typeof v !== 'string' || v.length < 32 || v.length > 44) return false
  try {
    return new PublicKey(v).toBase58() === v
  } catch {
    return false
  }
}

const STATES = ['initialized', 'frozen', 'uninitialized'] as const
type AccountState = (typeof STATES)[number]

function isState(v: unknown): v is AccountState {
  return typeof v === 'string' && (STATES as readonly string[]).includes(v)
}

const JSON_PROGRAM_KIND: Record<string, TokenProgramKind> = {
  'spl-token': 'spl-token',
  'spl-token-2022': 'token-2022',
}

/** Raw u64 string → ui decimal string ("1500", 3 → "1.5"). */
export function rawToUiAmount(raw: string, decimals: number): string {
  if (!/^\d+$/.test(raw)) return raw
  const digits = raw.replace(/^0+(?=\d)/, '')
  if (decimals <= 0) return digits
  const padded = digits.padStart(decimals + 1, '0')
  const whole = padded.slice(0, padded.length - decimals)
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole
}

/** Parses an integer amount that may be a number, numeric string or bigint. null when malformed. */
function parseAmount(v: unknown): bigint | null {
  if (typeof v === 'bigint') return v >= 0n ? v : null
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return BigInt(v.trim())
  return null
}

interface ParsedInfo {
  mint: string
  owner: string
  state: AccountState
  isNative: boolean
  amountRaw: string
  decimals: number
  uiAmount: string
  closeAuthority: string | null
  extensions: Array<{ name: string; state: unknown } | null>
}

/** Validates the jsonParsed shape. Returns null on anything unexpected. */
function readInfo(data: unknown): { program: TokenProgramKind; info: ParsedInfo } | null {
  if (!isObj(data)) return null
  const program = typeof data.program === 'string' ? JSON_PROGRAM_KIND[data.program] : undefined
  if (!program) return null
  const parsed = data.parsed
  if (!isObj(parsed) || parsed.type !== 'account') return null
  const info = parsed.info
  if (!isObj(info)) return null

  const { mint, owner, state, tokenAmount } = info
  if (typeof mint !== 'string' || mint === '' || typeof owner !== 'string' || owner === '') return null
  if (!isState(state)) return null
  if (!isObj(tokenAmount)) return null
  const amount = tokenAmount.amount
  const decimals = tokenAmount.decimals
  if (typeof amount !== 'string' || !/^\d+$/.test(amount)) return null
  if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) return null
  if (info.isNative !== undefined && typeof info.isNative !== 'boolean') return null

  let closeAuthority: string | null = null
  if (info.closeAuthority !== undefined && info.closeAuthority !== null) {
    if (typeof info.closeAuthority !== 'string') return null
    closeAuthority = info.closeAuthority
  }

  const extensions: ParsedInfo['extensions'] = []
  if (info.extensions !== undefined && info.extensions !== null) {
    if (!Array.isArray(info.extensions)) return null
    for (const ext of info.extensions) {
      if (isObj(ext) && typeof ext.extension === 'string' && ext.extension !== '') {
        extensions.push({ name: ext.extension, state: ext.state })
      } else {
        // Present but unreadable: never treated as harmless.
        extensions.push(null)
      }
    }
  }

  const uiAmount =
    typeof tokenAmount.uiAmountString === 'string' && tokenAmount.uiAmountString !== ''
      ? tokenAmount.uiAmountString
      : rawToUiAmount(amount, decimals)

  return {
    program,
    info: {
      mint,
      owner,
      state,
      isNative: info.isNative === true,
      amountRaw: amount,
      decimals,
      uiAmount,
      closeAuthority,
      extensions,
    },
  }
}

/** First reason an extension list blocks the close, or null if every extension is harmless. */
function extensionBlocker(
  extensions: ParsedInfo['extensions'],
): { reason: 'withheld-fees' | 'extension'; text: string } | null {
  for (const ext of extensions) {
    if (!ext) return { reason: 'extension', text: extensionReasonText('unknown') }
    if (!SAFE_ACCOUNT_EXTENSIONS.has(ext.name)) return { reason: 'extension', text: extensionReasonText(ext.name) }
    if (ext.name === 'transferFeeAmount') {
      const withheld = isObj(ext.state) ? parseAmount(ext.state.withheldAmount) : null
      // Can't prove it's zero → don't close.
      if (withheld === null) return { reason: 'extension', text: extensionReasonText(ext.name) }
      if (withheld > 0n) return { reason: 'withheld-fees', text: REASON_TEXT['withheld-fees'] }
    }
  }
  return null
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
export function classifyTokenAccount(raw: RawParsedTokenAccount, walletOwner: string): TokenAccountInfo {
  const r: Partial<RawParsedTokenAccount> = isObj(raw) ? raw : {}
  const address = typeof r.pubkey === 'string' ? r.pubkey : ''
  const programId = typeof r.programId === 'string' ? r.programId : ''
  const lamports =
    typeof r.lamports === 'number' && Number.isSafeInteger(r.lamports) && r.lamports >= 0 ? r.lamports : 0
  const kindFromId = programKind(programId)

  let parsed: ReturnType<typeof readInfo> = null
  try {
    parsed = readInfo(r.data)
  } catch {
    parsed = null
  }

  const validRaw =
    isBase58Pubkey(address) &&
    kindFromId !== null &&
    typeof r.lamports === 'number' &&
    Number.isSafeInteger(r.lamports) &&
    r.lamports >= 0

  if (!parsed || !validRaw || parsed.program !== kindFromId) {
    return {
      address,
      mint: parsed?.info.mint ?? '',
      owner: parsed?.info.owner ?? '',
      program: kindFromId ?? parsed?.program ?? 'spl-token',
      programId,
      lamports,
      amountRaw: parsed?.info.amountRaw ?? '0',
      decimals: parsed?.info.decimals ?? 0,
      uiAmount: parsed?.info.uiAmount ?? '0',
      isNative: parsed?.info.isNative ?? false,
      state: parsed?.info.state ?? 'uninitialized',
      closeAuthority: parsed?.info.closeAuthority ?? null,
      extensions: parsed ? parsed.info.extensions.map((e) => e?.name ?? 'unknown') : [],
      status: 'unsupported',
      reason: 'unparsed',
      reasonText: REASON_TEXT.unparsed,
    }
  }

  const { info } = parsed
  const base: TokenAccountInfo = {
    address,
    mint: info.mint,
    owner: info.owner,
    program: kindFromId,
    programId,
    lamports,
    amountRaw: info.amountRaw,
    decimals: info.decimals,
    uiAmount: info.uiAmount,
    isNative: info.isNative,
    state: info.state,
    closeAuthority: info.closeAuthority,
    extensions: info.extensions.map((e) => e?.name ?? 'unknown'),
    status: 'eligible',
  }

  const unsupported = (reason: UnsupportedReason, reasonText = REASON_TEXT[reason]): TokenAccountInfo => ({
    ...base,
    status: 'unsupported',
    reason,
    reasonText,
  })

  // 2. Not this wallet's account.
  if (info.owner !== walletOwner) return unsupported('owner-mismatch')
  // 3. Any balance (wrapped SOL included — mopi never unwraps).
  if (info.amountRaw !== '0') return { ...base, status: 'has-tokens', reasonText: REASON_TEXT['has-tokens'] }
  // 4. Account state.
  if (info.state === 'frozen') return unsupported('frozen')
  if (info.state === 'uninitialized') return unsupported('uninitialized')
  // 5. Someone else must sign the close.
  if (info.closeAuthority !== null && info.closeAuthority !== walletOwner) return unsupported('close-authority')
  // 6. Token-2022 extensions (allowlist).
  const blocker = extensionBlocker(info.extensions)
  if (blocker) return unsupported(blocker.reason, blocker.text)
  // 7.
  return base
}

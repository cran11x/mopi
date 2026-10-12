import { Buffer } from 'buffer'
import type { AccountInfo, PublicKey } from '@solana/web3.js'
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getCpiGuard,
  getExtensionTypes,
  getMemoTransfer,
  getTransferFeeAmount,
  getTransferHookAccount,
  unpackAccount,
  unpackMint,
} from '@solana/spl-token'

// jsonParsed encoding of token accounts, mirroring Agave's
// solana-account-decoder (parse_token.rs / parse_token_extension.rs) so the
// app's classifier sees what mainnet RPCs return:
//
//   { program: 'spl-token' | 'spl-token-2022',
//     parsed: { type: 'account', info: { isNative, mint, owner, state,
//               tokenAmount, delegate?, delegatedAmount?, closeAuthority?,
//               rentExemptReserve?, extensions? } },
//     space }
//
// Optional fields are omitted (not null) when absent, as serde's
// skip_serializing_if does. `extensions` only appears for Token-2022 accounts
// that have at least one, in on-chain TLV order. Unit extensions carry no
// `state` key ({ extension: 'immutableOwner' }).

export interface UiTokenAmount {
  amount: string
  decimals: number
  uiAmount: number
  uiAmountString: string
}

export interface UiExtension {
  extension: string
  state?: Record<string, unknown>
}

export interface ParsedTokenAccountData {
  program: 'spl-token' | 'spl-token-2022'
  parsed: {
    type: 'account'
    info: {
      isNative: boolean
      mint: string
      owner: string
      state: 'uninitialized' | 'initialized' | 'frozen'
      tokenAmount: UiTokenAmount
      delegate?: string
      delegatedAmount?: UiTokenAmount
      closeAuthority?: string
      rentExemptReserve?: UiTokenAmount
      extensions?: UiExtension[]
    }
  }
  space: number
}

/** Agave's real_number_string_trimmed. */
export function uiAmountString(amount: bigint, decimals: number): string {
  const digits = amount.toString()
  if (decimals === 0) return digits
  const padded = digits.padStart(decimals + 1, '0')
  const whole = padded.slice(0, padded.length - decimals)
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole
}

export function uiTokenAmount(amount: bigint, decimals: number): UiTokenAmount {
  const s = uiAmountString(amount, decimals)
  return { amount: amount.toString(), decimals, uiAmount: Number(s), uiAmountString: s }
}

/** ExtensionType → the camelCase tag Agave's UiExtension uses. */
export function extensionName(type: ExtensionType): string {
  const name = ExtensionType[type] as string | undefined
  if (!name) return 'unparseableExtension'
  return name[0].toLowerCase() + name.slice(1)
}

function toBuffer(data: Uint8Array): Buffer {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
}

function bufferInfo(info: AccountInfo<Uint8Array>): AccountInfo<Buffer> {
  return { ...info, data: toBuffer(info.data) }
}

/**
 * jsonParsed `data` for a token account, or null when Agave could not parse it
 * either (not a token account, a mint, unknown mint, malformed data) — the RPC
 * then drops it from getTokenAccountsByOwner, or falls back to base64.
 */
export function parseTokenAccount(
  address: PublicKey,
  info: AccountInfo<Uint8Array>,
  getAccount: (key: PublicKey) => AccountInfo<Uint8Array> | null,
): ParsedTokenAccountData | null {
  const programId = info.owner
  const is2022 = programId.equals(TOKEN_2022_PROGRAM_ID)
  if (!is2022 && !programId.equals(TOKEN_PROGRAM_ID)) return null
  let account
  try {
    account = unpackAccount(address, bufferInfo(info), programId)
  } catch {
    return null
  }
  const mintInfo = getAccount(account.mint)
  if (!mintInfo || !mintInfo.owner.equals(programId)) return null
  let decimals: number
  try {
    decimals = unpackMint(account.mint, bufferInfo(mintInfo), programId).decimals
  } catch {
    return null
  }

  const parsedInfo: ParsedTokenAccountData['parsed']['info'] = {
    isNative: account.isNative,
    mint: account.mint.toBase58(),
    owner: account.owner.toBase58(),
    state: account.isFrozen ? 'frozen' : account.isInitialized ? 'initialized' : 'uninitialized',
    tokenAmount: uiTokenAmount(account.amount, decimals),
  }
  if (account.delegate) {
    parsedInfo.delegate = account.delegate.toBase58()
    parsedInfo.delegatedAmount = uiTokenAmount(account.delegatedAmount, decimals)
  }
  if (account.isNative && account.rentExemptReserve !== null) {
    parsedInfo.rentExemptReserve = uiTokenAmount(account.rentExemptReserve, decimals)
  }
  if (account.closeAuthority) parsedInfo.closeAuthority = account.closeAuthority.toBase58()

  if (is2022 && account.tlvData.length > 0) {
    const extensions: UiExtension[] = []
    for (const type of getExtensionTypes(account.tlvData)) {
      if (type === ExtensionType.Uninitialized) break
      extensions.push(extensionJson(type, account))
    }
    if (extensions.length > 0) parsedInfo.extensions = extensions
  }

  return {
    program: is2022 ? 'spl-token-2022' : 'spl-token',
    parsed: { type: 'account', info: parsedInfo },
    space: info.data.length,
  }
}

function extensionJson(type: ExtensionType, account: ReturnType<typeof unpackAccount>): UiExtension {
  const extension = extensionName(type)
  switch (type) {
    case ExtensionType.TransferFeeAmount: {
      const fee = getTransferFeeAmount(account)
      // u64 serialized as a JSON number, exactly like the RPC.
      return { extension, state: { withheldAmount: Number(fee?.withheldAmount ?? 0n) } }
    }
    case ExtensionType.MemoTransfer:
      return { extension, state: { requireIncomingTransferMemos: Boolean(getMemoTransfer(account)?.requireIncomingTransferMemos) } }
    case ExtensionType.CpiGuard:
      return { extension, state: { lockCpi: Boolean(getCpiGuard(account)?.lockCpi) } }
    case ExtensionType.TransferHookAccount:
      return { extension, state: { transferring: Boolean(getTransferHookAccount(account)?.transferring) } }
    case ExtensionType.ImmutableOwner:
    case ExtensionType.NonTransferableAccount:
    case ExtensionType.PausableAccount:
      return { extension }
    default:
      // Confidential-transfer states etc. are not modelled; the tag is enough
      // for mopi, which refuses any extension it does not know.
      return { extension, state: {} }
  }
}

/** True for a token account whose jsonParsed form says it belongs to `owner`. */
export function isOwnedTokenAccount(parsed: ParsedTokenAccountData | null, owner: string): parsed is ParsedTokenAccountData {
  return parsed !== null && parsed.parsed.info.owner === owner
}

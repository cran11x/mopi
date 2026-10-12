import { PublicKey, type Connection } from '@solana/web3.js'
import { CONFIG } from '../../config'
import type { HolderStatus } from '../types'

export interface HolderCheckConfig {
  /** $MOPI mint (base58); null/empty → not configured, no RPC call. */
  mint: string | null
  /** Whole tokens required for holder access. */
  minRequired: number
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null

/**
 * Whole-token total from jsonParsed token accounts of `mint` owned by `owner`.
 * Raw amounts are summed with BigInt; the result is floored to whole tokens.
 * Entries for another mint/owner or with an unreadable shape are ignored.
 */
export function sumWholeTokens(accounts: readonly unknown[], mint: string, owner: string): bigint {
  let raw = 0n
  let decimals: number | null = null
  for (const entry of accounts) {
    const data = isObj(entry) && isObj(entry.account) ? entry.account.data : undefined
    const info = isObj(data) && isObj(data.parsed) && isObj(data.parsed.info) ? data.parsed.info : undefined
    if (!info || info.mint !== mint || info.owner !== owner || !isObj(info.tokenAmount)) continue
    const { amount, decimals: d } = info.tokenAmount
    if (typeof amount !== 'string' || !/^\d+$/.test(amount)) continue
    if (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > 255) continue
    if (decimals === null) decimals = d
    else if (decimals !== d) continue // a mint has one decimals value; ignore inconsistent data
    raw += BigInt(amount)
  }
  if (decimals === null) return 0n
  return raw / 10n ** BigInt(decimals)
}

/** Holder check with an explicit config (testable; `getHolderStatus` passes CONFIG). */
export async function checkHolderStatus(
  connection: Connection,
  owner: PublicKey,
  config: HolderCheckConfig,
): Promise<HolderStatus> {
  const minRequired = config.minRequired
  if (!config.mint) {
    return { mintConfigured: false, checked: false, isHolder: false, balanceUi: 0, minRequired }
  }
  const mint = new PublicKey(config.mint)
  const ownerB58 = owner.toBase58()
  const res = await connection.getParsedTokenAccountsByOwner(owner, { mint }, 'confirmed')
  const whole = sumWholeTokens(Array.isArray(res?.value) ? res.value : [], mint.toBase58(), ownerB58)
  const balanceUi = whole > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(whole)
  return {
    mintConfigured: true,
    checked: true,
    isHolder: whole >= BigInt(Math.max(0, Math.floor(minRequired))),
    balanceUi,
    minRequired,
  }
}

/**
 * $MOPI holder check: sums the owner's balance of CONFIG.mopiMint across SPL
 * Token and Token-2022 accounts. Returns mintConfigured=false (no RPC call)
 * when no mint is configured.
 */
export async function getHolderStatus(connection: Connection, owner: PublicKey): Promise<HolderStatus> {
  return checkHolderStatus(connection, owner, { mint: CONFIG.mopiMint, minRequired: CONFIG.holderMin })
}

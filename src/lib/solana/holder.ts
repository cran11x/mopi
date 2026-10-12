import type { Connection, PublicKey } from '@solana/web3.js'
import type { HolderStatus } from '../types'

/**
 * $MOPI holder check: sums the owner's balance of CONFIG.mopiMint across SPL
 * Token and Token-2022 accounts. Returns mintConfigured=false (no RPC call)
 * when no mint is configured.
 */
export async function getHolderStatus(_connection: Connection, _owner: PublicKey): Promise<HolderStatus> {
  throw new Error('getHolderStatus: not implemented')
}

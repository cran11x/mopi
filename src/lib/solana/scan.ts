import type { Connection, PublicKey } from '@solana/web3.js'
import type { Cluster, ScanResult } from '../types'

/**
 * Reads every token account owned by `owner` under both the SPL Token and
 * Token-2022 programs (jsonParsed), classifies them, and returns them sorted
 * eligible → has-tokens → unsupported. Read-only; never signs anything.
 */
export async function scanWallet(
  _connection: Connection,
  _owner: PublicKey,
  _opts: { cluster: Cluster; signal?: AbortSignal },
): Promise<ScanResult> {
  throw new Error('scanWallet: not implemented')
}

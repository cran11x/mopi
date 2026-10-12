// Shared domain types. Every layer (scanner, fee math, transaction builder,
// state, UI) speaks in these shapes. Amounts are always integer lamports;
// format only at the edge (see ./format.ts).

export type Cluster = 'mainnet-beta' | 'devnet'

export type TokenProgramKind = 'spl-token' | 'token-2022'

/**
 * eligible     – 0 tokens, closable by the owner, mopi can close it.
 * has-tokens   – holds a non-zero token balance; never touched.
 * unsupported  – empty, but mopi will not close it (frozen, foreign close
 *                authority, Token-2022 extension we don't handle, …).
 */
export type AccountStatus = 'eligible' | 'has-tokens' | 'unsupported'

export type UnsupportedReason =
  | 'frozen'
  | 'uninitialized'
  | 'close-authority'
  | 'withheld-fees'
  | 'extension'
  | 'owner-mismatch'
  | 'unparsed'

export interface TokenAccountInfo {
  /** Token account address (base58). */
  address: string
  mint: string
  /** Token account owner as reported on-chain. */
  owner: string
  program: TokenProgramKind
  programId: string
  /** Account SOL (rent deposit) held by the token account, in lamports. */
  lamports: number
  /** Raw u64 token amount as a decimal string. */
  amountRaw: string
  decimals: number
  /** Human token amount as a decimal string ("0", "12.5"). */
  uiAmount: string
  /** Wrapped SOL account. */
  isNative: boolean
  state: 'initialized' | 'frozen' | 'uninitialized'
  closeAuthority: string | null
  /** Token-2022 extension names as reported by jsonParsed RPC (empty for SPL Token). */
  extensions: string[]
  status: AccountStatus
  reason?: UnsupportedReason
  /** Short human explanation for skipped accounts. */
  reasonText?: string
}

export interface ScanResult {
  owner: string
  cluster: Cluster
  /** ms since epoch */
  scannedAt: number
  isDemo: boolean
  /** All accounts, eligible first, then has-tokens, then unsupported. */
  accounts: TokenAccountInfo[]
  eligible: TokenAccountInfo[]
  withTokens: TokenAccountInfo[]
  unsupported: TokenAccountInfo[]
}

export interface FeeConfig {
  /** Service fee in basis points of reclaimed account SOL. */
  serviceFeeBps: number
  /** Recipient of the service fee; null means no service fee and no transfer instruction. */
  feeWallet: string | null
  /** Base fee per signature (5000 lamports on Solana). */
  baseFeeLamportsPerSignature: number
  /** Priority fee price in micro-lamports per compute unit (0 disables the price instruction). */
  priorityFeeMicroLamports: number
  /** Compute unit budget reserved per CloseAccount instruction. */
  computeUnitsPerClose: number
  /** Compute units reserved for compute-budget + fee-transfer instructions. */
  computeUnitsBase: number
  /** Max CloseAccount instructions per transaction (tx size limit is 1232 bytes). */
  maxClosesPerTx: number
}

export interface CleanupBatch {
  index: number
  accounts: TokenAccountInfo[]
  reclaimLamports: number
  serviceFeeLamports: number
  networkFeeLamports: number
  computeUnitLimit: number
}

export interface CleanupQuote {
  accountCount: number
  /** "Account SOL detected" for the selected accounts. */
  reclaimLamports: number
  /** Estimated network fee (base + priority) across all batches. */
  networkFeeLamports: number
  serviceFeeLamports: number
  serviceFeeBps: number
  /** Estimated return to the wallet. Never negative. */
  netLamports: number
  batches: CleanupBatch[]
  isHolderRate: boolean
}

export type BatchStatus =
  | 'pending'
  | 'simulating'
  | 'awaiting-signature'
  | 'sending'
  | 'confirmed'
  | 'failed'
  | 'skipped'

export interface BatchProgress {
  index: number
  status: BatchStatus
  accountCount: number
  reclaimLamports: number
  signature?: string
  error?: string
}

export type CleanupPhase = 'idle' | 'review' | 'executing' | 'done' | 'error'

export interface HolderStatus {
  /** False until a $MOPI mint is configured — perks are then "planned". */
  mintConfigured: boolean
  /** Whether a check ran for the connected wallet. */
  checked: boolean
  isHolder: boolean
  /** Whole-token balance. */
  balanceUi: number
  minRequired: number
}

export interface SavedWallet {
  id: string
  label: string
  address: string
  addedAt: number
  lastScan?: {
    at: number
    cluster: Cluster
    eligible: number
    reclaimLamports: number
  }
}

/** Minimal wallet surface the cleanup executor needs (matches wallet-adapter's useWallet()). */
export interface CleanupWallet {
  publicKey: import('@solana/web3.js').PublicKey | null
  signAllTransactions?: <T extends import('@solana/web3.js').VersionedTransaction>(txs: T[]) => Promise<T[]>
  signTransaction?: <T extends import('@solana/web3.js').VersionedTransaction>(tx: T) => Promise<T>
}

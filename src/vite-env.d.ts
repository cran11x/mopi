/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Mainnet RPC endpoint. Defaults to the public Solana endpoint (rate limited). */
  readonly VITE_SOLANA_RPC_URL?: string
  /** Devnet RPC endpoint. */
  readonly VITE_SOLANA_DEVNET_RPC_URL?: string
  /** Wallet that receives the service fee. When empty, no service fee is charged. */
  readonly VITE_FEE_WALLET?: string
  /** Service fee in basis points of reclaimed account SOL (default 400 = 4%). */
  readonly VITE_SERVICE_FEE_BPS?: string
  /** Service fee for $MOPI holders in basis points (default 200 = 2%). */
  readonly VITE_HOLDER_FEE_BPS?: string
  /** $MOPI mint address. When empty, holder perks are shown as planned. */
  readonly VITE_MOPI_MINT?: string
  /** Minimum $MOPI balance (UI units) for holder access. */
  readonly VITE_MOPI_HOLDER_MIN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

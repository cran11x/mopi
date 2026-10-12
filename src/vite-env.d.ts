/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Mainnet RPC endpoint. Defaults to the public Solana endpoint (rate limited). */
  readonly VITE_SOLANA_RPC_URL?: string
  /** Devnet RPC endpoint. */
  readonly VITE_SOLANA_DEVNET_RPC_URL?: string
  /** Comma-separated https mainnet fallback endpoints ("none" disables; default: publicnode). */
  readonly VITE_SOLANA_RPC_FALLBACKS?: string
  /** Comma-separated https devnet fallback endpoints (default: none). */
  readonly VITE_SOLANA_DEVNET_RPC_FALLBACKS?: string
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
  /** Public origin (build time only): canonical link and absolute og:image. */
  readonly VITE_SITE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

import type { ReactNode } from 'react'
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react'
import type { WalletError } from '@solana/wallet-adapter-base'
import type { ConnectionConfig } from '@solana/web3.js'
import { ClusterProvider, useCluster } from './cluster'
import { WalletModalProvider } from './walletModal'
import { CleanerProvider } from './cleaner'

// Wallet Standard wallets (Phantom, Solflare, Backpack, …) register
// themselves, so no adapter list is needed.
const NO_ADAPTERS: never[] = []

/** Backoff before each retry of an HTTP 429 (rate limited) RPC answer. */
const RATE_LIMIT_RETRIES_MS = [600, 1200]

/**
 * web3.js on its own retries a 429 four times (0.5 → 4 s, about 15 s of
 * spinner) before the user hears anything. Retry briefly here instead, then
 * let the 429 through so the app can say "rate limited" within ~2 s.
 */
const fetchWithShortRetry: NonNullable<ConnectionConfig['fetch']> = async (input, init) => {
  let res = await fetch(input, init)
  for (const wait of RATE_LIMIT_RETRIES_MS) {
    if (res.status !== 429) break
    await new Promise((r) => setTimeout(r, wait))
    res = await fetch(input, init)
  }
  return res
}

// Stable identity: ConnectionProvider rebuilds its Connection whenever
// `config` changes, so an inline object would create one per render.
const CONNECTION_CONFIG: ConnectionConfig = {
  commitment: 'confirmed',
  disableRetryOnRateLimit: true,
  fetch: fetchWithShortRetry,
}

function onWalletError(error: WalletError) {
  console.warn('[mopi] wallet error', error)
}

function SolanaProviders({ children }: { children: ReactNode }) {
  const { rpcUrl } = useCluster()
  // A new endpoint yields a new Connection; the cleaner re-scans on cluster
  // change, so the tree is not remounted (menus and wallet state survive).
  return (
    <ConnectionProvider endpoint={rpcUrl} config={CONNECTION_CONFIG}>
      <WalletProvider wallets={NO_ADAPTERS} autoConnect onError={onWalletError}>
        <WalletModalProvider>
          <CleanerProvider>{children}</CleanerProvider>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  )
}

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ClusterProvider>
      <SolanaProviders>{children}</SolanaProviders>
    </ClusterProvider>
  )
}

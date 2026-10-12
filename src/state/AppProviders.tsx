import type { ReactNode } from 'react'
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react'
import type { WalletError } from '@solana/wallet-adapter-base'
import type { ConnectionConfig } from '@solana/web3.js'
import { RPC_FALLBACKS, RPC_URLS } from '../config'
import { createFailoverFetch } from '../lib/solana/rpc'
import type { Cluster } from '../lib/types'
import { ClusterProvider, useCluster } from './cluster'
import { WalletModalProvider } from './walletModal'
import { CleanerProvider } from './cleaner'

// Wallet Standard wallets (Phantom, Solflare, Backpack, …) register
// themselves, so no adapter list is needed.
const NO_ADAPTERS: never[] = []

/**
 * One Connection config per cluster, built once (stable identity:
 * ConnectionProvider rebuilds its Connection whenever `config` changes). Its
 * fetch fails over to the configured fallback endpoints on network errors and
 * HTTP 5xx / 403 / 429 and remembers the endpoint that answered, per cluster.
 * A 429 is first retried briefly (0.6 s, 1.2 s) instead of web3.js's own
 * ~15 s backoff, so the app can say "rate limited" quickly.
 */
const CONNECTION_CONFIGS: Record<Cluster, ConnectionConfig> = {
  'mainnet-beta': connectionConfigFor('mainnet-beta'),
  devnet: connectionConfigFor('devnet'),
}

function connectionConfigFor(cluster: Cluster): ConnectionConfig {
  return {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
    fetch: createFailoverFetch({ endpoints: [RPC_URLS[cluster], ...RPC_FALLBACKS[cluster]] }),
  }
}

function onWalletError(error: WalletError) {
  console.warn('[mopi] wallet error', error)
}

function SolanaProviders({ children }: { children: ReactNode }) {
  const { rpcUrl, cluster } = useCluster()
  // A new endpoint yields a new Connection; the cleaner re-scans on cluster
  // change, so the tree is not remounted (menus and wallet state survive).
  return (
    <ConnectionProvider endpoint={rpcUrl} config={CONNECTION_CONFIGS[cluster]}>
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

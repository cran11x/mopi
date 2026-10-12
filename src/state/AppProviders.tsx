import { useMemo, type ReactNode } from 'react'
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react'
import type { WalletError } from '@solana/wallet-adapter-base'
import type { ConnectionConfig } from '@solana/web3.js'
import { RPC_FALLBACKS } from '../config'
import { createFailoverFetch } from '../lib/solana/rpc'
import type { Cluster } from '../lib/types'
import { ClusterProvider, useCluster } from './cluster'
import { WalletModalProvider } from './walletModal'
import { CleanerProvider } from './cleaner'

// Wallet Standard wallets (Phantom, Solflare, Backpack, …) register
// themselves, so no adapter list is needed.
const NO_ADAPTERS: never[] = []

/**
 * Connection config for the active endpoint, memoised on (cluster, endpoint)
 * (stable identity: ConnectionProvider rebuilds its Connection whenever
 * `config` changes). The endpoint is the viewer's custom RPC or the
 * deployment default; its
 * fetch bounds every attempt (RPC_ATTEMPT_TIMEOUT_MS), fails over to the
 * configured fallback endpoints on network errors, timeouts and endpoint-level
 * HTTP errors (401/402/403/404/408/410/429/5xx) and remembers the endpoint
 * that answered, per cluster.
 * A 429 is first retried briefly (0.6 s, 1.2 s) instead of web3.js's own
 * ~15 s backoff, so the app can say "rate limited" quickly.
 */
function connectionConfigFor(cluster: Cluster, primary: string): ConnectionConfig {
  const fallbacks = RPC_FALLBACKS[cluster].filter((u) => u.replace(/\/+$/, '') !== primary.replace(/\/+$/, ''))
  return {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
    fetch: createFailoverFetch({ endpoints: [primary, ...fallbacks] }),
  }
}

function onWalletError(error: WalletError) {
  console.warn('[mopi] wallet error', error)
}

function SolanaProviders({ children }: { children: ReactNode }) {
  const { rpcUrl, cluster } = useCluster()
  const config = useMemo(() => connectionConfigFor(cluster, rpcUrl), [cluster, rpcUrl])
  // A new endpoint yields a new Connection; the cleaner re-scans on cluster
  // change, so the tree is not remounted (menus and wallet state survive).
  return (
    <ConnectionProvider endpoint={rpcUrl} config={config}>
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

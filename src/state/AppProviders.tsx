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

// Stable identity: ConnectionProvider rebuilds its Connection whenever
// `config` changes, so an inline object would create one per render.
const CONNECTION_CONFIG: ConnectionConfig = { commitment: 'confirmed' }

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

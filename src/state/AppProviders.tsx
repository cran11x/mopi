import type { ReactNode } from 'react'
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react'
import type { WalletError } from '@solana/wallet-adapter-base'
import { ClusterProvider, useCluster } from './cluster'
import { WalletModalProvider } from './walletModal'
import { CleanerProvider } from './cleaner'

// Wallet Standard wallets (Phantom, Solflare, Backpack, …) register
// themselves, so no adapter list is needed.
const NO_ADAPTERS: never[] = []

function onWalletError(error: WalletError) {
  console.warn('[mopi] wallet error', error)
}

function SolanaProviders({ children }: { children: ReactNode }) {
  const { rpcUrl, cluster } = useCluster()
  return (
    <ConnectionProvider key={cluster} endpoint={rpcUrl} config={{ commitment: 'confirmed' }}>
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

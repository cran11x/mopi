import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { CLUSTER_LABELS, RPC_URLS } from '../config'
import type { Cluster } from '../lib/types'

const STORAGE_KEY = 'mopi:cluster'

function readStoredCluster(): Cluster {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY)
    if (v === 'mainnet-beta' || v === 'devnet') return v
  } catch {
    /* storage unavailable */
  }
  return 'mainnet-beta'
}

interface ClusterApi {
  cluster: Cluster
  label: string
  rpcUrl: string
  setCluster: (c: Cluster) => void
}

const ClusterContext = createContext<ClusterApi | null>(null)

export function ClusterProvider({ children }: { children: ReactNode }) {
  const [cluster, setClusterState] = useState<Cluster>(readStoredCluster)
  const setCluster = useCallback((c: Cluster) => {
    setClusterState(c)
    try {
      window.localStorage.setItem(STORAGE_KEY, c)
    } catch {
      /* storage unavailable */
    }
  }, [])
  const value = useMemo(
    () => ({ cluster, label: CLUSTER_LABELS[cluster], rpcUrl: RPC_URLS[cluster], setCluster }),
    [cluster, setCluster],
  )
  return <ClusterContext.Provider value={value}>{children}</ClusterContext.Provider>
}

export function useCluster(): ClusterApi {
  const ctx = useContext(ClusterContext)
  if (!ctx) throw new Error('useCluster must be used inside <ClusterProvider>')
  return ctx
}

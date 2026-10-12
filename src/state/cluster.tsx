import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { CLUSTER_LABELS, RPC_URLS } from '../config'
import type { Cluster } from '../lib/types'

const STORAGE_KEY = 'mopi:cluster'
const rpcKey = (c: Cluster) => `mopi:rpc:${c}`

/** Accepts https endpoints (and http on localhost for development). Returns the normalised URL or null. */
export function normaliseRpcUrl(input: string): string | null {
  const t = input.trim()
  if (!t) return null
  try {
    const u = new URL(t)
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
    if (u.protocol === 'https:' || (u.protocol === 'http:' && local)) return u.toString().replace(/\/$/, '')
  } catch {
    /* invalid */
  }
  return null
}

function readCustomRpc(c: Cluster): string | null {
  try {
    const v = window.localStorage.getItem(rpcKey(c))
    return v ? normaliseRpcUrl(v) : null
  } catch {
    return null
  }
}

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
  /** Endpoint in use: the viewer's custom RPC for this cluster, else the deployment default. */
  rpcUrl: string
  /** Custom RPC saved in this browser for the current cluster, or null. */
  customRpc: string | null
  /** Saves (or clears with null) the custom RPC for the current cluster. Returns an error message or null. */
  setCustomRpc: (url: string | null) => string | null
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
  const [customRpcs, setCustomRpcs] = useState<Record<Cluster, string | null>>(() => ({
    'mainnet-beta': readCustomRpc('mainnet-beta'),
    devnet: readCustomRpc('devnet'),
  }))
  const setCustomRpc = useCallback(
    (url: string | null): string | null => {
      const next = url === null || url.trim() === '' ? null : normaliseRpcUrl(url)
      if (url !== null && url.trim() !== '' && !next) return 'Enter a valid https:// RPC URL.'
      setCustomRpcs((prev) => ({ ...prev, [cluster]: next }))
      try {
        if (next) window.localStorage.setItem(rpcKey(cluster), next)
        else window.localStorage.removeItem(rpcKey(cluster))
      } catch {
        /* storage unavailable: applies for this visit only */
      }
      return null
    },
    [cluster],
  )
  const customRpc = customRpcs[cluster]
  const value = useMemo(
    () => ({
      cluster,
      label: CLUSTER_LABELS[cluster],
      rpcUrl: customRpc ?? RPC_URLS[cluster],
      customRpc,
      setCustomRpc,
      setCluster,
    }),
    [cluster, customRpc, setCustomRpc, setCluster],
  )
  return <ClusterContext.Provider value={value}>{children}</ClusterContext.Provider>
}

export function useCluster(): ClusterApi {
  const ctx = useContext(ClusterContext)
  if (!ctx) throw new Error('useCluster must be used inside <ClusterProvider>')
  return ctx
}

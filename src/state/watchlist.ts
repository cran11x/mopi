import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { PublicKey } from '@solana/web3.js'
import { CONFIG } from '../config'
import type { SavedWallet } from '../lib/types'
import { useCleaner } from './cleaner'

// Saved wallet watchlist. Lives only in this browser (localStorage), shared
// across components through a tiny module-level store + useSyncExternalStore.

export const WATCHLIST_STORAGE_KEY = 'mopi:watchlist'
export const WATCHLIST_LABEL_MAX = 32

/* ---------- pure helpers (unit tested) ---------- */

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

/** Canonical base58 address, or null when `input` is not a valid Solana address. */
export function normalizeAddress(input: string): string | null {
  const t = input.trim()
  if (!BASE58_RE.test(t)) return null
  try {
    const key = new PublicKey(t)
    const b58 = key.toBase58()
    return b58 === t ? b58 : null
  } catch {
    return null
  }
}

function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch {
    /* insecure context */
  }
  return `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function isSavedWallet(v: unknown): v is SavedWallet {
  if (!v || typeof v !== 'object') return false
  const w = v as Record<string, unknown>
  return (
    typeof w.id === 'string' &&
    typeof w.label === 'string' &&
    typeof w.address === 'string' &&
    typeof w.addedAt === 'number' &&
    normalizeAddress(w.address) !== null
  )
}

/** Parses stored JSON defensively: drops malformed entries and duplicates. */
export function parseStored(raw: string | null): SavedWallet[] {
  if (!raw) return []
  try {
    const data: unknown = JSON.parse(raw)
    if (!Array.isArray(data)) return []
    const seen = new Set<string>()
    const out: SavedWallet[] = []
    for (const item of data) {
      if (!isSavedWallet(item) || seen.has(item.address)) continue
      seen.add(item.address)
      out.push(item)
    }
    return out
  } catch {
    return []
  }
}

export type AddResult = { ok: true; wallets: SavedWallet[] } | { ok: false; error: string }

export function addWallet(
  wallets: SavedWallet[],
  label: string,
  address: string,
  limit: number | null,
  now = Date.now(),
): AddResult {
  const normalized = normalizeAddress(address)
  if (!address.trim()) return { ok: false, error: 'Paste a wallet address to save.' }
  if (!normalized) return { ok: false, error: 'That doesn’t look like a Solana address.' }
  if (wallets.some((w) => w.address === normalized)) return { ok: false, error: 'This wallet is already on your list.' }
  if (limit !== null && wallets.length >= limit) {
    return {
      ok: false,
      error: `You can save ${limit} wallet${limit === 1 ? '' : 's'} without holder access.`,
    }
  }
  const cleanLabel = label.trim().replace(/\s+/g, ' ').slice(0, WATCHLIST_LABEL_MAX) || `Wallet ${wallets.length + 1}`
  return {
    ok: true,
    wallets: [...wallets, { id: newId(), label: cleanLabel, address: normalized, addedAt: now }],
  }
}

/* ---------- store ---------- */

function read(): SavedWallet[] {
  try {
    return parseStored(window.localStorage.getItem(WATCHLIST_STORAGE_KEY))
  } catch {
    return []
  }
}

function write(wallets: SavedWallet[]): void {
  try {
    window.localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(wallets))
  } catch {
    /* storage unavailable or full — the list still works for this session */
  }
}

let current: SavedWallet[] = typeof window === 'undefined' ? [] : read()
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((l) => l())
}

function setWallets(next: SavedWallet[]) {
  current = next
  write(next)
  emit()
}

function onStorage(e: StorageEvent) {
  if (e.key !== null && e.key !== WATCHLIST_STORAGE_KEY) return
  current = read()
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) window.removeEventListener('storage', onStorage)
  }
}

const getSnapshot = () => current

/** Records the latest scan summary for a saved wallet (no-op when unsaved or unchanged). */
export function recordScan(address: string, lastScan: NonNullable<SavedWallet['lastScan']>): void {
  const idx = current.findIndex((w) => w.address === address)
  if (idx === -1) return
  const prev = current[idx].lastScan
  if (
    prev &&
    prev.at === lastScan.at &&
    prev.cluster === lastScan.cluster &&
    prev.eligible === lastScan.eligible &&
    prev.reclaimLamports === lastScan.reclaimLamports
  )
    return
  const next = current.slice()
  next[idx] = { ...current[idx], lastScan }
  setWallets(next)
}

/** Test hook: reset the in-memory store. */
export function __resetWatchlistForTests(wallets: SavedWallet[] = []): void {
  current = wallets
  emit()
}

export interface WatchlistApi {
  wallets: SavedWallet[]
  /** Returns an error message, or null on success. */
  add: (label: string, address: string) => string | null
  remove: (id: string) => void
  rename: (id: string, label: string) => void
  /** null = unlimited (holder access). */
  limit: number | null
  canAdd: boolean
}

export function useWatchlist(): WatchlistApi {
  const wallets = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const { holder } = useCleaner()
  const limit: number | null = holder.isHolder ? null : CONFIG.freeWatchlistLimit

  const add = useCallback(
    (label: string, address: string) => {
      const res = addWallet(current, label, address, limit)
      if (!res.ok) return res.error
      setWallets(res.wallets)
      return null
    },
    [limit],
  )
  const remove = useCallback((id: string) => setWallets(current.filter((w) => w.id !== id)), [])
  const rename = useCallback((id: string, label: string) => {
    const clean = label.trim().replace(/\s+/g, ' ').slice(0, WATCHLIST_LABEL_MAX)
    if (!clean) return
    setWallets(current.map((w) => (w.id === id ? { ...w, label: clean } : w)))
  }, [])

  return useMemo(
    () => ({ wallets, add, remove, rename, limit, canAdd: limit === null || wallets.length < limit }),
    [wallets, add, remove, rename, limit],
  )
}

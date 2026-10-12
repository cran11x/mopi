import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { PublicKey } from '@solana/web3.js'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { CONFIG } from '../config'
import { createDemoScan, demoFeeConfig, DEMO_OWNER, isDemoAddress } from '../lib/demo'
import { buildQuote, defaultFeeConfig } from '../lib/solana/fees'
import { scanWallet } from '../lib/solana/scan'
import { executeCleanup } from '../lib/solana/execute'
import { getHolderStatus } from '../lib/solana/holder'
import type {
  BatchProgress,
  CleanupPhase,
  CleanupQuote,
  FeeConfig,
  HolderStatus,
  ScanResult,
  TokenAccountInfo,
} from '../lib/types'
import { useCluster } from './cluster'

export type ScanStatus = 'idle' | 'scanning' | 'done' | 'error'

/** Why the real cleanup cannot run right now (null = it can). */
export type ExecuteBlocker =
  | 'demo'
  | 'not-connected'
  | 'wrong-wallet'
  | 'nothing-selected'
  | 'wallet-cannot-sign'
  | null

export interface CleanupState {
  phase: CleanupPhase
  progress: BatchProgress[]
  error: string | null
  /** Set when phase === 'done'. */
  result: { confirmedBatches: number; failedBatches: number; returnedLamports: number; signatures: string[] } | null
  /** True while a demo (simulated, nothing sent) run is shown. */
  isDemoRun: boolean
}

export interface CleanerApi {
  // address + scan
  addressInput: string
  setAddressInput: (value: string) => void
  scanStatus: ScanStatus
  scanError: string | null
  scan: ScanResult | null
  /** Scans `address` (or the current input). Demo address → demo data. */
  runScan: (address?: string) => Promise<void>
  loadDemo: () => void

  // selection (eligible accounts only)
  selected: ReadonlySet<string>
  selectedAccounts: TokenAccountInfo[]
  toggleAccount: (address: string) => void
  setAllSelected: (selected: boolean) => void

  // pricing
  holder: HolderStatus
  feeConfig: FeeConfig
  quote: CleanupQuote | null

  // cleanup flow
  cleanup: CleanupState
  executeBlocker: ExecuteBlocker
  openReview: () => void
  closeReview: () => void
  startCleanup: () => Promise<void>
  resetCleanup: () => void
}

const CleanerContext = createContext<CleanerApi | null>(null)

const IDLE_CLEANUP: CleanupState = { phase: 'idle', progress: [], error: null, result: null, isDemoRun: false }

function initialHolder(): HolderStatus {
  return {
    mintConfigured: Boolean(CONFIG.mopiMint),
    checked: false,
    isHolder: false,
    balanceUi: 0,
    minRequired: CONFIG.holderMin,
  }
}

function parseAddress(input: string): PublicKey | null {
  const t = input.trim()
  if (!t) return null
  try {
    return new PublicKey(t)
  } catch {
    return null
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const msg = err.message || err.name
    if (/User rejected|rejected the request|declined/i.test(msg)) return 'You declined the request in your wallet.'
    if (/429|Too Many Requests|rate/i.test(msg)) return 'The RPC endpoint is rate limiting requests. Try again in a moment.'
    if (/Failed to fetch|NetworkError|fetch failed/i.test(msg)) return 'Could not reach the Solana RPC endpoint.'
    return msg
  }
  return String(err)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function CleanerProvider({ children }: { children: ReactNode }) {
  const { connection } = useConnection()
  const wallet = useWallet()
  const { cluster } = useCluster()

  const [addressInput, setAddressInput] = useState<string>(DEMO_OWNER)
  const [scanStatus, setScanStatus] = useState<ScanStatus>('done')
  const [scanError, setScanError] = useState<string | null>(null)
  const [scan, setScan] = useState<ScanResult | null>(() => createDemoScan(cluster))
  const [selected, setSelected] = useState<Set<string>>(() => new Set(createDemoScan(cluster).eligible.map((a) => a.address)))
  const [holder, setHolder] = useState<HolderStatus>(initialHolder)
  const [cleanup, setCleanup] = useState<CleanupState>(IDLE_CLEANUP)

  const scanSeq = useRef(0)
  const scanAbort = useRef<AbortController | null>(null)

  const applyScan = useCallback((result: ScanResult) => {
    setScan(result)
    setSelected(new Set(result.eligible.map((a) => a.address)))
    setCleanup(IDLE_CLEANUP)
  }, [])

  const loadDemo = useCallback(() => {
    scanAbort.current?.abort()
    scanSeq.current++
    setAddressInput(DEMO_OWNER)
    setScanError(null)
    setScanStatus('done')
    applyScan(createDemoScan(cluster))
  }, [applyScan, cluster])

  const runScan = useCallback(
    async (address?: string) => {
      const input = (address ?? addressInput).trim()
      if (address !== undefined) setAddressInput(address)
      if (isDemoAddress(input)) {
        loadDemo()
        return
      }
      const owner = parseAddress(input)
      if (!owner) {
        setScanStatus('error')
        setScanError(input ? 'That doesn’t look like a Solana address.' : 'Paste a wallet address to scan.')
        return
      }
      scanAbort.current?.abort()
      const controller = new AbortController()
      scanAbort.current = controller
      const seq = ++scanSeq.current
      setScanStatus('scanning')
      setScanError(null)
      try {
        const result = await scanWallet(connection, owner, { cluster, signal: controller.signal })
        if (seq !== scanSeq.current) return
        applyScan(result)
        setScanStatus('done')
      } catch (err) {
        if (seq !== scanSeq.current || controller.signal.aborted) return
        setScanStatus('error')
        setScanError(describeError(err))
      }
    },
    [addressInput, applyScan, cluster, connection, loadDemo],
  )

  // Cluster switch: re-run the current scan on the new cluster.
  const lastCluster = useRef(cluster)
  useEffect(() => {
    if (lastCluster.current === cluster) return
    lastCluster.current = cluster
    if (!scan || scan.isDemo) loadDemo()
    else void runScan(scan.owner)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cluster])

  // Connecting a wallet fills the address and scans it (read-only).
  const connectedKey = wallet.publicKey?.toBase58() ?? null
  const autoScannedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!connectedKey) {
      autoScannedFor.current = null
      return
    }
    if (autoScannedFor.current === connectedKey) return
    autoScannedFor.current = connectedKey
    void runScan(connectedKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectedKey])

  // $MOPI holder check for the connected wallet.
  useEffect(() => {
    let cancelled = false
    if (!wallet.publicKey || !CONFIG.mopiMint) {
      setHolder(initialHolder())
      return
    }
    getHolderStatus(connection, wallet.publicKey)
      .then((h) => !cancelled && setHolder(h))
      .catch(() => !cancelled && setHolder({ ...initialHolder(), checked: true }))
    return () => {
      cancelled = true
    }
  }, [connection, wallet.publicKey])

  const selectedAccounts = useMemo(
    () => (scan ? scan.eligible.filter((a) => selected.has(a.address)) : []),
    [scan, selected],
  )

  const feeConfig = useMemo(() => {
    const base = defaultFeeConfig(holder.isHolder)
    return scan?.isDemo ? demoFeeConfig(base, holder.isHolder) : base
  }, [holder.isHolder, scan?.isDemo])

  const quote = useMemo(
    () => (scan ? buildQuote(selectedAccounts, feeConfig, { isHolderRate: holder.isHolder }) : null),
    [scan, selectedAccounts, feeConfig, holder.isHolder],
  )

  const toggleAccount = useCallback((address: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(address)) next.delete(address)
      else next.add(address)
      return next
    })
  }, [])

  const setAllSelected = useCallback(
    (value: boolean) => setSelected(value && scan ? new Set(scan.eligible.map((a) => a.address)) : new Set()),
    [scan],
  )

  const executeBlocker: ExecuteBlocker = useMemo(() => {
    if (!scan || !quote || quote.accountCount === 0) return 'nothing-selected'
    if (scan.isDemo) return 'demo'
    if (!wallet.publicKey) return 'not-connected'
    if (wallet.publicKey.toBase58() !== scan.owner) return 'wrong-wallet'
    if (!wallet.signAllTransactions && !wallet.signTransaction) return 'wallet-cannot-sign'
    return null
  }, [scan, quote, wallet.publicKey, wallet.signAllTransactions, wallet.signTransaction])

  const openReview = useCallback(() => {
    setCleanup((c) => (c.phase === 'executing' ? c : { ...IDLE_CLEANUP, phase: 'review' }))
  }, [])

  const closeReview = useCallback(() => {
    setCleanup((c) => (c.phase === 'executing' ? c : IDLE_CLEANUP))
  }, [])

  const resetCleanup = useCallback(() => setCleanup(IDLE_CLEANUP), [])

  const runDemoCleanup = useCallback(async (q: CleanupQuote) => {
    let progress: BatchProgress[] = q.batches.map((b) => ({
      index: b.index,
      status: 'pending',
      accountCount: b.accounts.length,
      reclaimLamports: b.reclaimLamports,
    }))
    const push = () => setCleanup((c) => ({ ...c, progress }))
    setCleanup({ phase: 'executing', progress, error: null, result: null, isDemoRun: true })
    for (const status of ['simulating', 'awaiting-signature', 'sending', 'confirmed'] as const) {
      await sleep(status === 'awaiting-signature' ? 900 : 550)
      progress = progress.map((p) => ({ ...p, status }))
      push()
    }
    setCleanup({
      phase: 'done',
      progress,
      error: null,
      isDemoRun: true,
      result: { confirmedBatches: progress.length, failedBatches: 0, returnedLamports: q.netLamports, signatures: [] },
    })
  }, [])

  const startCleanup = useCallback(async () => {
    if (!quote || !scan || quote.accountCount === 0) return
    if (cleanup.phase === 'executing') return
    if (scan.isDemo) {
      await runDemoCleanup(quote)
      return
    }
    if (executeBlocker) {
      setCleanup((c) => ({ ...c, phase: 'error', error: 'Connect the wallet that owns these accounts to continue.' }))
      return
    }
    const quoteAtStart = quote
    setCleanup({ phase: 'executing', progress: [], error: null, result: null, isDemoRun: false })
    try {
      const progress = await executeCleanup({
        connection,
        wallet: {
          publicKey: wallet.publicKey,
          signAllTransactions: wallet.signAllTransactions,
          signTransaction: wallet.signTransaction,
        },
        quote: quoteAtStart,
        fee: feeConfig,
        onProgress: (p) => setCleanup((c) => ({ ...c, progress: p })),
      })
      const confirmed = progress.filter((p) => p.status === 'confirmed')
      const returnedLamports = confirmed.reduce((sum, p) => {
        const batch = quoteAtStart.batches[p.index]
        return batch ? sum + batch.reclaimLamports - batch.serviceFeeLamports - batch.networkFeeLamports : sum
      }, 0)
      setCleanup({
        phase: confirmed.length > 0 ? 'done' : 'error',
        progress,
        error: confirmed.length > 0 ? null : progress.find((p) => p.error)?.error ?? 'No batch could be confirmed.',
        isDemoRun: false,
        result: {
          confirmedBatches: confirmed.length,
          failedBatches: progress.length - confirmed.length,
          returnedLamports: Math.max(0, returnedLamports),
          signatures: confirmed.map((p) => p.signature).filter((s): s is string => Boolean(s)),
        },
      })
      if (confirmed.length > 0) {
        // Refresh balances in the background; keep the result visible.
        scanWallet(connection, new PublicKey(scan.owner), { cluster })
          .then((fresh) => {
            setScan(fresh)
            setSelected(new Set(fresh.eligible.map((a) => a.address)))
          })
          .catch(() => {})
      }
    } catch (err) {
      setCleanup((c) => ({ ...c, phase: 'error', error: describeError(err) }))
    }
  }, [cleanup.phase, cluster, connection, executeBlocker, feeConfig, quote, runDemoCleanup, scan, wallet])

  const value: CleanerApi = {
    addressInput,
    setAddressInput,
    scanStatus,
    scanError,
    scan,
    runScan,
    loadDemo,
    selected,
    selectedAccounts,
    toggleAccount,
    setAllSelected,
    holder,
    feeConfig,
    quote,
    cleanup,
    executeBlocker,
    openReview,
    closeReview,
    startCleanup,
    resetCleanup,
  }

  return <CleanerContext.Provider value={value}>{children}</CleanerContext.Provider>
}

export function useCleaner(): CleanerApi {
  const ctx = useContext(CleanerContext)
  if (!ctx) throw new Error('useCleaner must be used inside <CleanerProvider>')
  return ctx
}

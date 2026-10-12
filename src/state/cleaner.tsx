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
import { estimatePriorityFee } from '../lib/solana/priority'
import { scanWallet } from '../lib/solana/scan'
// execute.ts (transaction building, safety checks, sending) is loaded on the
// first real cleanup, so it stays out of the first-paint bundle.
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
  /** The scan is from another cluster than the active connection, or a rescan is in flight. */
  | 'stale-scan'
  /** The configured fee wallet can't receive this quote's service fee yet (below the rent-exempt minimum). */
  | 'fee-wallet-unfunded'
  | null

/** Rent-exempt minimum of a system account (0 bytes of data): a transfer may not leave a new account below it. */
export const RENT_EXEMPT_MINIMUM_LAMPORTS = 890_880

/** A real cleanup refreshes a priority fee estimate older than this before it starts. */
export const PRIORITY_FEE_MAX_AGE_MS = 30_000

/** A fee wallet balance older than this is re-read before a real cleanup starts. */
export const FEE_WALLET_BALANCE_MAX_AGE_MS = 60_000

/**
 * A pre-start estimate up to this factor above the price on screen still runs
 * with the price on screen (what the user approved); anything higher is shown
 * for approval first.
 */
export const PRIORITY_FEE_RAISE_TOLERANCE = 1.1

export const FEE_WALLET_UNFUNDED_MESSAGE =
  'The service fee wallet of this deployment isn’t funded yet, so small cleanups would fail. Operator: fund it with at least 0.00089 SOL.'

export const FEES_CHANGED_NOTICE =
  'Network fees went up since you opened this review. Check the updated amounts, then approve again.'

/**
 * True when a batch's fee transfer would leave the fee wallet below the
 * rent-exempt minimum (Solana rejects that transfer, failing the whole batch).
 */
export function feeWalletCannotReceive(quote: CleanupQuote, balanceLamports: number): boolean {
  if (balanceLamports >= RENT_EXEMPT_MINIMUM_LAMPORTS) return false
  return quote.batches.some(
    (b) => b.serviceFeeLamports > 0 && balanceLamports + b.serviceFeeLamports < RENT_EXEMPT_MINIMUM_LAMPORTS,
  )
}

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
  /** Real scans: priority fee price from the latest recent-fee estimate. Demo: the static config. */
  feeConfig: FeeConfig
  quote: CleanupQuote | null
  /** True while the review's fee checks (priority fee estimate, fee wallet balance) are running. */
  checkingFees: boolean
  /** Shown in the review when the amounts changed and need a fresh approval. */
  quoteNotice: string | null
  /** The configured fee wallet can't receive this quote's service fee (see 'fee-wallet-unfunded'). */
  feeWalletUnfunded: boolean

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
    if (/Failed to fetch|NetworkError|fetch failed|Load failed/i.test(msg))
      return 'Couldn’t reach the Solana RPC. Check your connection and try again — public endpoints are often busy.'
    return msg
  }
  return String(err)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const scanKey = (s: Pick<ScanResult, 'cluster' | 'owner'>) => `${s.cluster}:${s.owner}`

interface PriorityEstimate {
  /** scanKey of the scan it was made for. */
  key: string
  microLamports: number
  at: number
}

interface FeeWalletBalance {
  /** `${cluster}:${feeWallet}` */
  key: string
  /** null = could not be read (not treated as unfunded; simulation still explains it). */
  lamports: number | null
  at: number
}

export function CleanerProvider({ children }: { children: ReactNode }) {
  const { connection } = useConnection()
  const wallet = useWallet()
  const { cluster } = useCluster()

  const [addressInput, setAddressInputState] = useState<string>(DEMO_OWNER)
  const [scanStatus, setScanStatus] = useState<ScanStatus>('done')
  const [scanError, setScanError] = useState<string | null>(null)
  const [scan, setScan] = useState<ScanResult | null>(() => createDemoScan(cluster))
  const [selected, setSelected] = useState<Set<string>>(() => new Set(createDemoScan(cluster).eligible.map((a) => a.address)))
  const [holder, setHolder] = useState<HolderStatus>(initialHolder)
  const [cleanup, setCleanup] = useState<CleanupState>(IDLE_CLEANUP)
  const [priority, setPriority] = useState<PriorityEstimate | null>(null)
  const [feeWalletBalance, setFeeWalletBalance] = useState<FeeWalletBalance | null>(null)
  const [checks, setChecks] = useState(0)
  const [quoteNotice, setQuoteNotice] = useState<string | null>(null)

  const scanSeq = useRef(0)
  /** Set synchronously while a cleanup runs; the render-time `cleanup.phase` can be stale. */
  const executingRef = useRef(false)
  const scanAbort = useRef<AbortController | null>(null)
  // Latest values for stable callbacks (a keystroke must not rebuild runScan
  // and re-render every consumer).
  const addressInputRef = useRef(addressInput)
  addressInputRef.current = addressInput
  const scanRef = useRef(scan)
  scanRef.current = scan
  const priorityRef = useRef(priority)
  priorityRef.current = priority
  const feeWalletBalanceRef = useRef(feeWalletBalance)
  feeWalletBalanceRef.current = feeWalletBalance
  /** Bumped whenever the review is opened, closed or reset: a pending start must not outlive its review. */
  const reviewSeq = useRef(0)
  const priorityInflight = useRef<{ key: string; promise: Promise<number> } | null>(null)
  const feeWalletInflight = useRef<{ key: string; promise: Promise<number | null> } | null>(null)

  const applyScan = useCallback((result: ScanResult) => {
    setScan(result)
    setSelected(new Set(result.eligible.map((a) => a.address)))
    // Never close the progress dialog under a running cleanup (e.g. an
    // account switch in the wallet auto-scans mid-run).
    if (!executingRef.current) {
      reviewSeq.current++
      setCleanup(IDLE_CLEANUP)
    }
  }, [])

  /** Results that don't belong to the wallet/network being asked about must not stay on screen. */
  const dropScanUnlessFor = useCallback(
    (owner: string | null) => {
      const current = scanRef.current
      if (!current || (owner && current.owner === owner && current.cluster === cluster)) return
      setScan(null)
      setSelected(new Set())
      if (!executingRef.current) setCleanup(IDLE_CLEANUP)
    },
    [cluster],
  )

  const setAddressInput = useCallback((value: string) => {
    setAddressInputState(value)
    // Editing the field dismisses the previous error.
    setScanError(null)
    setScanStatus((s) => (s === 'error' ? (scanRef.current ? 'done' : 'idle') : s))
  }, [])

  const loadDemo = useCallback(() => {
    scanAbort.current?.abort()
    scanSeq.current++
    setAddressInputState(DEMO_OWNER)
    setScanError(null)
    setScanStatus('done')
    applyScan(createDemoScan(cluster))
  }, [applyScan, cluster])

  const runScan = useCallback(
    async (address?: string) => {
      const input = (address ?? addressInputRef.current).trim()
      if (address !== undefined) setAddressInputState(address)
      if (isDemoAddress(input)) {
        loadDemo()
        return
      }
      const owner = parseAddress(input)
      if (!owner) {
        scanAbort.current?.abort()
        scanSeq.current++
        setScanStatus('error')
        setScanError(input ? 'That doesn’t look like a Solana address.' : 'Paste a wallet address to scan.')
        if (input) dropScanUnlessFor(null)
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
        dropScanUnlessFor(owner.toBase58())
      }
    },
    [applyScan, cluster, connection, dropScanUnlessFor, loadDemo],
  )

  /**
   * Re-scan the cleaned wallet after (partial) success. Guarded like any
   * scan: a newer scan, another wallet or another network wins.
   */
  const refreshAfterCleanup = useCallback(
    (owner: string) => {
      const current = scanRef.current
      if (!current || current.owner !== owner || current.cluster !== cluster) return
      scanAbort.current?.abort()
      const controller = new AbortController()
      scanAbort.current = controller
      const seq = ++scanSeq.current
      scanWallet(connection, new PublicKey(owner), { cluster, signal: controller.signal })
        .then((fresh) => {
          if (seq !== scanSeq.current || controller.signal.aborted) return
          setScan(fresh)
          setSelected(new Set(fresh.eligible.map((a) => a.address)))
        })
        .catch(() => {})
    },
    [cluster, connection],
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

  // Real scans price the priority fee from the latest estimate for this
  // wallet + network; the demo keeps the static config (stable demo numbers).
  const estimatedPriority =
    scan && !scan.isDemo && priority && priority.key === scanKey(scan) ? priority.microLamports : null
  const feeConfig = useMemo(() => {
    const base = defaultFeeConfig(holder.isHolder)
    if (scan?.isDemo) return demoFeeConfig(base, holder.isHolder)
    return estimatedPriority === null ? base : { ...base, priorityFeeMicroLamports: estimatedPriority }
  }, [holder.isHolder, scan?.isDemo, estimatedPriority])

  const quote = useMemo(
    () => (scan ? buildQuote(selectedAccounts, feeConfig, { isHolderRate: holder.isHolder }) : null),
    [scan, selectedAccounts, feeConfig, holder.isHolder],
  )
  const selectedAccountsRef = useRef(selectedAccounts)
  selectedAccountsRef.current = selectedAccounts

  const feeWalletKey = CONFIG.feeWallet ? `${cluster}:${CONFIG.feeWallet}` : null
  const feeWalletUnfunded = useMemo(() => {
    if (!scan || scan.isDemo || !quote || !feeConfig.feeWallet || !feeWalletKey) return false
    if (!feeWalletBalance || feeWalletBalance.key !== feeWalletKey || feeWalletBalance.lamports === null) return false
    return feeWalletCannotReceive(quote, feeWalletBalance.lamports)
  }, [scan, quote, feeConfig.feeWallet, feeWalletKey, feeWalletBalance])

  /** Counts a check in `checkingFees` while it runs. */
  const trackCheck = useCallback(async <T,>(work: Promise<T>): Promise<T> => {
    setChecks((n) => n + 1)
    try {
      return await work
    } finally {
      setChecks((n) => n - 1)
    }
  }, [])

  /** Fresh priority fee estimate for `s` (one request in flight per wallet + network); applied to the quote. */
  const fetchPriority = useCallback(
    (s: ScanResult, accounts: readonly TokenAccountInfo[]): Promise<number> => {
      const key = scanKey(s)
      const inflight = priorityInflight.current
      if (inflight && inflight.key === key) return inflight.promise
      const promise: Promise<number> = estimatePriorityFee(connection, [
        s.owner,
        ...accounts.slice(0, 4).map((a) => a.address),
      ])
        .then((microLamports) => {
          setPriority({ key, microLamports, at: Date.now() })
          return microLamports
        })
        .finally(() => {
          if (priorityInflight.current?.promise === promise) priorityInflight.current = null
        })
      priorityInflight.current = { key, promise }
      return promise
    },
    [connection],
  )

  /** Fee wallet balance on the active network (null: no fee wallet, or unreadable). Never rejects. */
  const fetchFeeWalletBalance = useCallback((): Promise<number | null> => {
    const feeWallet = CONFIG.feeWallet
    if (!feeWallet) return Promise.resolve(null)
    const key = `${cluster}:${feeWallet}`
    const inflight = feeWalletInflight.current
    if (inflight && inflight.key === key) return inflight.promise
    const promise: Promise<number | null> = (async () => {
      let lamports: number | null = null
      try {
        const value: unknown = await connection.getBalance(new PublicKey(feeWallet), 'confirmed')
        lamports = typeof value === 'number' && Number.isFinite(value) ? value : null
      } catch {
        lamports = null
      }
      setFeeWalletBalance({ key, lamports, at: Date.now() })
      return lamports
    })().finally(() => {
      if (feeWalletInflight.current?.promise === promise) feeWalletInflight.current = null
    })
    feeWalletInflight.current = { key, promise }
    return promise
  }, [cluster, connection])

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
    if (scan.cluster !== cluster || scanStatus === 'scanning') return 'stale-scan'
    if (feeWalletUnfunded) return 'fee-wallet-unfunded'
    if (!wallet.publicKey) return 'not-connected'
    if (wallet.publicKey.toBase58() !== scan.owner) return 'wrong-wallet'
    if (!wallet.signAllTransactions && !wallet.signTransaction) return 'wallet-cannot-sign'
    return null
  }, [scan, quote, cluster, scanStatus, feeWalletUnfunded, wallet.publicKey, wallet.signAllTransactions, wallet.signTransaction])

  const openReview = useCallback(() => {
    if (executingRef.current) return
    reviewSeq.current++
    setQuoteNotice(null)
    setCleanup((c) => (c.phase === 'executing' ? c : { ...IDLE_CLEANUP, phase: 'review' }))
    // Real scans: price the review with current network fees and check that
    // the fee wallet can receive the fee, before anything can be approved.
    const s = scanRef.current
    if (!s || s.isDemo || s.cluster !== cluster) return
    void trackCheck(Promise.all([fetchPriority(s, selectedAccountsRef.current), fetchFeeWalletBalance()]))
  }, [cluster, fetchFeeWalletBalance, fetchPriority, trackCheck])

  const closeReview = useCallback(() => {
    // Also cancels a start still in its pre-start checks.
    reviewSeq.current++
    setQuoteNotice(null)
    setCleanup((c) => (c.phase === 'executing' ? c : IDLE_CLEANUP))
  }, [])

  const resetCleanup = useCallback(() => {
    reviewSeq.current++
    setQuoteNotice(null)
    setCleanup(IDLE_CLEANUP)
  }, [])

  /**
   * Last checks before a real cleanup, for exactly the quote on screen
   * (`q`, priced with `fee`): a priority estimate older than
   * PRIORITY_FEE_MAX_AGE_MS is refreshed and, if fees rose, the new amounts
   * are shown for approval instead of running; the fee wallet must be able to
   * receive the fee. Returns true to proceed with `q` / `fee` unchanged.
   */
  const preStartChecks = useCallback(
    async (s: ScanResult, q: CleanupQuote, fee: FeeConfig, accounts: readonly TokenAccountInfo[]): Promise<boolean> => {
      const p = priorityRef.current
      if (!p || p.key !== scanKey(s) || Date.now() - p.at > PRIORITY_FEE_MAX_AGE_MS) {
        const fresh = await fetchPriority(s, accounts)
        if (fresh > fee.priorityFeeMicroLamports * PRIORITY_FEE_RAISE_TOLERANCE) {
          setQuoteNotice(FEES_CHANGED_NOTICE)
          return false
        }
      }
      if (fee.feeWallet && CONFIG.feeWallet && fee.feeWallet === CONFIG.feeWallet) {
        const b = feeWalletBalanceRef.current
        const known =
          b && b.key === `${s.cluster}:${CONFIG.feeWallet}` && Date.now() - b.at <= FEE_WALLET_BALANCE_MAX_AGE_MS
        const lamports = known ? b.lamports : await fetchFeeWalletBalance()
        // Blocked: the 'fee-wallet-unfunded' blocker and warning now show in the review.
        if (lamports !== null && feeWalletCannotReceive(q, lamports)) return false
      }
      return true
    },
    [fetchFeeWalletBalance, fetchPriority],
  )

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
    if (executingRef.current || cleanup.phase === 'executing') return
    if (scan.isDemo) {
      executingRef.current = true
      try {
        await runDemoCleanup(quote)
      } finally {
        executingRef.current = false
      }
      return
    }
    if (executeBlocker) {
      const error =
        executeBlocker === 'stale-scan'
          ? 'These results are from another network or are being refreshed. Rescan, then try again.'
          : executeBlocker === 'fee-wallet-unfunded'
            ? FEE_WALLET_UNFUNDED_MESSAGE
            : 'Connect the wallet that owns these accounts to continue.'
      setCleanup((c) => ({ ...c, phase: 'error', error }))
      return
    }
    executingRef.current = true
    const quoteAtStart = quote
    const feeAtStart = feeConfig
    const scanAtStart = scan
    const owner = scan.owner
    const seq = reviewSeq.current
    setQuoteNotice(null)
    let proceed = false
    try {
      proceed = await trackCheck(preStartChecks(scanAtStart, quoteAtStart, feeAtStart, selectedAccounts))
    } catch {
      proceed = false
    }
    // Cancelled, rescanned or switched while checking: never prompt the wallet for a stale review.
    if (!proceed || seq !== reviewSeq.current || scanRef.current !== scanAtStart) {
      executingRef.current = false
      return
    }
    let lastProgress: BatchProgress[] = []
    setCleanup({ phase: 'executing', progress: [], error: null, result: null, isDemoRun: false })
    try {
      const { executeCleanup } = await import('../lib/solana/execute')
      const progress = await executeCleanup({
        connection,
        wallet: {
          publicKey: wallet.publicKey,
          signAllTransactions: wallet.signAllTransactions,
          signTransaction: wallet.signTransaction,
        },
        quote: quoteAtStart,
        fee: feeAtStart,
        onProgress: (p) => {
          lastProgress = p
          setCleanup((c) => ({ ...c, progress: p }))
        },
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
      executingRef.current = false
      // Refresh balances in the background; keep the result visible.
      if (confirmed.length > 0) refreshAfterCleanup(owner)
    } catch (err) {
      executingRef.current = false
      setCleanup((c) => ({ ...c, phase: 'error', error: describeError(err) }))
      // e.g. batch 1 confirmed, then the second wallet prompt was declined:
      // the closed accounts must not stay listed (and selected) as eligible.
      if (lastProgress.some((p) => p.status === 'confirmed')) refreshAfterCleanup(owner)
    } finally {
      executingRef.current = false
    }
  }, [
    cleanup.phase,
    connection,
    executeBlocker,
    feeConfig,
    preStartChecks,
    quote,
    refreshAfterCleanup,
    runDemoCleanup,
    scan,
    selectedAccounts,
    trackCheck,
    wallet,
  ])

  const checkingFees = checks > 0

  const value = useMemo<CleanerApi>(
    () => ({
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
    checkingFees,
    quoteNotice,
    feeWalletUnfunded,
    cleanup,
    executeBlocker,
    openReview,
    closeReview,
    startCleanup,
    resetCleanup,
    }),
    [
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
      checkingFees,
      quoteNotice,
      feeWalletUnfunded,
      cleanup,
      executeBlocker,
      openReview,
      closeReview,
      startCleanup,
      resetCleanup,
    ],
  )

  return <CleanerContext.Provider value={value}>{children}</CleanerContext.Provider>
}

export function useCleaner(): CleanerApi {
  const ctx = useContext(CleanerContext)
  if (!ctx) throw new Error('useCleaner must be used inside <CleanerProvider>')
  return ctx
}

// State layer execution guards (fund safety): re-entrancy and stale scans.
import { createElement, type ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { Keypair, type PublicKey } from '@solana/web3.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Cluster, ScanResult } from '../lib/types'
import { eligibleAccount } from '../test/solanaFixtures'

const h = vi.hoisted(() => ({
  cluster: 'mainnet-beta' as Cluster,
  wallet: {} as Record<string, unknown>,
  scanImpl: null as null | ((owner: string, cluster: Cluster) => Promise<ScanResult>),
  execute: null as unknown as ReturnType<typeof vi.fn>,
  connections: {} as Record<string, unknown>,
  /** Extra connection methods (getRecentPrioritizationFees, getBalance…) for new connections. */
  rpc: {} as Record<string, unknown>,
  feeWallet: null as string | null,
  accountCount: 2,
}))

vi.mock('@solana/wallet-adapter-react', () => ({
  useConnection: () => ({ connection: (h.connections[h.cluster] ??= { rpcEndpoint: h.cluster, ...h.rpc }) }),
  useWallet: () => h.wallet,
}))
vi.mock('../config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config')>()
  return {
    ...actual,
    CONFIG: {
      ...actual.CONFIG,
      get feeWallet() {
        return h.feeWallet
      },
    },
  }
})
vi.mock('./cluster', () => ({ useCluster: () => ({ cluster: h.cluster }) }))
vi.mock('../lib/solana/scan', () => ({
  scanWallet: (_c: unknown, owner: { toBase58(): string }, opts: { cluster: Cluster }) =>
    h.scanImpl!(owner.toBase58(), opts.cluster),
}))
vi.mock('../lib/solana/execute', () => ({ executeCleanup: (...args: unknown[]) => h.execute(...args) }))

import {
  FEES_CHANGED_NOTICE,
  FEE_WALLET_BALANCE_TIMEOUT_MS,
  PRIORITY_FEE_MAX_AGE_MS,
  RENT_EXEMPT_MINIMUM_LAMPORTS,
  STOPPED_MESSAGE,
  CleanerProvider,
  useCleaner,
} from './cleaner'

function scanFor(owner: string, cluster: Cluster): ScanResult {
  const eligible = Array.from({ length: h.accountCount }, () => eligibleAccount(owner))
  return { owner, cluster, scannedAt: 1, isDemo: false, accounts: eligible, eligible, withTokens: [], unsupported: [] }
}

const wrapper = ({ children }: { children: ReactNode }) => createElement(CleanerProvider, null, children)

beforeEach(() => {
  const kp = Keypair.generate()
  h.cluster = 'mainnet-beta'
  h.wallet = {
    publicKey: kp.publicKey,
    signAllTransactions: vi.fn(),
    signTransaction: vi.fn(),
  }
  h.scanImpl = async (owner, cluster) => scanFor(owner, cluster)
  h.execute = vi.fn(() => new Promise(() => {})) // stays "in flight"
  h.connections = {}
  h.rpc = {}
  h.feeWallet = null
  h.accountCount = 2
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('cleaner execution guards', () => {
  it('two startCleanup calls in the same tick start only one execution', async () => {
    const { result } = renderHook(() => useCleaner(), { wrapper })
    await waitFor(() => expect(result.current.scan?.isDemo).toBe(false))
    expect(result.current.executeBlocker).toBeNull()

    await act(async () => {
      void result.current.startCleanup()
      void result.current.startCleanup()
      // execute.ts is imported lazily; let that settle.
      await new Promise((r) => setTimeout(r, 20))
    })
    // The render-time `cleanup.phase` is stale here; the synchronous ref guard must catch it.
    expect(h.execute).toHaveBeenCalledTimes(1)
  })

  it('after a cluster switch whose rescan fails, the old-cluster scan cannot be executed on the new cluster', async () => {
    const { result, rerender } = renderHook(() => useCleaner(), { wrapper })
    await waitFor(() => expect(result.current.scan?.isDemo).toBe(false))
    expect(result.current.scan?.cluster).toBe('mainnet-beta')

    h.scanImpl = async () => {
      throw new Error('fetch failed')
    }
    h.cluster = 'devnet'
    rerender()
    await waitFor(() => expect(result.current.scanStatus).toBe('error'))

    // The mainnet results are not left on screen (or executable) on devnet.
    expect(result.current.scan).toBeNull()
    expect(result.current.selected.size).toBe(0)
    expect(result.current.executeBlocker).toBe('nothing-selected')

    await act(async () => {
      await result.current.startCleanup()
    })
    expect(h.execute).not.toHaveBeenCalled()
  })

  it('a failed scan of another wallet clears the previous results; editing the field clears the error', async () => {
    const { result } = renderHook(() => useCleaner(), { wrapper })
    await waitFor(() => expect(result.current.scan?.isDemo).toBe(false))
    const first = result.current.scan!.owner

    // Same wallet, transient failure: keep its results.
    h.scanImpl = async () => {
      throw new Error('Failed to fetch')
    }
    await act(async () => {
      await result.current.runScan(first)
    })
    expect(result.current.scanError).toMatch(/Couldn’t reach the Solana RPC/)
    expect(result.current.scan?.owner).toBe(first)

    // Another wallet fails: the first wallet's results must not pose as the new one's.
    const other = Keypair.generate().publicKey.toBase58()
    await act(async () => {
      await result.current.runScan(other)
    })
    expect(result.current.scanStatus).toBe('error')
    expect(result.current.scan).toBeNull()
    expect(result.current.quote).toBeNull()

    act(() => result.current.setAddressInput('x'))
    expect(result.current.scanError).toBeNull()
    expect(result.current.scanStatus).toBe('idle')

    // An invalid address also clears stale results.
    act(() => result.current.loadDemo())
    expect(result.current.scan?.isDemo).toBe(true)
    await act(async () => {
      await result.current.runScan('not-an-address')
    })
    expect(result.current.scanError).toMatch(/look like a Solana address/)
    expect(result.current.scan).toBeNull()
  })

  it('keeps runScan stable while typing', async () => {
    const { result } = renderHook(() => useCleaner(), { wrapper })
    await waitFor(() => expect(result.current.scan?.isDemo).toBe(false))
    const before = result.current.runScan
    act(() => result.current.setAddressInput('abc'))
    expect(result.current.addressInput).toBe('abc')
    expect(result.current.runScan).toBe(before)
  })

  it('blocks execution while a rescan is in flight, and unblocks once it lands', async () => {
    const { result, rerender } = renderHook(() => useCleaner(), { wrapper })
    await waitFor(() => expect(result.current.scan?.isDemo).toBe(false))
    expect(result.current.executeBlocker).toBeNull()

    let resolve!: (r: ScanResult) => void
    h.scanImpl = (owner, cluster) =>
      new Promise((r) => {
        resolve = () => r(scanFor(owner, cluster))
      })
    h.cluster = 'devnet'
    rerender()
    await waitFor(() => expect(result.current.scanStatus).toBe('scanning'))
    expect(result.current.executeBlocker).toBe('stale-scan')

    await act(async () => {
      resolve(undefined as never)
    })
    await waitFor(() => expect(result.current.scanStatus).toBe('done'))
    expect(result.current.scan?.cluster).toBe('devnet')
    expect(result.current.executeBlocker).toBeNull()
  })

  it('a finished execution releases the guard so a later run can start', async () => {
    h.execute = vi.fn(async () => [])
    const { result } = renderHook(() => useCleaner(), { wrapper })
    await waitFor(() => expect(result.current.scan?.isDemo).toBe(false))
    await act(async () => {
      await result.current.startCleanup()
    })
    await act(async () => {
      await result.current.startCleanup()
    })
    expect(h.execute).toHaveBeenCalledTimes(2)
  })
})

// ── Dynamic priority fee ────────────────────────────────────────────────────

const fees = (...values: number[]) => values.map((prioritizationFee, slot) => ({ slot, prioritizationFee }))
/** Network fee of one batch at `price` µlamports/CU (base 5,000 + ceil(CU × price / 1e6)). */
const networkFee = (cu: number, price: number) => 5_000 + Math.ceil((cu * price) / 1_000_000)

async function realReady() {
  h.execute = vi.fn(async () => [])
  const hook = renderHook(() => useCleaner(), { wrapper })
  await waitFor(() => expect(hook.result.current.scan?.isDemo).toBe(false))
  return hook
}

describe('dynamic priority fee', () => {
  it('opening a real review prices it with the recent-fee estimate; that exact quote and fee config are executed', async () => {
    const getRecentPrioritizationFees = vi.fn(async (_c?: { lockedWritableAccounts?: PublicKey[] }) => fees(0, 100_000, 200_000, 300_000, 400_000))
    h.rpc = { getRecentPrioritizationFees }
    const { result } = await realReady()
    expect(result.current.feeConfig.priorityFeeMicroLamports).toBe(20_000)

    act(() => result.current.openReview())
    expect(result.current.checkingFees).toBe(true)
    await waitFor(() => expect(result.current.checkingFees).toBe(false))

    const keys = getRecentPrioritizationFees.mock.calls[0][0]!.lockedWritableAccounts!.map((k) => k.toBase58())
    expect(keys[0]).toBe(result.current.scan!.owner)
    expect(keys.slice(1)).toEqual(result.current.selectedAccounts.map((a) => a.address))
    expect(result.current.feeConfig.priorityFeeMicroLamports).toBe(300_000)
    const batch = result.current.quote!.batches[0]
    expect(batch.networkFeeLamports).toBe(networkFee(batch.computeUnitLimit, 300_000))
    const shown = result.current.quote

    await act(async () => {
      await result.current.startCleanup()
    })
    expect(getRecentPrioritizationFees).toHaveBeenCalledTimes(1) // fresh: not re-estimated
    expect(h.execute).toHaveBeenCalledTimes(1)
    const params = h.execute.mock.calls[0][0] as { quote: unknown; fee: { priorityFeeMicroLamports: number } }
    expect(params.quote).toBe(shown)
    expect(params.fee.priorityFeeMicroLamports).toBe(300_000)
  })

  it('an estimate that rose after the review opened is shown for approval, never executed silently', async () => {
    let value = 50_000
    const getRecentPrioritizationFees = vi.fn(async () => fees(value))
    h.rpc = { getRecentPrioritizationFees }
    const { result } = await realReady()
    act(() => result.current.openReview())
    await waitFor(() => expect(result.current.feeConfig.priorityFeeMicroLamports).toBe(50_000))
    await waitFor(() => expect(result.current.checkingFees).toBe(false))

    // 31 s later fees have doubled.
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + PRIORITY_FEE_MAX_AGE_MS + 1_000)
    value = 100_000
    await act(async () => {
      await result.current.startCleanup()
    })
    expect(h.execute).not.toHaveBeenCalled()
    expect(result.current.cleanup.phase).toBe('review')
    expect(result.current.quoteNotice).toBe(FEES_CHANGED_NOTICE)
    expect(result.current.feeConfig.priorityFeeMicroLamports).toBe(100_000)

    // Approving again runs the new numbers that are now on screen.
    const shown = result.current.quote
    await act(async () => {
      await result.current.startCleanup()
    })
    expect(h.execute).toHaveBeenCalledTimes(1)
    const params = h.execute.mock.calls[0][0] as { quote: unknown; fee: { priorityFeeMicroLamports: number } }
    expect(params.quote).toBe(shown)
    expect(params.fee.priorityFeeMicroLamports).toBe(100_000)
    expect(result.current.quoteNotice).toBeNull()
  })

  it('a stale estimate that did not rise runs with the amounts on screen', async () => {
    let value = 80_000
    h.rpc = { getRecentPrioritizationFees: vi.fn(async () => fees(value)) }
    const { result } = await realReady()
    act(() => result.current.openReview())
    await waitFor(() => expect(result.current.checkingFees).toBe(false))
    const shown = result.current.quote
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + PRIORITY_FEE_MAX_AGE_MS + 1_000)
    value = 30_000
    await act(async () => {
      await result.current.startCleanup()
    })
    expect(h.execute).toHaveBeenCalledTimes(1)
    const params = h.execute.mock.calls[0][0] as { quote: unknown; fee: { priorityFeeMicroLamports: number } }
    expect(params.quote).toBe(shown)
    expect(params.fee.priorityFeeMicroLamports).toBe(80_000)
  })

  it('an RPC without getRecentPrioritizationFees (or failing) keeps the floor', async () => {
    h.rpc = { getRecentPrioritizationFees: vi.fn(async () => Promise.reject(new Error('Method not found'))) }
    const { result } = await realReady()
    act(() => result.current.openReview())
    await waitFor(() => expect(result.current.checkingFees).toBe(false))
    expect(result.current.feeConfig.priorityFeeMicroLamports).toBe(20_000)
  })

  it('the demo keeps the static fee config and makes no RPC calls', async () => {
    const getRecentPrioritizationFees = vi.fn(async () => fees(500_000))
    const getBalance = vi.fn(async () => 0)
    h.rpc = { getRecentPrioritizationFees, getBalance }
    h.feeWallet = Keypair.generate().publicKey.toBase58()
    h.wallet = {} // not connected: the demo stays loaded
    const { result } = renderHook(() => useCleaner(), { wrapper })
    expect(result.current.scan?.isDemo).toBe(true)
    const before = result.current.quote
    act(() => result.current.openReview())
    expect(result.current.checkingFees).toBe(false)
    expect(result.current.executeBlocker).toBe('demo')
    expect(result.current.feeConfig.priorityFeeMicroLamports).toBe(20_000)
    expect(result.current.quote).toBe(before)
    expect(getRecentPrioritizationFees).not.toHaveBeenCalled()
    expect(getBalance).not.toHaveBeenCalled()
  })

  it('closing the review while the pre-start check runs never prompts the wallet', async () => {
    let release!: (v: unknown) => void
    const getRecentPrioritizationFees = vi.fn(() => new Promise((r) => (release = r)))
    h.rpc = { getRecentPrioritizationFees }
    const { result } = await realReady()
    let start!: Promise<void>
    act(() => {
      start = result.current.startCleanup()
    })
    act(() => result.current.closeReview())
    await act(async () => {
      release(fees(20_000))
      await start
    })
    expect(h.execute).not.toHaveBeenCalled()
    // …and the guard is released for a later run.
    await act(async () => {
      await result.current.startCleanup()
    })
    expect(h.execute).toHaveBeenCalledTimes(1)
  })
})

// ── Fee wallet health ───────────────────────────────────────────────────────

describe('fee wallet health', () => {
  it('an unfunded fee wallet with a fee below the rent-exempt minimum blocks approval', async () => {
    h.feeWallet = Keypair.generate().publicKey.toBase58()
    const getBalance = vi.fn(async (_k: PublicKey, _c?: unknown) => 0)
    h.rpc = { getBalance }
    const { result } = await realReady()
    expect(result.current.executeBlocker).toBeNull() // not known yet
    expect(result.current.quote!.batches[0].serviceFeeLamports).toBeGreaterThan(0)
    expect(result.current.quote!.batches[0].serviceFeeLamports).toBeLessThan(RENT_EXEMPT_MINIMUM_LAMPORTS)

    act(() => result.current.openReview())
    await waitFor(() => expect(result.current.executeBlocker).toBe('fee-wallet-unfunded'))
    expect(result.current.feeWalletUnfunded).toBe(true)
    expect(getBalance.mock.calls[0][0].toBase58()).toBe(h.feeWallet)

    await act(async () => {
      await result.current.startCleanup()
    })
    expect(h.execute).not.toHaveBeenCalled()
  })

  it('a funded fee wallet, an unreadable balance, or every fee at/above the minimum does not block', async () => {
    h.feeWallet = Keypair.generate().publicKey.toBase58()
    let balance: number | Error = RENT_EXEMPT_MINIMUM_LAMPORTS
    h.rpc = { getBalance: vi.fn(async () => (balance instanceof Error ? Promise.reject(balance) : balance)) }
    const { result } = await realReady()

    act(() => result.current.openReview())
    await waitFor(() => expect(result.current.checkingFees).toBe(false))
    expect(result.current.executeBlocker).toBeNull()

    balance = new Error('fetch failed')
    act(() => result.current.openReview())
    await waitFor(() => expect(result.current.checkingFees).toBe(false))
    expect(result.current.executeBlocker).toBeNull()
    expect(result.current.feeWalletUnfunded).toBe(false)
  })

  it('only batches whose fee is below the minimum matter (20 accounts: one 1.6M-lamport fee)', async () => {
    h.feeWallet = Keypair.generate().publicKey.toBase58()
    h.accountCount = 20
    h.rpc = { getBalance: vi.fn(async () => 0) }
    const { result } = await realReady()
    expect(result.current.quote!.batches).toHaveLength(1)
    expect(result.current.quote!.batches[0].serviceFeeLamports).toBeGreaterThanOrEqual(RENT_EXEMPT_MINIMUM_LAMPORTS)
    act(() => result.current.openReview())
    await waitFor(() => expect(result.current.checkingFees).toBe(false))
    expect(result.current.executeBlocker).toBeNull()

    // Deselect down to 2 accounts: the small fee is now blocked.
    act(() => {
      const keep = new Set(result.current.selectedAccounts.slice(0, 2).map((a) => a.address))
      for (const a of result.current.selectedAccounts) if (!keep.has(a.address)) result.current.toggleAccount(a.address)
    })
    await waitFor(() => expect(result.current.quote!.accountCount).toBe(2))
    expect(result.current.executeBlocker).toBe('fee-wallet-unfunded')
  })

  it('startCleanup checks the fee wallet itself when the review check has not run', async () => {
    h.feeWallet = Keypair.generate().publicKey.toBase58()
    const getBalance = vi.fn(async () => 0)
    h.rpc = { getBalance }
    const { result } = await realReady()
    await act(async () => {
      await result.current.startCleanup()
    })
    expect(getBalance).toHaveBeenCalled()
    expect(h.execute).not.toHaveBeenCalled()
    expect(result.current.executeBlocker).toBe('fee-wallet-unfunded')
  })
})

describe('a stalled RPC never traps the review or the run', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a fee-wallet balance read that never answers: "checking fees" ends and approval still works', async () => {
    h.feeWallet = Keypair.generate().publicKey.toBase58()
    h.rpc = {
      getRecentPrioritizationFees: async () => [],
      getBalance: () => new Promise<number>(() => {}), // overloaded node: TCP open, no answer
    }
    const { result } = await realReady()
    vi.useFakeTimers()
    act(() => result.current.openReview())
    expect(result.current.checkingFees).toBe(true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FEE_WALLET_BALANCE_TIMEOUT_MS)
    })
    expect(result.current.checkingFees).toBe(false)
    // Unreadable is not "unfunded": nothing is blocked; simulation would explain a real problem.
    expect(result.current.executeBlocker).toBeNull()
    // Later (stale balance → re-read, which hangs again): the approve still goes through, bounded.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      const started = result.current.startCleanup()
      await vi.advanceTimersByTimeAsync(2 * FEE_WALLET_BALANCE_TIMEOUT_MS)
      await started
    })
    expect(h.execute).toHaveBeenCalledTimes(1)
  })

  it('"Stop waiting" aborts the run: the dialog can be left, and what is known stays on screen', async () => {
    h.rpc = { getRecentPrioritizationFees: async () => [] }
    const { result } = await realReady()
    let signal: AbortSignal | undefined
    h.execute = vi.fn(
      (params: { signal?: AbortSignal; onProgress: (p: unknown[]) => void }) =>
        new Promise((_, reject) => {
          signal = params.signal
          params.onProgress([{ index: 0, status: 'awaiting-signature', accountCount: 2, reclaimLamports: 1 }])
          // A wallet prompt that never returns; only the abort ends it.
          params.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
        }),
    )
    let run: Promise<void> = Promise.resolve()
    await act(async () => {
      run = result.current.startCleanup()
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(result.current.cleanup.phase).toBe('executing')
    expect(signal).toBeInstanceOf(AbortSignal)
    await act(async () => {
      result.current.stopCleanup()
      await run
    })
    expect(signal!.aborted).toBe(true)
    expect(result.current.cleanup.phase).toBe('error')
    expect(result.current.cleanup.error).toBe(STOPPED_MESSAGE)
    expect(result.current.cleanup.progress).toHaveLength(1)
    // A new run can start (no stuck executing guard).
    h.execute = vi.fn(async () => [])
    act(() => result.current.openReview())
    await waitFor(() => expect(result.current.checkingFees).toBe(false))
    await act(async () => {
      await result.current.startCleanup()
    })
    expect(h.execute).toHaveBeenCalledTimes(1)
  })
})

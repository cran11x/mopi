// State layer execution guards (fund safety): re-entrancy and stale scans.
import { createElement, type ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { Keypair } from '@solana/web3.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Cluster, ScanResult } from '../lib/types'
import { eligibleAccount } from '../test/solanaFixtures'

const h = vi.hoisted(() => ({
  cluster: 'mainnet-beta' as Cluster,
  wallet: {} as Record<string, unknown>,
  scanImpl: null as null | ((owner: string, cluster: Cluster) => Promise<ScanResult>),
  execute: null as unknown as ReturnType<typeof vi.fn>,
  connections: {} as Record<string, unknown>,
}))

vi.mock('@solana/wallet-adapter-react', () => ({
  useConnection: () => ({ connection: (h.connections[h.cluster] ??= { rpcEndpoint: h.cluster }) }),
  useWallet: () => h.wallet,
}))
vi.mock('./cluster', () => ({ useCluster: () => ({ cluster: h.cluster }) }))
vi.mock('../lib/solana/scan', () => ({
  scanWallet: (_c: unknown, owner: { toBase58(): string }, opts: { cluster: Cluster }) =>
    h.scanImpl!(owner.toBase58(), opts.cluster),
}))
vi.mock('../lib/solana/execute', () => ({ executeCleanup: (...args: unknown[]) => h.execute(...args) }))

import { CleanerProvider, useCleaner } from './cleaner'

function scanFor(owner: string, cluster: Cluster): ScanResult {
  const eligible = [eligibleAccount(owner), eligibleAccount(owner)]
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
})

describe('cleaner execution guards', () => {
  it('two startCleanup calls in the same tick start only one execution', async () => {
    const { result } = renderHook(() => useCleaner(), { wrapper })
    await waitFor(() => expect(result.current.scan?.isDemo).toBe(false))
    expect(result.current.executeBlocker).toBeNull()

    act(() => {
      void result.current.startCleanup()
      void result.current.startCleanup()
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

    // Scan is still the mainnet one, connection is devnet.
    expect(result.current.scan?.cluster).toBe('mainnet-beta')
    expect(result.current.executeBlocker).toBe('stale-scan')

    await act(async () => {
      await result.current.startCleanup()
    })
    expect(h.execute).not.toHaveBeenCalled()
    expect(result.current.cleanup.phase).toBe('error')
    expect(result.current.cleanup.error).toMatch(/another network/)
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

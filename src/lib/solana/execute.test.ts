// @vitest-environment node
// (buffer-layout's instanceof Uint8Array checks fail across the jsdom realm.)
import {
  Keypair,
  SystemProgram,
  TransactionExpiredBlockheightExceededError,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
} from '@solana/web3.js'
import { describe, expect, it, vi } from 'vitest'
import { MESSAGES, describeTransactionError, executeCleanup, isUserRejection } from './execute'
import { buildQuote } from './fees'
import { TOKEN_PROGRAM_ID } from './programs'
import type { BatchProgress, CleanupWallet } from '../types'
import { T22, eligibleAccount, randomKey, testFeeConfig } from '../../test/solanaFixtures'

const BLOCKHASH = Keypair.generate().publicKey.toBase58()

function setup(n = 45) {
  const ownerKp = Keypair.generate()
  const owner = ownerKp.publicKey.toBase58()
  const fee = testFeeConfig()
  const accounts = Array.from({ length: n }, (_, i) =>
    eligibleAccount(owner, i % 3 === 0 ? { program: 'token-2022', programId: T22, lamports: 2_157_600 } : {}),
  )
  const quote = buildQuote(accounts, fee)
  return { ownerKp, fee, quote }
}

function mockConnection() {
  let n = 0
  const c = {
    getLatestBlockhash: vi.fn(async (_c?: string) => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 99 })),
    simulateTransaction: vi.fn(async (_tx: VersionedTransaction, _o?: unknown) => ({
      context: { slot: 1 },
      value: { err: null as unknown, logs: [] as string[] | null },
    })),
    sendRawTransaction: vi.fn(async (_raw: Uint8Array, _o?: unknown) => `sig${++n}`),
    confirmTransaction: vi.fn(async (_s: unknown, _c?: string) => ({ context: { slot: 1 }, value: { err: null as unknown } })),
  }
  return { c, connection: c as unknown as Connection }
}

type SignAll = (txs: VersionedTransaction[]) => Promise<VersionedTransaction[]>
type SignOne = (tx: VersionedTransaction) => Promise<VersionedTransaction>

function wallet(kp: Keypair, mode: 'all' | 'one', overrides: { signAll?: SignAll; signOne?: SignOne } = {}) {
  const signAll = vi.fn(
    overrides.signAll ??
      (async (txs: VersionedTransaction[]) => {
        txs.forEach((t) => t.sign([kp]))
        return txs
      }),
  )
  const signOne = vi.fn(
    overrides.signOne ??
      (async (tx: VersionedTransaction) => {
        tx.sign([kp])
        return tx
      }),
  )
  const sendTransaction = vi.fn()
  const w = {
    publicKey: kp.publicKey,
    signAllTransactions: mode === 'all' ? signAll : undefined,
    signTransaction: signOne,
    sendTransaction,
  }
  return { w: w as unknown as CleanupWallet, signAll, signOne, sendTransaction }
}

function recorder() {
  const snapshots: BatchProgress[][] = []
  return { snapshots, onProgress: (p: BatchProgress[]) => snapshots.push(p), last: () => snapshots[snapshots.length - 1] }
}

/** Re-compiles `tx` with an extra instruction appended and signs it (a wallet "injecting" an ix). */
function tamper(tx: VersionedTransaction, kp: Keypair): VersionedTransaction {
  const msg = TransactionMessage.decompile(tx.message)
  msg.instructions.push(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: randomKey(), lamports: 1 }))
  const out = new VersionedTransaction(msg.compileToV0Message())
  out.sign([kp])
  return out
}

describe('executeCleanup', () => {
  it('happy path: one signAllTransactions prompt, simulate → send → confirm every batch', async () => {
    const { ownerKp, fee, quote } = setup(45)
    const { c, connection } = mockConnection()
    const { w, signAll, signOne, sendTransaction } = wallet(ownerKp, 'all')
    const rec = recorder()

    const result = await executeCleanup({ connection, wallet: w, quote, fee, onProgress: rec.onProgress })

    expect(quote.batches).toHaveLength(3)
    expect(signAll).toHaveBeenCalledTimes(1)
    expect(signAll.mock.calls[0][0]).toHaveLength(3)
    expect(signOne).not.toHaveBeenCalled()
    expect(sendTransaction).not.toHaveBeenCalled()
    expect(c.getLatestBlockhash).toHaveBeenCalledTimes(1)

    expect(c.simulateTransaction).toHaveBeenCalledTimes(3)
    for (const call of c.simulateTransaction.mock.calls) {
      expect(call[1]).toEqual({ sigVerify: false, commitment: 'confirmed' })
    }
    expect(c.sendRawTransaction).toHaveBeenCalledTimes(3)
    c.sendRawTransaction.mock.calls.forEach((call, i) => {
      expect(call[1]).toEqual({ skipPreflight: true, maxRetries: 3 })
      const sent = VersionedTransaction.deserialize(call[0])
      expect(sent.signatures[0].some((b) => b !== 0)).toBe(true)
      expect(sent.message.recentBlockhash).toBe(BLOCKHASH)
      expect(sent.message.compiledInstructions.length).toBe(2 + quote.batches[i].accounts.length + 1)
    })
    expect(c.confirmTransaction).toHaveBeenCalledTimes(3)
    c.confirmTransaction.mock.calls.forEach((call, i) => {
      expect(call[0]).toEqual({ signature: `sig${i + 1}`, blockhash: BLOCKHASH, lastValidBlockHeight: 99 })
      expect(call[1]).toBe('confirmed')
    })

    expect(result.map((p) => p.status)).toEqual(['confirmed', 'confirmed', 'confirmed'])
    expect(result.map((p) => p.signature)).toEqual(['sig1', 'sig2', 'sig3'])
    result.forEach((p, i) => {
      expect(p.index).toBe(quote.batches[i].index)
      expect(p.accountCount).toBe(quote.batches[i].accounts.length)
      expect(p.reclaimLamports).toBe(quote.batches[i].reclaimLamports)
    })

    // Progress: starts pending, walks through every phase, fresh arrays each time.
    expect(rec.snapshots[0].map((p) => p.status)).toEqual(['pending', 'pending', 'pending'])
    const seen = new Set(rec.snapshots.flatMap((s) => s.map((p) => p.status)))
    for (const s of ['pending', 'simulating', 'awaiting-signature', 'sending', 'confirmed']) expect(seen.has(s as never)).toBe(true)
    expect(new Set(rec.snapshots).size).toBe(rec.snapshots.length)
    expect(rec.last()).toEqual(result)
  })

  it('falls back to signTransaction per batch', async () => {
    const { ownerKp, fee, quote } = setup(45)
    const { c, connection } = mockConnection()
    const { w, signOne } = wallet(ownerKp, 'one')
    const result = await executeCleanup({ connection, wallet: w, quote, fee, onProgress: () => {} })
    expect(signOne).toHaveBeenCalledTimes(3)
    expect(c.sendRawTransaction).toHaveBeenCalledTimes(3)
    expect(result.every((p) => p.status === 'confirmed')).toBe(true)
  })

  it('a failed simulation marks that batch failed and never sends it; others proceed', async () => {
    const { ownerKp, fee, quote } = setup(45)
    const { c, connection } = mockConnection()
    c.simulateTransaction
      .mockResolvedValueOnce({ context: { slot: 1 }, value: { err: null, logs: [] } })
      .mockResolvedValueOnce({
        context: { slot: 1 },
        value: {
          err: { InstructionError: [4, { Custom: 11 }] },
          logs: ['Program log: Error: Non-native account can only be closed if its balance is zero', 'custom program error: 0xb'],
        },
      })
    const { w, signAll } = wallet(ownerKp, 'all')
    const result = await executeCleanup({ connection, wallet: w, quote, fee, onProgress: () => {} })

    expect(result[1]).toMatchObject({ status: 'failed', error: MESSAGES.hasTokens })
    expect(result[1].signature).toBeUndefined()
    expect(result[0].status).toBe('confirmed')
    expect(result[2].status).toBe('confirmed')
    expect(signAll.mock.calls[0][0]).toHaveLength(2)
    expect(c.sendRawTransaction).toHaveBeenCalledTimes(2)
  })

  it('no prompt at all when every simulation fails', async () => {
    const { ownerKp, fee, quote } = setup(5)
    const { c, connection } = mockConnection()
    c.simulateTransaction.mockResolvedValue({ context: { slot: 1 }, value: { err: 'InsufficientFundsForFee', logs: [] } })
    const { w, signAll } = wallet(ownerKp, 'all')
    const result = await executeCleanup({ connection, wallet: w, quote, fee, onProgress: () => {} })
    expect(result).toEqual([expect.objectContaining({ status: 'failed', error: MESSAGES.noSolForFee })])
    expect(signAll).not.toHaveBeenCalled()
    expect(c.sendRawTransaction).not.toHaveBeenCalled()
  })

  it('a simulation RPC error fails that batch without sending', async () => {
    const { ownerKp, fee, quote } = setup(5)
    const { c, connection } = mockConnection()
    c.simulateTransaction.mockRejectedValueOnce(new Error('503 Service Unavailable'))
    const { w } = wallet(ownerKp, 'all')
    const result = await executeCleanup({ connection, wallet: w, quote, fee, onProgress: () => {} })
    expect(result[0].status).toBe('failed')
    expect(result[0].error).toMatch(/503/)
    expect(c.sendRawTransaction).not.toHaveBeenCalled()
  })

  it('a wallet that injects an instruction gets that tx rejected (not sent)', async () => {
    const { ownerKp, fee, quote } = setup(45)
    const { c, connection } = mockConnection()
    const { w } = wallet(ownerKp, 'all', {
      signAll: async (txs) =>
        txs.map((t, k) => {
          if (k === 0) return tamper(t, ownerKp)
          t.sign([ownerKp])
          return t
        }),
    })
    const result = await executeCleanup({ connection, wallet: w, quote, fee, onProgress: () => {} })
    expect(result[0]).toMatchObject({ status: 'failed', error: MESSAGES.walletModified })
    expect(result[1].status).toBe('confirmed')
    expect(result[2].status).toBe('confirmed')
    expect(c.sendRawTransaction).toHaveBeenCalledTimes(2)
  })

  it('a wallet that changes the blockhash or does not sign is rejected too', async () => {
    const { ownerKp, fee, quote } = setup(25)
    const { c, connection } = mockConnection()
    const { w } = wallet(ownerKp, 'one', {
      signOne: async (tx) => {
        if (tx.message.compiledInstructions.length > 10) {
          const msg = TransactionMessage.decompile(tx.message)
          msg.recentBlockhash = Keypair.generate().publicKey.toBase58()
          const out = new VersionedTransaction(msg.compileToV0Message())
          out.sign([ownerKp])
          return out
        }
        return tx // unsigned
      },
    })
    const result = await executeCleanup({ connection, wallet: w, quote, fee, onProgress: () => {} })
    expect(result.map((p) => p.error)).toEqual([MESSAGES.walletModified, MESSAGES.walletModified])
    expect(c.sendRawTransaction).not.toHaveBeenCalled()
  })

  it('a wallet returning the wrong number of txs sends nothing', async () => {
    const { ownerKp, fee, quote } = setup(45)
    const { c, connection } = mockConnection()
    const { w } = wallet(ownerKp, 'all', { signAll: async (txs) => txs.slice(1) })
    const result = await executeCleanup({ connection, wallet: w, quote, fee, onProgress: () => {} })
    expect(result.every((p) => p.status === 'failed' && p.error === MESSAGES.walletBadResponse)).toBe(true)
    expect(c.sendRawTransaction).not.toHaveBeenCalled()
  })

  it('user rejection (signAll): every batch skipped, error rethrown, nothing sent', async () => {
    const { ownerKp, fee, quote } = setup(45)
    const { c, connection } = mockConnection()
    const rejection = Object.assign(new Error('User rejected the request.'), { name: 'WalletSignTransactionError' })
    const { w } = wallet(ownerKp, 'all', { signAll: async () => Promise.reject(rejection) })
    const rec = recorder()
    await expect(executeCleanup({ connection, wallet: w, quote, fee, onProgress: rec.onProgress })).rejects.toBe(rejection)
    expect(rec.last().map((p) => p.status)).toEqual(['skipped', 'skipped', 'skipped'])
    expect(c.sendRawTransaction).not.toHaveBeenCalled()
  })

  it('user rejection mid-way (signTransaction): sent batch stays confirmed, rest skipped, rethrown', async () => {
    const { ownerKp, fee, quote } = setup(45)
    const { c, connection } = mockConnection()
    let calls = 0
    const { w } = wallet(ownerKp, 'one', {
      signOne: async (tx) => {
        if (++calls === 2) throw new Error('Transaction cancelled')
        tx.sign([ownerKp])
        return tx
      },
    })
    const rec = recorder()
    await expect(executeCleanup({ connection, wallet: w, quote, fee, onProgress: rec.onProgress })).rejects.toThrow(
      'Transaction cancelled',
    )
    expect(rec.last().map((p) => p.status)).toEqual(['confirmed', 'skipped', 'skipped'])
    expect(c.sendRawTransaction).toHaveBeenCalledTimes(1)
  })

  it('a non-rejection signing error fails unsent batches and rethrows', async () => {
    const { ownerKp, fee, quote } = setup(5)
    const { connection } = mockConnection()
    const { w } = wallet(ownerKp, 'all', { signAll: async () => Promise.reject(new Error('Wallet disconnected')) })
    const rec = recorder()
    await expect(executeCleanup({ connection, wallet: w, quote, fee, onProgress: rec.onProgress })).rejects.toThrow(
      'Wallet disconnected',
    )
    expect(rec.last()[0]).toMatchObject({ status: 'failed' })
  })

  it('confirmation failures: expired blockhash and on-chain error', async () => {
    const { ownerKp, fee, quote } = setup(45)
    const { c, connection } = mockConnection()
    c.confirmTransaction
      .mockResolvedValueOnce({ context: { slot: 1 }, value: { err: null } })
      .mockRejectedValueOnce(new TransactionExpiredBlockheightExceededError('sig2'))
      .mockResolvedValueOnce({ context: { slot: 1 }, value: { err: { InstructionError: [2, 'IncorrectProgramId'] } } })
    const { w } = wallet(ownerKp, 'all')
    const result = await executeCleanup({ connection, wallet: w, quote, fee, onProgress: () => {} })
    expect(result[0].status).toBe('confirmed')
    expect(result[1]).toMatchObject({ status: 'failed', signature: 'sig2', error: MESSAGES.expired })
    expect(result[2]).toMatchObject({ status: 'failed', signature: 'sig3', error: MESSAGES.alreadyClosed })
  })

  it('a send error fails that batch only', async () => {
    const { ownerKp, fee, quote } = setup(45)
    const { c, connection } = mockConnection()
    c.sendRawTransaction.mockRejectedValueOnce(new Error('Node is behind'))
    const { w } = wallet(ownerKp, 'all')
    const result = await executeCleanup({ connection, wallet: w, quote, fee, onProgress: () => {} })
    expect(result[0]).toMatchObject({ status: 'failed' })
    expect(result[0].error).toMatch(/Node is behind/)
    expect(result.slice(1).every((p) => p.status === 'confirmed')).toBe(true)
  })

  it('a blockhash/build failure fails every batch without prompting', async () => {
    const { ownerKp, fee, quote } = setup(25)
    const { c, connection } = mockConnection()
    c.getLatestBlockhash.mockRejectedValueOnce(new Error('fetch failed'))
    const { w, signAll } = wallet(ownerKp, 'all')
    const result = await executeCleanup({ connection, wallet: w, quote, fee, onProgress: () => {} })
    expect(result.every((p) => p.status === 'failed' && /fetch failed/.test(p.error ?? ''))).toBe(true)
    expect(signAll).not.toHaveBeenCalled()
  })

  it('refuses to run for a quote of another owner (builder safety)', async () => {
    const { fee, quote } = setup(5)
    const { c, connection } = mockConnection()
    const { w, signAll } = wallet(Keypair.generate(), 'all')
    const result = await executeCleanup({ connection, wallet: w, quote, fee, onProgress: () => {} })
    expect(result[0].status).toBe('failed')
    expect(c.simulateTransaction).not.toHaveBeenCalled()
    expect(signAll).not.toHaveBeenCalled()
  })

  it('aborted before start → AbortError, nothing happens', async () => {
    const { ownerKp, fee, quote } = setup(5)
    const { c, connection } = mockConnection()
    const { w } = wallet(ownerKp, 'all')
    const ac = new AbortController()
    ac.abort()
    const rec = recorder()
    await expect(
      executeCleanup({ connection, wallet: w, quote, fee, onProgress: rec.onProgress, signal: ac.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(c.getLatestBlockhash).not.toHaveBeenCalled()
    expect(rec.last()[0].status).toBe('skipped')
  })

  it('aborted while the wallet prompt is open → nothing sent', async () => {
    const { ownerKp, fee, quote } = setup(25)
    const { c, connection } = mockConnection()
    const ac = new AbortController()
    const { w } = wallet(ownerKp, 'all', {
      signAll: async (txs) => {
        ac.abort()
        txs.forEach((t) => t.sign([ownerKp]))
        return txs
      },
    })
    const rec = recorder()
    await expect(
      executeCleanup({ connection, wallet: w, quote, fee, onProgress: rec.onProgress, signal: ac.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(c.sendRawTransaction).not.toHaveBeenCalled()
    expect(rec.last().map((p) => p.status)).toEqual(['skipped', 'skipped'])
  })

  it('throws without a connected wallet / signing ability', async () => {
    const { fee, quote } = setup(1)
    const { connection } = mockConnection()
    await expect(
      executeCleanup({ connection, wallet: { publicKey: null }, quote, fee, onProgress: () => {} }),
    ).rejects.toThrow(/Connect a wallet/)
    await expect(
      executeCleanup({ connection, wallet: { publicKey: Keypair.generate().publicKey }, quote, fee, onProgress: () => {} }),
    ).rejects.toThrow(/cannot sign/)
  })

  it('empty quote resolves with no batches', async () => {
    const { ownerKp, fee } = setup(1)
    const { connection } = mockConnection()
    const { w, signAll } = wallet(ownerKp, 'all')
    const res = await executeCleanup({ connection, wallet: w, quote: buildQuote([], fee), fee, onProgress: () => {} })
    expect(res).toEqual([])
    expect(signAll).not.toHaveBeenCalled()
  })
})

describe('describeTransactionError', () => {
  const tokenIx = [TOKEN_PROGRAM_ID.toBase58()]
  it('maps common failures', () => {
    expect(describeTransactionError({ InstructionError: [0, { Custom: 11 }] }, [], tokenIx)).toBe(MESSAGES.hasTokens)
    expect(describeTransactionError({ InstructionError: [0, { Custom: 0 }] }, ['Program X failed: custom program error: 0xb'])).toBe(
      MESSAGES.hasTokens,
    )
    expect(describeTransactionError('InsufficientFundsForFee')).toBe(MESSAGES.noSolForFee)
    expect(describeTransactionError(null, ['Transaction simulation failed: Error processing: insufficient funds for fee'])).toBe(
      MESSAGES.noSolForFee,
    )
    expect(describeTransactionError('AccountNotFound')).toBe(MESSAGES.noSolForFee)
    expect(describeTransactionError({ InstructionError: [0, 'IncorrectProgramId'] }, [], tokenIx)).toBe(MESSAGES.alreadyClosed)
    expect(describeTransactionError({ InstructionError: [0, { Custom: 9 }] }, [], tokenIx)).toBe(MESSAGES.alreadyClosed)
    expect(describeTransactionError({ InstructionError: [0, { Custom: 17 }] }, [], tokenIx)).toBe(MESSAGES.frozen)
    expect(describeTransactionError({ InstructionError: [0, { Custom: 1 }] }, ['Program log: Error: could not find account'])).toBe(
      MESSAGES.alreadyClosed,
    )
    expect(describeTransactionError({ InsufficientFundsForRent: { account_index: 3 } })).toBe(MESSAGES.rent)
    expect(describeTransactionError('BlockhashNotFound')).toBe(MESSAGES.blockhash)
  })

  it('does not read token custom codes on non-token instructions', () => {
    const r = describeTransactionError({ InstructionError: [0, { Custom: 11 }] }, ['Program log: Error: weird thing'], [
      SystemProgram.programId.toBase58(),
    ])
    expect(r).toBe('weird thing')
  })

  it('falls back to the first relevant log line, then the raw error', () => {
    expect(
      describeTransactionError({ InstructionError: [1, 'InvalidArgument'] }, [
        'Program ComputeBudget111111111111111111111111111111 invoke [1]',
        'Program log: Error: Something specific broke',
        'Program failed to complete',
      ]),
    ).toBe('Something specific broke')
    expect(describeTransactionError({ InstructionError: [1, 'InvalidArgument'] }, [])).toMatch(/InvalidArgument/)
  })
})

describe('isUserRejection', () => {
  it('detects wallet rejections', () => {
    expect(isUserRejection(Object.assign(new Error('x'), { name: 'WalletSignTransactionError' }))).toBe(true)
    expect(isUserRejection(new Error('User rejected the request.'))).toBe(true)
    expect(isUserRejection(new Error('Request declined'))).toBe(true)
    expect(isUserRejection(new Error('Cancelled by user'))).toBe(true)
    expect(isUserRejection(new Error('Wallet disconnected'))).toBe(false)
    expect(isUserRejection(null)).toBe(false)
  })
})

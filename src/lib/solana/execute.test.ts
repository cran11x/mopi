// @vitest-environment node
// (buffer-layout's instanceof Uint8Array checks fail across the jsdom realm.)
import {
  Connection,
  Keypair,
  PublicKey,
  SendTransactionError,
  SystemProgram,
  TransactionExpiredBlockheightExceededError,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import { createPublicKey, verify as verifySignature } from 'node:crypto'
import { Buffer } from 'buffer'
import { describe, expect, it, vi } from 'vitest'
import {
  MESSAGES,
  SEND_OPTIONS,
  describeSendError,
  describeTransactionError,
  executeCleanup,
  isUserRejection,
} from './execute'
import { buildQuote } from './fees'
import { TOKEN_PROGRAM_ID } from './programs'
import { assertSafeCleanupTransaction } from './transactions'
import type { BatchProgress, CleanupQuote, CleanupWallet } from '../types'
import { RENT, SPL, T22, eligibleAccount, randomKey, testFeeConfig } from '../../test/solanaFixtures'

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

type SigStatus = { slot: number; confirmations: number | null; err: unknown; confirmationStatus?: string } | null

function mockConnection(opts: { sendDelayMs?: number } = {}) {
  let n = 0
  const c = {
    getLatestBlockhash: vi.fn(async (_c?: string) => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 99 })),
    simulateTransaction: vi.fn(async (_tx: VersionedTransaction, _o?: unknown) => ({
      context: { slot: 1 },
      value: { err: null as unknown, logs: [] as string[] | null },
    })),
    sendRawTransaction: vi.fn(async (_raw: Uint8Array, _o?: unknown) => {
      if (opts.sendDelayMs) await new Promise((r) => setTimeout(r, opts.sendDelayMs))
      return `sig${++n}`
    }),
    confirmTransaction: vi.fn(async (_s: unknown, _c?: string) => ({ context: { slot: 1 }, value: { err: null as unknown } })),
    // Block height still inside the blockhash's lifetime (lastValidBlockHeight 99).
    getBlockHeight: vi.fn(async (_c?: string) => 50),
    getSignatureStatuses: vi.fn(async (_s: string[], _o?: unknown) => ({ context: { slot: 1 }, value: [null as SigStatus] })),
    getMultipleParsedAccounts: vi.fn(async (_keys: PublicKey[], _o?: unknown) => ({
      context: { slot: 1 },
      value: [] as unknown[],
    })),
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


/** Ed25519 signature check with Node's built-in crypto (raw 32-byte public key → SPKI DER). */
function ed25519Verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKey)])
  const key = createPublicKey({ key: spki, format: 'der', type: 'spki' })
  return verifySignature(null, Buffer.from(message), key, Buffer.from(signature))
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
      expect(call[1]).toEqual(SEND_OPTIONS)
      expect(call[1]).toEqual({ skipPreflight: false, preflightCommitment: 'confirmed' })
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
    // …unless the account that would end up below the rent-exempt minimum is the fee wallet.
    const feeWallet = randomKey().toBase58()
    const accountKeys = [randomKey().toBase58(), randomKey().toBase58(), feeWallet]
    expect(
      describeTransactionError({ InsufficientFundsForRent: { account_index: 2 } }, [], [], { accountKeys, feeWallet }),
    ).toBe(MESSAGES.feeWalletUnfunded)
    expect(
      describeTransactionError({ InsufficientFundsForRent: { account_index: 0 } }, [], [], { accountKeys, feeWallet }),
    ).toBe(MESSAGES.rent)
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

// ── Fund safety: what is verified is exactly what is sent ──────────────────

/** Every System transfer in a serialized tx: [to, lamports]. */
function transfersIn(raw: Uint8Array): Array<{ to: string; lamports: bigint }> {
  const tx = VersionedTransaction.deserialize(raw)
  const msg = TransactionMessage.decompile(tx.message)
  return msg.instructions
    .filter((ix) => ix.programId.equals(SystemProgram.programId))
    .map((ix) => ({ to: ix.keys[1].pubkey.toBase58(), lamports: Buffer.from(ix.data).readBigUInt64LE(4) }))
}

/** `tx` plus a 5 SOL transfer owner → attacker, signed by the owner. */
function malicious(tx: VersionedTransaction, kp: Keypair, attacker: PublicKey): VersionedTransaction {
  const msg = TransactionMessage.decompile(tx.message)
  msg.instructions.push(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: attacker, lamports: 5_000_000_000 }))
  const out = new VersionedTransaction(msg.compileToV0Message())
  out.sign([kp])
  return out
}

function sentTo(c: ReturnType<typeof mockConnection>['c'], who: PublicKey) {
  return c.sendRawTransaction.mock.calls.flatMap((call) => transfersIn(call[0]).filter((t) => t.to === who.toBase58()))
}

describe('fund safety: the verified bytes are exactly what gets sent', () => {
  it('a tx mutated in place after verification (between sequential sends) is still sent as verified', async () => {
    const kp = Keypair.generate()
    const fee = testFeeConfig()
    const quote = buildQuote(Array.from({ length: 25 }, () => eligibleAccount(kp.publicKey.toBase58())), fee)
    expect(quote.batches).toHaveLength(2)
    const attacker = randomKey()
    const { c, connection } = mockConnection({ sendDelayMs: 20 })
    const w: CleanupWallet = {
      publicKey: kp.publicKey,
      signAllTransactions: (async (txs: VersionedTransaction[]) => {
        txs.forEach((t) => t.sign([kp]))
        // After mopi re-verifies but before the 2nd tx would be serialized, swap its contents.
        setTimeout(() => {
          const evil = malicious(txs[1], kp, attacker)
          txs[1].message = evil.message
          txs[1].signatures = evil.signatures
        }, 5)
        return txs
      }) as CleanupWallet['signAllTransactions'],
    }
    const result = await executeCleanup({ connection, wallet: w, quote, fee, onProgress: () => {} })
    expect(sentTo(c, attacker)).toEqual([])
    expect(result.map((p) => p.status)).toEqual(['confirmed', 'confirmed'])
    c.sendRawTransaction.mock.calls.forEach((call, i) => {
      expect(() => assertSafeCleanupTransaction(VersionedTransaction.deserialize(call[0]), kp.publicKey, quote.batches[i], fee)).not.toThrow()
    })
  })

  it('a returned object whose serialize() differs from its .message is rejected, not sent', async () => {
    const kp = Keypair.generate()
    const fee = testFeeConfig()
    const quote = buildQuote([eligibleAccount(kp.publicKey.toBase58())], fee)
    const attacker = randomKey()
    const { c, connection } = mockConnection()
    const w: CleanupWallet = {
      publicKey: kp.publicKey,
      signAllTransactions: (async (txs: VersionedTransaction[]) => {
        const honest = txs[0]
        honest.sign([kp])
        const evilBytes = malicious(honest, kp, attacker).serialize()
        return [{ message: honest.message, signatures: honest.signatures, serialize: () => evilBytes }]
      }) as unknown as CleanupWallet['signAllTransactions'],
    }
    const result = await executeCleanup({ connection, wallet: w, quote, fee, onProgress: () => {} })
    expect(sentTo(c, attacker)).toEqual([])
    expect(c.sendRawTransaction).not.toHaveBeenCalled()
    expect(result[0]).toMatchObject({ status: 'failed', error: MESSAGES.walletModified })
  })

  it('non-canonical bytes (trailing data) or a non-transaction response are rejected', async () => {
    const kp = Keypair.generate()
    const fee = testFeeConfig()
    const quote = buildQuote(Array.from({ length: 25 }, () => eligibleAccount(kp.publicKey.toBase58())), fee)
    const { c, connection } = mockConnection()
    const w: CleanupWallet = {
      publicKey: kp.publicKey,
      signAllTransactions: (async (txs: VersionedTransaction[]) => {
        txs[0].sign([kp])
        const bytes = txs[0].serialize()
        const padded = new Uint8Array(bytes.length + 1)
        padded.set(bytes)
        return [{ serialize: () => padded }, { nope: true }]
      }) as unknown as CleanupWallet['signAllTransactions'],
    }
    const result = await executeCleanup({ connection, wallet: w, quote, fee, onProgress: () => {} })
    expect(result.map((p) => p.error)).toEqual([MESSAGES.walletBadResponse, MESSAGES.walletBadResponse])
    expect(c.sendRawTransaction).not.toHaveBeenCalled()
  })
})

describe('fund safety: cross-batch duplicate accounts', () => {
  it('a quote listing one account in two batches is refused before anything is simulated or signed', async () => {
    const kp = Keypair.generate()
    const owner = kp.publicKey.toBase58()
    const fee = testFeeConfig()
    const accounts = Array.from({ length: 20 }, () => eligibleAccount(owner))
    const first = buildQuote(accounts, fee)
    const second = buildQuote([{ ...accounts[0] }], fee).batches[0]
    // State/UI bug: the duplicate lands in a second batch (buildQuote itself dedupes).
    const quote: CleanupQuote = { ...first, accountCount: 21, batches: [...first.batches, { ...second, index: 1 }] }
    const { c, connection } = mockConnection()
    const { w, signAll } = wallet(kp, 'all')
    const progress = await executeCleanup({ connection, wallet: w, quote, fee, onProgress: () => {} })
    expect(progress.map((p) => p.status)).toEqual(['failed', 'failed'])
    expect(progress[1].error).toMatch(/appears in batch 0 and batch 1/)
    expect(c.simulateTransaction).not.toHaveBeenCalled()
    expect(signAll).not.toHaveBeenCalled()
    expect(c.sendRawTransaction).not.toHaveBeenCalled()
  })

  it('buildQuote drops a repeated address, so totals count it once', () => {
    const owner = randomKey().toBase58()
    const accounts = Array.from({ length: 20 }, () => eligibleAccount(owner))
    const quote = buildQuote([...accounts, { ...accounts[0] }], testFeeConfig())
    expect(quote.accountCount).toBe(20)
    expect(quote.batches).toHaveLength(1)
    expect(quote.reclaimLamports).toBe(20 * RENT)
  })
})

// ── Blockhash lifetime, preflight and confirmation ─────────────────────────

describe('blockhash lifetime and confirmation', () => {
  it('per-prompt signing gives every prompt after the first a fresh blockhash (still safety-checked)', async () => {
    const { ownerKp, fee, quote } = setup(45)
    const { c, connection } = mockConnection()
    const hashes = [BLOCKHASH, randomKey().toBase58(), randomKey().toBase58()]
    let call = 0
    c.getLatestBlockhash.mockImplementation(async () => {
      const k = call++
      return { blockhash: hashes[k], lastValidBlockHeight: 99 + k }
    })
    const { w, signOne } = wallet(ownerKp, 'one')
    const result = await executeCleanup({ connection, wallet: w, quote, fee, onProgress: () => {} })
    expect(result.map((p) => p.status)).toEqual(['confirmed', 'confirmed', 'confirmed'])
    expect(c.getLatestBlockhash).toHaveBeenCalledTimes(3)
    expect(signOne.mock.calls.map((args) => args[0].message.recentBlockhash)).toEqual(hashes)
    c.sendRawTransaction.mock.calls.forEach((args, i) => {
      const sent = VersionedTransaction.deserialize(args[0])
      expect(sent.message.recentBlockhash).toBe(hashes[i])
      expect(() => assertSafeCleanupTransaction(sent, ownerKp.publicKey, quote.batches[i], fee)).not.toThrow()
    })
    expect(c.confirmTransaction.mock.calls.map((args) => args[0])).toEqual(
      hashes.map((blockhash, i) => ({ signature: `sig${i + 1}`, blockhash, lastValidBlockHeight: 99 + i })),
    )
  })

  it('signed txs whose blockhash expired while the user was signing are not broadcast', async () => {
    const { ownerKp, fee, quote } = setup(45)
    const { c, connection } = mockConnection()
    c.getBlockHeight.mockResolvedValue(500) // > lastValidBlockHeight 99
    const { w } = wallet(ownerKp, 'one')
    const result = await executeCleanup({ connection, wallet: w, quote, fee, onProgress: () => {} })
    expect(c.getLatestBlockhash).toHaveBeenCalledTimes(3)
    expect(c.getBlockHeight).toHaveBeenCalled()
    expect(c.sendRawTransaction).not.toHaveBeenCalled()
    expect(result.every((p) => p.status === 'failed' && p.error === MESSAGES.expired)).toBe(true)
  })

  it('signAll: expired txs are dropped before any send; an unreadable block height falls back to preflight', async () => {
    const { ownerKp, fee, quote } = setup(25)
    const { c, connection } = mockConnection()
    c.getBlockHeight.mockResolvedValueOnce(100)
    const { w } = wallet(ownerKp, 'all')
    const expired = await executeCleanup({ connection, wallet: w, quote, fee, onProgress: () => {} })
    expect(expired.map((p) => p.error)).toEqual([MESSAGES.expired, MESSAGES.expired])
    expect(c.sendRawTransaction).not.toHaveBeenCalled()

    c.getBlockHeight.mockRejectedValueOnce(new Error('503'))
    const sent = await executeCleanup({ connection, wallet: w, quote, fee, onProgress: () => {} })
    expect(sent.map((p) => p.status)).toEqual(['confirmed', 'confirmed'])
  })

  it('a tx that landed is reported confirmed even when confirmTransaction throws on expiry', async () => {
    const { ownerKp, fee, quote } = setup(3)
    const { c, connection } = mockConnection()
    c.confirmTransaction.mockImplementation(async (s: unknown) => {
      throw new TransactionExpiredBlockheightExceededError((s as { signature: string }).signature)
    })
    c.getSignatureStatuses.mockResolvedValue({
      context: { slot: 120 },
      value: [{ slot: 90, confirmations: null, err: null, confirmationStatus: 'finalized' }],
    })
    const { w } = wallet(ownerKp, 'all')
    const progress = await executeCleanup({ connection, wallet: w, quote, fee, onProgress: () => {} })
    expect(progress[0]).toMatchObject({ status: 'confirmed', signature: 'sig1' })
    expect(c.getSignatureStatuses).toHaveBeenCalledWith(['sig1'], { searchTransactionHistory: true })
  })

  it('final status: an on-chain error is described; no status at all stays "expired"', async () => {
    const { ownerKp, fee, quote } = setup(25)
    const { c, connection } = mockConnection()
    c.confirmTransaction.mockRejectedValue(new TransactionExpiredBlockheightExceededError('x'))
    c.getSignatureStatuses
      .mockResolvedValueOnce({
        context: { slot: 1 },
        value: [{ slot: 1, confirmations: null, err: { InstructionError: [2, { Custom: 11 }] }, confirmationStatus: 'confirmed' }],
      })
      .mockResolvedValueOnce({ context: { slot: 1 }, value: [null] })
    const { w } = wallet(ownerKp, 'all')
    const progress = await executeCleanup({ connection, wallet: w, quote, fee, onProgress: () => {} })
    expect(progress.map((p) => p.error)).toEqual([MESSAGES.hasTokens, MESSAGES.expired])
  })

  it('preflight failures are explained (state changed since simulation, dead blockhash)', async () => {
    const { ownerKp, fee, quote } = setup(25)
    const { c, connection } = mockConnection()
    c.sendRawTransaction
      .mockRejectedValueOnce(
        new SendTransactionError({
          action: 'simulate',
          signature: '',
          transactionMessage: 'Transaction simulation failed: Error processing Instruction 2: custom program error: 0xb',
          logs: ['Program log: Error: Non-native account can only be closed if its balance is zero'],
        }),
      )
      .mockRejectedValueOnce(
        new SendTransactionError({ action: 'simulate', signature: '', transactionMessage: 'Transaction simulation failed: Blockhash not found', logs: [] }),
      )
    const { w } = wallet(ownerKp, 'all')
    const progress = await executeCleanup({ connection, wallet: w, quote, fee, onProgress: () => {} })
    expect(progress.map((p) => p.error)).toEqual([MESSAGES.hasTokens, MESSAGES.expired])
    expect(progress.every((p) => p.status === 'failed')).toBe(true)
  })
})

describe('describeSendError', () => {
  const feeWallet = randomKey().toBase58()
  const ctx = { accountKeys: [randomKey().toBase58(), feeWallet], feeWallet }
  it('maps preflight messages', () => {
    const preflight = (m: string) => new SendTransactionError({ action: 'simulate', signature: '', transactionMessage: m, logs: [] })
    expect(describeSendError(preflight('Transaction simulation failed: Attempt to debit an account but found no record of a prior credit.'))).toBe(
      MESSAGES.noSolForFee,
    )
    expect(
      describeSendError(preflight('Transaction simulation failed: Transaction results in an account (1) with insufficient funds for rent'), [], ctx),
    ).toBe(MESSAGES.feeWalletUnfunded)
    expect(
      describeSendError(preflight('Transaction simulation failed: Transaction results in an account (0) with insufficient funds for rent'), [], ctx),
    ).toBe(MESSAGES.rent)
    expect(describeSendError(new Error('Node is behind'))).toBe('Could not send the transaction: Node is behind')
  })
})

// ── Fee wallet funding ──────────────────────────────────────────────────────

const RENT_EXEMPT_MIN_SYSTEM_ACCOUNT = 890_880 // getMinimumBalanceForRentExemption(0)

describe('service fee wallet funding', () => {
  it('why the fee wallet must be pre-funded: holder-rate and small batches stay below the rent-exempt minimum', () => {
    const owner = randomKey().toBase58()
    const accounts = Array.from({ length: 20 }, () => eligibleAccount(owner))
    const holder = buildQuote(accounts, testFeeConfig({ serviceFeeBps: 200 }))
    const standard = buildQuote(accounts.slice(0, 10), testFeeConfig({ serviceFeeBps: 400 }))
    expect(holder.batches[0].serviceFeeLamports).toBe(Math.floor(20 * RENT * 0.02))
    expect(holder.batches[0].serviceFeeLamports).toBeLessThan(RENT_EXEMPT_MIN_SYSTEM_ACCOUNT)
    expect(standard.batches[0].serviceFeeLamports).toBeLessThan(RENT_EXEMPT_MIN_SYSTEM_ACCOUNT)
  })

  it('an unfunded fee wallet (InsufficientFundsForRent on its index) gets a specific message, nothing is signed', async () => {
    const { ownerKp, fee, quote } = setup(5)
    const { c, connection } = mockConnection()
    c.simulateTransaction.mockImplementation(async (tx: VersionedTransaction) => {
      const account_index = tx.message.staticAccountKeys.findIndex((k) => k.toBase58() === fee.feeWallet)
      return { context: { slot: 1 }, value: { err: { InsufficientFundsForRent: { account_index } }, logs: [] } }
    })
    const { w, signAll } = wallet(ownerKp, 'all')
    const progress = await executeCleanup({ connection, wallet: w, quote, fee, onProgress: () => {} })
    expect(progress[0]).toMatchObject({ status: 'failed', error: MESSAGES.feeWalletUnfunded })
    expect(signAll).not.toHaveBeenCalled()
  })
})

// ── Wrapped SOL re-check ────────────────────────────────────────────────────

const NATIVE_MINT = 'So11111111111111111111111111111111111111112'

function liveNative(owner: string, lamports: number, amount = '0', programId = SPL) {
  return {
    executable: false,
    lamports,
    owner: new PublicKey(programId),
    rentEpoch: 0,
    data: {
      program: programId === SPL ? 'spl-token' : 'spl-token-2022',
      space: 165,
      parsed: {
        type: 'account',
        info: {
          isNative: true,
          mint: NATIVE_MINT,
          owner,
          state: 'initialized',
          tokenAmount: { amount, decimals: 9, uiAmount: 0, uiAmountString: '0' },
        },
      },
    },
  }
}

describe('wrapped SOL accounts are re-checked right before sending', () => {
  function nativeSetup() {
    const kp = Keypair.generate()
    const owner = kp.publicKey.toBase58()
    const fee = testFeeConfig()
    const wsol = eligibleAccount(owner, { mint: NATIVE_MINT, isNative: true, decimals: 9 })
    // Batch 0 holds the wSOL account, batch 1 doesn't.
    const quote = buildQuote([wsol, ...Array.from({ length: 24 }, () => eligibleAccount(owner))], fee)
    return { kp, owner, fee, wsol, quote }
  }

  it('wSOL wrapped after the scan → that batch is not sent (CloseAccount would unwrap it); others are', async () => {
    const { kp, owner, fee, wsol, quote } = nativeSetup()
    const { c, connection } = mockConnection()
    c.getMultipleParsedAccounts.mockResolvedValue({ context: { slot: 1 }, value: [liveNative(owner, wsol.lamports + 1_000_000_000, '1000000000')] })
    const { w } = wallet(kp, 'all')
    const progress = await executeCleanup({ connection, wallet: w, quote, fee, onProgress: () => {} })
    expect(c.getMultipleParsedAccounts).toHaveBeenCalledTimes(1)
    expect(c.getMultipleParsedAccounts.mock.calls[0][0].map((k) => k.toBase58())).toEqual([wsol.address])
    expect(progress[0]).toMatchObject({ status: 'failed', error: MESSAGES.nativeChanged })
    expect(progress[1].status).toBe('confirmed')
    expect(c.sendRawTransaction).toHaveBeenCalledTimes(1)
  })

  it('unchanged empty wSOL is closed; non-native batches never trigger the re-check', async () => {
    const { kp, owner, fee, wsol, quote } = nativeSetup()
    const { c, connection } = mockConnection()
    c.getMultipleParsedAccounts.mockResolvedValue({ context: { slot: 1 }, value: [liveNative(owner, wsol.lamports)] })
    const { w } = wallet(kp, 'one')
    const progress = await executeCleanup({ connection, wallet: w, quote, fee, onProgress: () => {} })
    expect(progress.map((p) => p.status)).toEqual(['confirmed', 'confirmed'])
    expect(c.getMultipleParsedAccounts).toHaveBeenCalledTimes(1)
  })

  it('closed since the scan, unsynced lamports, or an RPC failure → not sent (fail closed)', async () => {
    const { kp, owner, fee, wsol, quote } = nativeSetup()
    const { c, connection } = mockConnection()
    const { w } = wallet(kp, 'all')

    c.getMultipleParsedAccounts.mockResolvedValueOnce({ context: { slot: 1 }, value: [null] })
    expect((await executeCleanup({ connection, wallet: w, quote, fee, onProgress: () => {} }))[0].error).toBe(MESSAGES.alreadyClosed)

    c.getMultipleParsedAccounts.mockResolvedValueOnce({ context: { slot: 1 }, value: [liveNative(owner, wsol.lamports + 5)] })
    expect((await executeCleanup({ connection, wallet: w, quote, fee, onProgress: () => {} }))[0].error).toBe(MESSAGES.nativeChanged)

    c.getMultipleParsedAccounts.mockRejectedValueOnce(new Error('fetch failed'))
    const res = await executeCleanup({ connection, wallet: w, quote, fee, onProgress: () => {} })
    expect(res[0]).toMatchObject({ status: 'failed' })
    expect(res[0].error).toMatch(/re-check a wrapped SOL account: fetch failed/)

    // Only the non-native batch was ever sent (once per run).
    expect(c.sendRawTransaction).toHaveBeenCalledTimes(3)
  })
})

// ── Wire level: a REAL web3.js Connection with a stubbed fetch ─────────────

type RpcCall = { method: string; params: unknown[] }

function realConnection(handler: (call: RpcCall) => unknown, calls: RpcCall[]) {
  const fetchStub = async (_url: unknown, init?: { body?: unknown }) => {
    const req = JSON.parse(String(init?.body)) as { id: string; method: string; params: unknown[] }
    calls.push({ method: req.method, params: req.params })
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: handler(req) }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return new Connection('http://127.0.0.1:8899', { commitment: 'confirmed', fetch: fetchStub as unknown as typeof fetch })
}

function signingWallet(kp: Keypair): CleanupWallet {
  return {
    publicKey: kp.publicKey,
    signAllTransactions: (async (txs: VersionedTransaction[]) => {
      txs.forEach((t) => t.sign([kp]))
      return txs
    }) as CleanupWallet['signAllTransactions'],
  }
}

function wireSetup(n: number) {
  const kp = Keypair.generate()
  const owner = kp.publicKey.toBase58()
  const fee = testFeeConfig()
  const accounts = Array.from({ length: n }, (_, i) =>
    eligibleAccount(owner, i % 2 ? { program: 'token-2022', programId: T22, lamports: 2_074_080 } : {}),
  )
  return { kp, fee, quote: buildQuote(accounts, fee) }
}

describe('wire-level behaviour through a real Connection', () => {
  it('simulates the unsigned tx (sigVerify:false, base64, confirmed) and sends a correctly signed tx with preflight', async () => {
    const { kp, fee, quote } = wireSetup(25)
    const bh = randomKey().toBase58()
    const calls: RpcCall[] = []
    let sig = 0
    const conn = realConnection(({ method }) => {
      if (method === 'getLatestBlockhash') return { context: { slot: 10 }, value: { blockhash: bh, lastValidBlockHeight: 1150 } }
      if (method === 'getBlockHeight') return 1000
      if (method === 'simulateTransaction') {
        // Realistic Agave 2.x shape, including fields web3.js doesn't model.
        return {
          context: { slot: 10, apiVersion: '2.2.0' },
          value: {
            err: null,
            logs: ['Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [1]', 'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success'],
            accounts: null,
            unitsConsumed: 61_000,
            returnData: null,
            innerInstructions: null,
            replacementBlockhash: null,
            loadedAccountsDataSize: 400_000,
            fee: 7_440,
          },
        }
      }
      if (method === 'sendTransaction') return `5${'1'.repeat(86)}${++sig}`
      throw new Error(`unexpected ${method}`)
    }, calls)
    const confirm = vi
      .spyOn(conn, 'confirmTransaction')
      .mockResolvedValue({ context: { slot: 11 }, value: { err: null } } as Awaited<ReturnType<Connection['confirmTransaction']>>)

    const progress = await executeCleanup({ connection: conn, wallet: signingWallet(kp), quote, fee, onProgress: () => {} })
    expect(progress.map((p) => p.status)).toEqual(['confirmed', 'confirmed'])

    const sims = calls.filter((c) => c.method === 'simulateTransaction')
    expect(sims).toHaveLength(2)
    for (const s of sims) {
      expect(s.params[1]).toEqual({ sigVerify: false, commitment: 'confirmed', encoding: 'base64' })
      const tx = VersionedTransaction.deserialize(Buffer.from(s.params[0] as string, 'base64'))
      expect(tx.message.recentBlockhash).toBe(bh)
      expect(tx.signatures[0].every((b) => b === 0)).toBe(true) // unsigned, ok with sigVerify:false
    }

    expect(calls.find((c) => c.method === 'getBlockHeight')?.params).toEqual([{ commitment: 'confirmed' }])
    const sends = calls.filter((c) => c.method === 'sendTransaction')
    expect(sends).toHaveLength(2)
    sends.forEach((s, i) => {
      // Preflight on at 'confirmed'; no maxRetries, so the RPC keeps forwarding until the blockhash expires.
      expect(s.params[1]).toEqual({ encoding: 'base64', preflightCommitment: 'confirmed' })
      const tx = VersionedTransaction.deserialize(Buffer.from(s.params[0] as string, 'base64'))
      expect(ed25519Verify(tx.signatures[0], tx.message.serialize(), kp.publicKey.toBytes())).toBe(true)
      expect(() => assertSafeCleanupTransaction(tx, kp.publicKey, quote.batches[i], fee)).not.toThrow()
      expect(tx.serialize().length).toBeLessThanOrEqual(1232)
    })
    expect(confirm.mock.calls[0][0]).toMatchObject({ blockhash: bh, lastValidBlockHeight: 1150 })
  })

  it('parses a realistic NonNativeHasBalance (0xb) simulation failure through web3.js', async () => {
    const { kp, fee, quote } = wireSetup(1)
    const calls: RpcCall[] = []
    const conn = realConnection(({ method }) => {
      if (method === 'getLatestBlockhash') return { context: { slot: 1 }, value: { blockhash: randomKey().toBase58(), lastValidBlockHeight: 200 } }
      return {
        context: { slot: 1 },
        value: {
          err: { InstructionError: [2, { Custom: 11 }] },
          logs: [
            'Program ComputeBudget111111111111111111111111111111 invoke [1]',
            'Program ComputeBudget111111111111111111111111111111 success',
            'Program ComputeBudget111111111111111111111111111111 invoke [1]',
            'Program ComputeBudget111111111111111111111111111111 success',
            'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [1]',
            'Program log: Instruction: CloseAccount',
            'Program log: Error: Non-native account can only be closed if its balance is zero',
            'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA consumed 2826 of 8000 compute units',
            'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA failed: custom program error: 0xb',
          ],
          accounts: null,
          unitsConsumed: 3126,
        },
      }
    }, calls)
    const progress = await executeCleanup({ connection: conn, wallet: signingWallet(kp), quote, fee, onProgress: () => {} })
    expect(progress[0]).toMatchObject({ status: 'failed', error: MESSAGES.hasTokens })
    expect(calls.some((c) => c.method === 'sendTransaction')).toBe(false)
  })

  it('a real preflight rejection from the RPC is explained and the batch is not retried', async () => {
    const { kp, fee, quote } = wireSetup(1)
    const conn = new Connection('http://127.0.0.1:8899', {
      commitment: 'confirmed',
      fetch: (async (_url: unknown, init?: { body?: unknown }) => {
        const req = JSON.parse(String(init?.body)) as { id: string; method: string }
        const ok = (result: unknown) => ({ jsonrpc: '2.0', id: req.id, result })
        const body =
          req.method === 'getLatestBlockhash'
            ? ok({ context: { slot: 1 }, value: { blockhash: randomKey().toBase58(), lastValidBlockHeight: 200 } })
            : req.method === 'getBlockHeight'
              ? ok(10)
              : req.method === 'simulateTransaction'
                ? ok({ context: { slot: 1 }, value: { err: null, logs: [], accounts: null } })
                : {
                    jsonrpc: '2.0',
                    id: req.id,
                    error: {
                      code: -32002,
                      message: 'Transaction simulation failed: Error processing Instruction 2: custom program error: 0xb',
                      data: { err: { InstructionError: [2, { Custom: 11 }] }, logs: ['Program log: Error: Non-native account can only be closed if its balance is zero'], accounts: null },
                    },
                  }
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }) as unknown as typeof fetch,
    })
    const progress = await executeCleanup({ connection: conn, wallet: signingWallet(kp), quote, fee, onProgress: () => {} })
    expect(progress[0]).toMatchObject({ status: 'failed', error: MESSAGES.hasTokens })
    expect(progress[0].signature).toBeUndefined()
  })
})

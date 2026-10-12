// @vitest-environment node
// (buffer-layout's instanceof Uint8Array checks fail across the jsdom realm.)
import { Buffer } from 'buffer'
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
} from '@solana/web3.js'
import { describe, expect, it, vi } from 'vitest'
import {
  MAX_PRIORITY_FEE_MICROLAMPORTS,
  MAX_TRANSACTION_BYTES,
  assertSafeCleanupTransaction,
  buildBatchInstructions,
  buildCleanupTransactions,
  createCloseAccountInstruction,
  withBlockhash,
} from './transactions'
import { CONFIG } from '../../config'
import { buildQuote, networkFeeFor } from './fees'
import { classifyTokenAccount } from './classify'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from './programs'
import type { CleanupBatch, FeeConfig, TokenAccountInfo } from '../types'
import { RENT, SPL, T22, eligibleAccount, rawAccount, randomAddress, randomKey, testFeeConfig } from '../../test/solanaFixtures'

const BLOCKHASH = Keypair.generate().publicKey.toBase58()

function setup(opts: { n?: number; fee?: Partial<FeeConfig>; mixed?: boolean } = {}) {
  const ownerKp = Keypair.generate()
  const owner = ownerKp.publicKey
  const fee = testFeeConfig(opts.fee)
  const accounts: TokenAccountInfo[] = Array.from({ length: opts.n ?? 3 }, (_, i) =>
    eligibleAccount(owner.toBase58(), opts.mixed && i % 2 ? { program: 'token-2022', programId: T22, lamports: 2_157_600 } : {}),
  )
  const quote = buildQuote(accounts, fee)
  const batch = quote.batches[0]
  return { ownerKp, owner, fee, accounts, quote, batch }
}

function compile(payer: PublicKey, ixs: TransactionInstruction[], alts: AddressLookupTableAccount[] = []): VersionedTransaction {
  return new VersionedTransaction(
    new TransactionMessage({ payerKey: payer, recentBlockhash: BLOCKHASH, instructions: ixs }).compileToV0Message(alts),
  )
}

function mockConnection() {
  return {
    getLatestBlockhash: vi.fn(async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1234 })),
  } as unknown as Connection & { getLatestBlockhash: ReturnType<typeof vi.fn> }
}

describe('createCloseAccountInstruction', () => {
  it('encodes CloseAccount', () => {
    const [a, d, o] = [randomKey(), randomKey(), randomKey()]
    const ix = createCloseAccountInstruction(a, d, o, TOKEN_2022_PROGRAM_ID)
    expect(ix.programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true)
    expect([...ix.data]).toEqual([9])
    expect(ix.keys).toEqual([
      { pubkey: a, isSigner: false, isWritable: true },
      { pubkey: d, isSigner: false, isWritable: true },
      { pubkey: o, isSigner: true, isWritable: false },
    ])
  })
})

describe('buildBatchInstructions', () => {
  it('compute budget, one close per account (destination = authority = owner), fee transfer last', () => {
    const { owner, fee, batch } = setup({ n: 3 })
    const ixs = buildBatchInstructions(owner, batch, fee)
    expect(ixs).toHaveLength(2 + 3 + 1)
    expect(ixs[0].programId.equals(ComputeBudgetProgram.programId)).toBe(true)
    expect(ixs[0].data[0]).toBe(2)
    expect(ixs[0].data.readUInt32LE(1)).toBe(batch.computeUnitLimit)
    expect(ixs[1].data[0]).toBe(3)
    expect(ixs[1].data.readBigUInt64LE(1)).toBe(BigInt(fee.priorityFeeMicroLamports))
    batch.accounts.forEach((a, i) => {
      const ix = ixs[2 + i]
      expect(ix.programId.toBase58()).toBe(a.programId)
      expect(ix.keys[0].pubkey.toBase58()).toBe(a.address)
      expect(ix.keys[1].pubkey.equals(owner)).toBe(true)
      expect(ix.keys[2].pubkey.equals(owner)).toBe(true)
      expect(ix.keys[2].isSigner).toBe(true)
    })
    const t = ixs[5]
    expect(t.programId.equals(SystemProgram.programId)).toBe(true)
    expect(t.data.readUInt32LE(0)).toBe(2)
    expect(t.data.readBigUInt64LE(4)).toBe(BigInt(batch.serviceFeeLamports))
    expect(t.keys[0].pubkey.equals(owner)).toBe(true)
    expect(t.keys[1].pubkey.toBase58()).toBe(fee.feeWallet)
  })

  it('omits the price instruction when the priority fee is 0', () => {
    const { owner, fee, batch } = setup({ fee: { priorityFeeMicroLamports: 0 } })
    const ixs = buildBatchInstructions(owner, batch, fee)
    expect(ixs.filter((ix) => ix.programId.equals(ComputeBudgetProgram.programId))).toHaveLength(1)
  })

  it('omits the fee transfer without a fee wallet', () => {
    const { owner, fee, batch } = setup({ fee: { feeWallet: null } })
    expect(batch.serviceFeeLamports).toBe(0)
    const ixs = buildBatchInstructions(owner, batch, fee)
    expect(ixs.some((ix) => ix.programId.equals(SystemProgram.programId))).toBe(false)
  })

  it('uses the right token program per account', () => {
    const { owner, fee, batch } = setup({ n: 4, mixed: true })
    const ixs = buildBatchInstructions(owner, batch, fee).slice(2, 6)
    expect(ixs.map((ix) => ix.programId.toBase58())).toEqual([SPL, T22, SPL, T22])
  })

  it('throws for a non-token program', () => {
    const { owner, fee, batch } = setup({ n: 1 })
    const bad = { ...batch, accounts: [{ ...batch.accounts[0], programId: SystemProgram.programId.toBase58() }] }
    expect(() => buildBatchInstructions(owner, bad, fee)).toThrow(/not a token program/)
  })

  it('throws for a non-eligible account', () => {
    const { owner, fee, batch } = setup({ n: 1 })
    for (const status of ['has-tokens', 'unsupported'] as const) {
      const bad = { ...batch, accounts: [{ ...batch.accounts[0], status }] }
      expect(() => buildBatchInstructions(owner, bad, fee)).toThrow(/not eligible/)
    }
  })

  it('throws for accounts of another owner, with tokens, foreign close authority, or duplicated', () => {
    const { owner, fee, batch } = setup({ n: 1 })
    const a = batch.accounts[0]
    const variants: TokenAccountInfo[][] = [
      [{ ...a, owner: randomAddress() }],
      [{ ...a, amountRaw: '1' }],
      [{ ...a, closeAuthority: randomAddress() }],
      [a, a],
    ]
    for (const accounts of variants) expect(() => buildBatchInstructions(owner, { ...batch, accounts }, fee)).toThrow()
  })

  it('throws when a fee is due but the fee wallet is missing or invalid', () => {
    const { owner, fee, batch } = setup()
    expect(() => buildBatchInstructions(owner, batch, { ...fee, feeWallet: 'not-a-pubkey' })).toThrow(/Fee wallet/)
    expect(() => buildBatchInstructions(owner, batch, { ...fee, feeWallet: null })).toThrow(/no fee wallet/)
  })

  it('throws for an empty batch', () => {
    const { owner, fee, batch } = setup()
    expect(() => buildBatchInstructions(owner, { ...batch, accounts: [] }, fee)).toThrow(/no accounts/)
  })
})

describe('buildCleanupTransactions', () => {
  it('one v0 tx per batch, one blockhash fetch, payer = owner', async () => {
    const { owner, fee, quote } = setup({ n: 45 })
    const connection = mockConnection()
    const built = await buildCleanupTransactions({ connection, owner, quote, fee })
    expect(connection.getLatestBlockhash).toHaveBeenCalledTimes(1)
    expect(connection.getLatestBlockhash).toHaveBeenCalledWith('confirmed')
    expect(built.blockhash).toBe(BLOCKHASH)
    expect(built.lastValidBlockHeight).toBe(1234)
    expect(built.transactions).toHaveLength(3)
    built.transactions.forEach((tx, i) => {
      expect(tx.version).toBe(0)
      expect(tx.message.recentBlockhash).toBe(BLOCKHASH)
      expect(tx.message.staticAccountKeys[0].equals(owner)).toBe(true)
      expect(() => assertSafeCleanupTransaction(tx, owner, quote.batches[i], fee)).not.toThrow()
    })
  })

  it('a full 20-account batch (mixed programs, fee + priority) fits in 1232 bytes', async () => {
    const { owner, fee, quote } = setup({ n: 20, mixed: true })
    expect(quote.batches).toHaveLength(1)
    const { transactions } = await buildCleanupTransactions({ connection: mockConnection(), owner, quote, fee })
    const size = transactions[0].serialize().length
    console.info(`[mopi] 20-close v0 tx (Token + Token-2022, CU limit + price, fee transfer): ${size} bytes`)
    expect(size).toBeLessThanOrEqual(MAX_TRANSACTION_BYTES)
  })

  it('throws when a tx would exceed 1232 bytes', async () => {
    const { owner, fee, quote } = setup({ n: 40, fee: { maxClosesPerTx: 40 } })
    await expect(buildCleanupTransactions({ connection: mockConnection(), owner, quote, fee })).rejects.toThrow(/bytes/)
  })

  it('validates before any RPC call', async () => {
    const { owner, fee, quote } = setup()
    const connection = mockConnection()
    await expect(
      buildCleanupTransactions({ connection, owner, quote, fee: { ...fee, feeWallet: 'nope' } }),
    ).rejects.toThrow()
    expect(connection.getLatestBlockhash).not.toHaveBeenCalled()
  })

  it('refuses an account that appears in two batches, before any RPC call', async () => {
    const { owner, fee } = setup()
    const accounts = Array.from({ length: 20 }, () => eligibleAccount(owner.toBase58()))
    const first = buildQuote(accounts, fee)
    const dup = { ...buildQuote([accounts[5]], fee).batches[0], index: 1 }
    const quote = { ...first, batches: [...first.batches, dup] }
    const connection = mockConnection()
    await expect(buildCleanupTransactions({ connection, owner, quote, fee })).rejects.toThrow(/appears in batch 0 and batch 1/)
    expect(connection.getLatestBlockhash).not.toHaveBeenCalled()
  })
})

describe('withBlockhash', () => {
  it('changes only the blockhash; the result is unsigned and still passes the safety check', async () => {
    const { ownerKp, owner, fee, quote } = setup({ n: 5, mixed: true })
    const { transactions } = await buildCleanupTransactions({ connection: mockConnection(), owner, quote, fee })
    transactions[0].sign([ownerKp])
    const next = randomAddress()
    const out = withBlockhash(transactions[0], next)
    expect(out.message.recentBlockhash).toBe(next)
    expect(out.signatures).toHaveLength(1)
    expect(out.signatures[0].every((b) => b === 0)).toBe(true)
    expect(out.message.staticAccountKeys.map(String)).toEqual(transactions[0].message.staticAccountKeys.map(String))
    const plain = (t: VersionedTransaction) =>
      t.message.compiledInstructions.map((ix) => ({ ...ix, data: Array.from(ix.data), accountKeyIndexes: [...ix.accountKeyIndexes] }))
    expect(plain(out)).toEqual(plain(transactions[0]))
    expect(out.message.header).toEqual(transactions[0].message.header)
    expect(transactions[0].message.recentBlockhash).toBe(BLOCKHASH) // input untouched
    expect(() => assertSafeCleanupTransaction(out, owner, quote.batches[0], fee)).not.toThrow()
  })
})

describe('assertSafeCleanupTransaction', () => {
  const build = (s: ReturnType<typeof setup>) => buildBatchInstructions(s.owner, s.batch, s.fee)
  const expectReject = (s: ReturnType<typeof setup>, tx: VersionedTransaction, re: RegExp, batch: CleanupBatch = s.batch, fee: FeeConfig = s.fee) =>
    expect(() => assertSafeCleanupTransaction(tx, s.owner, batch, fee)).toThrow(re)

  it("accepts the builder's output (with and without fee / priority price)", () => {
    for (const fee of [{}, { feeWallet: null }, { priorityFeeMicroLamports: 0 }]) {
      const s = setup({ n: 5, mixed: true, fee })
      expect(() => assertSafeCleanupTransaction(compile(s.owner, build(s)), s.owner, s.batch, s.fee)).not.toThrow()
    }
  })

  it('accepts a signed tx', () => {
    const s = setup()
    const tx = compile(s.owner, build(s))
    tx.sign([s.ownerKp])
    expect(() => assertSafeCleanupTransaction(tx, s.owner, s.batch, s.fee)).not.toThrow()
  })

  it('rejects an extra instruction for an unknown program', () => {
    const s = setup()
    const memo = new TransactionInstruction({ programId: randomKey(), keys: [], data: Buffer.from('hi') })
    expectReject(s, compile(s.owner, [...build(s), memo]), /not allowed/)
  })

  it('rejects a non-close token instruction (e.g. Transfer)', () => {
    const s = setup()
    const transfer = new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: new PublicKey(s.accounts[0].address), isSigner: false, isWritable: true },
        { pubkey: randomKey(), isSigner: false, isWritable: true },
        { pubkey: s.owner, isSigner: true, isWritable: false },
      ],
      data: Buffer.from([3, 1, 0, 0, 0, 0, 0, 0, 0]),
    })
    expectReject(s, compile(s.owner, [...build(s), transfer]), /not CloseAccount/)
  })

  it('rejects a close with the wrong destination', () => {
    const s = setup()
    const ixs = build(s)
    ixs[2] = createCloseAccountInstruction(new PublicKey(s.accounts[0].address), randomKey(), s.owner, TOKEN_PROGRAM_ID)
    expectReject(s, compile(s.owner, ixs), /destination .* is not the wallet/)
  })

  it('rejects a close with the wrong authority', () => {
    const s = setup()
    const ixs = build(s)
    const close = createCloseAccountInstruction(new PublicKey(s.accounts[0].address), s.owner, randomKey(), TOKEN_PROGRAM_ID)
    close.keys[2].isSigner = false // keep the signer count at 1 to hit the authority check itself
    ixs[2] = close
    expectReject(s, compile(s.owner, ixs), /authority .* is not the wallet/)
  })

  it('rejects a close where the authority is a second signer', () => {
    const s = setup()
    const ixs = build(s)
    ixs[2] = createCloseAccountInstruction(new PublicKey(s.accounts[0].address), s.owner, randomKey(), TOKEN_PROGRAM_ID)
    expectReject(s, compile(s.owner, ixs), /exactly 1 signer/)
  })

  it('rejects a close of an account not in the batch', () => {
    const s = setup()
    const ixs = build(s)
    ixs[2] = createCloseAccountInstruction(randomKey(), s.owner, s.owner, TOKEN_PROGRAM_ID)
    expectReject(s, compile(s.owner, ixs), /not in this batch/)
  })

  it('rejects a duplicate close', () => {
    const s = setup()
    const ixs = build(s)
    ixs.splice(3, 0, ixs[2])
    expectReject(s, compile(s.owner, ixs), /twice/)
  })

  it('rejects a missing close', () => {
    const s = setup()
    const ixs = build(s)
    ixs.splice(2, 1)
    expectReject(s, compile(s.owner, ixs), /expected 3 CloseAccount/)
  })

  it('rejects a close via the wrong token program', () => {
    const s = setup()
    const ixs = build(s)
    ixs[2] = createCloseAccountInstruction(new PublicKey(s.accounts[0].address), s.owner, s.owner, TOKEN_2022_PROGRAM_ID)
    expectReject(s, compile(s.owner, ixs), /wrong token program/)
  })

  it('rejects a close with malformed data or keys', () => {
    const s = setup()
    const ixs = build(s)
    const extraData = createCloseAccountInstruction(new PublicKey(s.accounts[0].address), s.owner, s.owner, TOKEN_PROGRAM_ID)
    extraData.data = Buffer.from([9, 0])
    ixs[2] = extraData
    expectReject(s, compile(s.owner, ixs), /not CloseAccount/)

    const ixs2 = build(s)
    ixs2[2].keys.push({ pubkey: randomKey(), isSigner: false, isWritable: false })
    expectReject(s, compile(s.owner, ixs2), /exactly 3 accounts/)
  })

  it('rejects a wrong fee amount', () => {
    const s = setup()
    const ixs = build(s)
    ixs[ixs.length - 1] = SystemProgram.transfer({
      fromPubkey: s.owner,
      toPubkey: new PublicKey(s.fee.feeWallet!),
      lamports: s.batch.serviceFeeLamports + 1,
    })
    expectReject(s, compile(s.owner, ixs), /fee transfer of \d+ lamports/)
  })

  it('rejects a fee sent to another address', () => {
    const s = setup()
    const ixs = build(s)
    ixs[ixs.length - 1] = SystemProgram.transfer({ fromPubkey: s.owner, toPubkey: randomKey(), lamports: s.batch.serviceFeeLamports })
    expectReject(s, compile(s.owner, ixs), /not the fee wallet/)
  })

  it('rejects a missing fee', () => {
    const s = setup()
    expectReject(s, compile(s.owner, build(s).slice(0, -1)), /fee transfer is missing/)
  })

  it('rejects a fee when none is due', () => {
    const s = setup({ fee: { feeWallet: null } })
    const ixs = [...build(s), SystemProgram.transfer({ fromPubkey: s.owner, toPubkey: randomKey(), lamports: 1000 })]
    expectReject(s, compile(s.owner, ixs), /no service fee is due/)
  })

  it('rejects a second System instruction / non-transfer System instruction', () => {
    const s = setup()
    const ixs = build(s)
    const dup = [...ixs, ixs[ixs.length - 1]]
    expectReject(s, compile(s.owner, dup), /more than one System/)
    const assign = SystemProgram.assign({ accountPubkey: s.owner, programId: randomKey() })
    expectReject(s, compile(s.owner, [...ixs.slice(0, -1), assign]), /not Transfer/)
  })

  it('rejects a second signer', () => {
    const s = setup()
    const other = randomKey()
    const ixs = [...build(s)]
    // An instruction that requires another signature (and is not an allowed shape).
    ixs.push(SystemProgram.transfer({ fromPubkey: other, toPubkey: s.owner, lamports: 1 }))
    expectReject(s, compile(s.owner, ixs), /exactly 1 signer/)
  })

  it('rejects a payer other than the owner', () => {
    const s = setup()
    expectReject(s, compile(randomKey(), build(s)), /fee payer is not the wallet/)
  })

  it('rejects other ComputeBudget instruction types', () => {
    const s = setup()
    const heap = ComputeBudgetProgram.requestHeapFrame({ bytes: 32 * 1024 })
    expectReject(s, compile(s.owner, [...build(s), heap]), /ComputeBudget instruction type 1/)
  })

  it('rejects duplicate or inflated ComputeBudget instructions', () => {
    const s = setup()
    const ixs = build(s)
    expectReject(s, compile(s.owner, [ixs[0], ...ixs]), /duplicate SetComputeUnitLimit/)
    expectReject(s, compile(s.owner, [ixs[1], ...ixs]), /duplicate SetComputeUnitPrice/)
    const bigPrice = [...ixs]
    bigPrice[1] = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: s.fee.priorityFeeMicroLamports + 1 })
    expectReject(s, compile(s.owner, bigPrice), /compute unit price/)
    const bigLimit = [...ixs]
    bigLimit[0] = ComputeBudgetProgram.setComputeUnitLimit({ units: s.batch.computeUnitLimit + 1 })
    expectReject(s, compile(s.owner, bigLimit), /compute unit limit/)
    // A price without a limit could be multiplied by the default CU budget.
    expectReject(s, compile(s.owner, ixs.slice(1)), /without a compute unit limit/)
  })

  it('rejects address lookup tables', () => {
    const s = setup()
    const alt = new AddressLookupTableAccount({
      key: randomKey(),
      state: {
        deactivationSlot: BigInt('18446744073709551615'),
        lastExtendedSlot: 0,
        lastExtendedSlotStartIndex: 0,
        addresses: [new PublicKey(s.fee.feeWallet!)],
      },
    })
    const tx = compile(s.owner, build(s), [alt])
    expect(tx.message.addressTableLookups.length).toBe(1)
    expectReject(s, tx, /lookup tables/)
  })

  it('rejects a batch whose fee does not match the fee config', () => {
    const s = setup()
    const inflated = { ...s.batch, serviceFeeLamports: s.batch.serviceFeeLamports * 2 }
    const ixs = buildBatchInstructions(s.owner, inflated, s.fee)
    expectReject(s, compile(s.owner, ixs), /computed from the fee config/, inflated)
  })

  it('rejects a batch whose reclaim total does not match its accounts', () => {
    const s = setup()
    expectReject(s, compile(s.owner, build(s)), /sum of accounts/, { ...s.batch, reclaimLamports: s.batch.reclaimLamports + 1 })
  })

  it('rejects when a fee is due but the configured fee wallet is invalid', () => {
    const s = setup()
    expectReject(s, compile(s.owner, build(s)), /fee wallet is not a valid public key/, s.batch, { ...s.fee, feeWallet: 'demo-fee-wallet' })
  })

  it('rejects a batch whose compute unit limit or network fee does not match the fee config', () => {
    const s = setup({ n: 1 })
    // Tampered/buggy batch: 1.4M CU while networkFeeLamports still shows the 8,000-CU estimate.
    const bigCu = { ...s.batch, computeUnitLimit: 1_400_000 }
    expect(networkFeeFor(bigCu.computeUnitLimit, s.fee)).toBeGreaterThan(bigCu.networkFeeLamports)
    expectReject(s, compile(s.owner, buildBatchInstructions(s.owner, bigCu, s.fee)), /compute unit limit 1400000 != 8000/, bigCu)
    const wrongFee = { ...s.batch, networkFeeLamports: s.batch.networkFeeLamports + 1 }
    expectReject(s, compile(s.owner, build(s)), /network fee/, wrongFee)
  })

  it('rejects a service fee rate outside 0–10%', () => {
    const s = setup({ n: 1, fee: { serviceFeeBps: 1_001 } })
    expectReject(s, compile(s.owner, build(s)), /outside 0–1000/)
    const t = setup({ n: 1, fee: { serviceFeeBps: 12.5 } })
    expectReject(t, compile(t.owner, build(t)), /outside 0–1000/)
  })
})

describe('fee basis: the service fee is bounded by what the closes can really return', () => {
  it('an RPC that inflates lamports of plain SPL accounts cannot make the fee exceed the real reclaim', async () => {
    const kp = Keypair.generate()
    const owner = kp.publicKey.toBase58()
    const fee = testFeeConfig({ serviceFeeBps: 400 })
    // A 165-byte non-native SPL token account holds its rent deposit (2,039,280) unless someone
    // donated SOL to it; the RPC claims 1 SOL each.
    const accounts = Array.from({ length: 20 }, () =>
      classifyTokenAccount(rawAccount(owner, {}, { lamports: 1_000_000_000 }), owner),
    )
    expect(accounts.every((a) => a.status === 'eligible')).toBe(true)
    const quote = buildQuote(accounts, fee)
    const { transactions } = await buildCleanupTransactions({ connection: mockConnection(), owner: kp.publicKey, quote, fee })
    expect(() => assertSafeCleanupTransaction(transactions[0], kp.publicKey, quote.batches[0], fee)).not.toThrow()

    const realReclaim = 20 * RENT // what CloseAccount actually returns on-chain
    expect(quote.serviceFeeLamports).toBe(Math.floor((realReclaim * 400) / 10_000))
    expect(quote.serviceFeeLamports).toBeLessThanOrEqual(realReclaim)
  })

  it('a batch charging the fee on raw (uncapped) lamports is rejected', () => {
    const s = setup({ n: 1 })
    const accounts = [{ ...s.accounts[0], lamports: 1_000_000_000 }]
    const batch = { ...s.batch, accounts, reclaimLamports: 1_000_000_000, serviceFeeLamports: 40_000_000 }
    const tx = compile(s.owner, buildBatchInstructions(s.owner, batch, s.fee))
    expect(() => assertSafeCleanupTransaction(tx, s.owner, batch, s.fee)).toThrow(/computed from the fee config/)
  })
})

describe('absolute priority fee ceiling (defense in depth)', () => {
  it('matches the deployment cap, and a fee config priced above it is refused even though the tx matches the quote', () => {
    expect(CONFIG.maxPriorityFeeMicroLamports).toBeLessThanOrEqual(MAX_PRIORITY_FEE_MICROLAMPORTS)

    const owner = Keypair.generate().publicKey
    const compile = (fee: ReturnType<typeof testFeeConfig>) => {
      const batch = buildQuote([eligibleAccount(owner.toBase58())], fee).batches[0]
      const msg = new TransactionMessage({
        payerKey: owner,
        recentBlockhash: Keypair.generate().publicKey.toBase58(),
        instructions: buildBatchInstructions(owner, batch, fee),
      }).compileToV0Message()
      return { tx: new VersionedTransaction(msg), batch }
    }

    // At the cap: accepted, and the worst-case priority fee stays tiny next to one account's reclaim.
    const atCap = testFeeConfig({ priorityFeeMicroLamports: MAX_PRIORITY_FEE_MICROLAMPORTS })
    const ok = compile(atCap)
    expect(() => assertSafeCleanupTransaction(ok.tx, owner, ok.batch, atCap)).not.toThrow()
    expect(ok.batch.networkFeeLamports).toBe(networkFeeFor(ok.batch.computeUnitLimit, atCap))
    expect(ok.batch.networkFeeLamports / ok.batch.reclaimLamports).toBeLessThan(0.01)

    // A config that escaped the estimate's clamp (a future caller bug): 1000× the cap
    // would pay more in priority fees than the close reclaims. Refused.
    const escaped = testFeeConfig({ priorityFeeMicroLamports: MAX_PRIORITY_FEE_MICROLAMPORTS * 1000 })
    const bad = compile(escaped)
    expect(bad.batch.networkFeeLamports).toBeGreaterThan(bad.batch.reclaimLamports)
    expect(() => assertSafeCleanupTransaction(bad.tx, owner, bad.batch, escaped)).toThrow(/priority fee/)
    for (const v of [Number.NaN, -1, Infinity]) {
      expect(() => assertSafeCleanupTransaction(ok.tx, owner, ok.batch, { ...atCap, priorityFeeMicroLamports: v })).toThrow()
    }
  })
})


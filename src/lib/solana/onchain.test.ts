// @vitest-environment node
// ON-CHAIN TRUTH: mopi's real code paths (scanWallet → buildQuote →
// executeCleanup) against LiteSVM — the actual SVM running the actual SPL
// Token, Token-2022, ATA and System programs — reached through a genuine
// web3.js Connection whose transport is the in-process chain
// (src/test/litesvm). Every account below is created with real instructions,
// every signature is a real ed25519 signature, and every balance change is
// what the runtime really did.
import { Buffer } from 'buffer'
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, VersionedTransaction } from '@solana/web3.js'
import { ExtensionType } from '@solana/spl-token'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONFIG } from '../../config'
import {
  LiteSvmChain,
  RpcFailure,
  TokenFactory,
  createLiteSvmConnection,
  createLiteSvmFetch,
  keypairWallet,
  signatureOf,
  type KeypairWallet,
  type MintRef,
} from '../../test/litesvm'
import type { BatchProgress, CleanupQuote, FeeConfig, ScanResult, TokenAccountInfo } from '../types'
import { MESSAGES, executeCleanup } from './execute'
import { buildQuote, defaultFeeConfig } from './fees'
import { checkHolderStatus } from './holder'
import { estimatePriorityFee } from './priority'
import { createFailoverFetch } from './rpc'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from './programs'
import { scanWallet } from './scan'
import { MAX_TRANSACTION_BYTES, assertSafeCleanupTransaction } from './transactions'

const TIMEOUT = 30_000

interface Ctx {
  chain: LiteSvmChain
  tokens: TokenFactory
  connection: Connection
  owner: Keypair
}

function setup(ownerLamports = 2 * LAMPORTS_PER_SOL): Ctx {
  const chain = new LiteSvmChain()
  const tokens = new TokenFactory(chain)
  const owner = Keypair.generate()
  if (ownerLamports > 0) chain.airdrop(owner.publicKey, ownerLamports)
  return { chain, tokens, connection: createLiteSvmConnection(chain), owner }
}

/** The app's fee config, with a fee wallet and the standard rate (CONFIG has no fee wallet in tests). */
function feeConfig(feeWallet: PublicKey | null, over: Partial<FeeConfig> = {}): FeeConfig {
  return {
    ...defaultFeeConfig(false),
    serviceFeeBps: feeWallet ? CONFIG.serviceFeeBps : 0,
    feeWallet: feeWallet?.toBase58() ?? null,
    ...over,
  }
}

const scan = (ctx: Ctx): Promise<ScanResult> => scanWallet(ctx.connection, ctx.owner.publicKey, { cluster: 'mainnet-beta' })

async function run(ctx: Ctx, quote: CleanupQuote, fee: FeeConfig, wallet: KeypairWallet): Promise<BatchProgress[]> {
  return executeCleanup({ connection: ctx.connection, wallet, quote, fee, onProgress: () => {} })
}

/** Raw on-chain state of an account (lamports + data), for "untouched" checks. */
function snapshot(chain: LiteSvmChain, address: string): string {
  const info = chain.account(address)
  return info ? `${info.lamports}:${info.owner.toBase58()}:${Buffer.from(info.data).toString('hex')}` : 'closed'
}

function byAddress(result: ScanResult): Map<string, TokenAccountInfo> {
  return new Map(result.accounts.map((a) => [a.address, a]))
}

/** Lamports actually charged by the runtime for the given landed signatures. */
function feesCharged(chain: LiteSvmChain, signatures: string[]): number {
  return signatures.reduce((sum, s) => {
    const record = chain.record(s)
    if (!record) throw new Error(`no on-chain record for ${s}`)
    return sum + record.fee
  }, 0)
}

/** Compute units each top-level CloseAccount consumed, read from the program logs. */
function closeUnits(logs: readonly string[]): { program: 'spl-token' | 'token-2022'; units: number }[] {
  const out: { program: 'spl-token' | 'token-2022'; units: number }[] = []
  const spl = TOKEN_PROGRAM_ID.toBase58()
  const t22 = TOKEN_2022_PROGRAM_ID.toBase58()
  for (const line of logs) {
    const m = /^Program (\w+) consumed (\d+) of \d+ compute units$/.exec(line)
    if (!m) continue
    if (m[1] === spl) out.push({ program: 'spl-token', units: Number(m[2]) })
    else if (m[1] === t22) out.push({ program: 'token-2022', units: Number(m[2]) })
  }
  return out
}

describe('mixed wallet: scan → quote → cleanup on real programs', () => {
  it(
    'classifies every account like the chain behaves, closes exactly the eligible ones, and moves exactly the quoted lamports',
    async () => {
      const ctx = setup()
      const { chain, tokens, owner } = ctx
      const o = owner.publicKey
      const feeWallet = chain.fundedKeypair(LAMPORTS_PER_SOL).publicKey
      const other = Keypair.generate().publicKey

      const expected = new Map<string, { status: TokenAccountInfo['status']; reason?: string; label: string }>()
      const expect_ = (address: PublicKey, status: TokenAccountInfo['status'], label: string, reason?: string) =>
        expected.set(address.toBase58(), { status, reason, label })

      // SPL Token: 12 empty ATAs of distinct mints.
      for (let k = 0; k < 12; k++) expect_(tokens.createAta(o, tokens.createMint()), 'eligible', `empty SPL #${k}`)
      // SPL Token with a balance.
      for (let k = 0; k < 2; k++) {
        const mint = tokens.createMint({ decimals: 9 })
        const ata = tokens.createAta(o, mint)
        tokens.mintTo(mint, ata, 1_500_000_000n * BigInt(k + 1))
        expect_(ata, 'has-tokens', `SPL with balance #${k}`)
      }
      // Frozen, empty.
      const freezable = tokens.createMint({ freezable: true })
      const frozen = tokens.createAta(o, freezable)
      tokens.freeze(freezable, frozen)
      expect_(frozen, 'unsupported', 'frozen empty', 'frozen')
      // Close authority handed to someone else / to the owner itself.
      const caMint = tokens.createMint()
      const closeAuthOther = tokens.createAta(o, caMint)
      tokens.setCloseAuthority(caMint, closeAuthOther, owner, other)
      expect_(closeAuthOther, 'unsupported', 'close authority = other', 'close-authority')
      const caSelf = tokens.createAccount(o, caMint)
      tokens.setCloseAuthority(caMint, caSelf, owner, o)
      expect_(caSelf, 'eligible', 'close authority = owner')
      // A stale zero-amount approval (delegate set).
      const delegated = tokens.createAccount(o, caMint)
      tokens.approve(caMint, delegated, owner, other, 0n)
      expect_(delegated, 'eligible', 'empty with delegate')
      // Wrapped SOL: an empty wSOL account, and the wSOL ATA funded via SyncNative.
      expect_(tokens.createEmptyWsol(o), 'eligible', 'empty wSOL')
      expect_(tokens.wrapSol(owner, 25_000_000), 'has-tokens', 'wSOL with balance')

      // Token-2022.
      const t22 = tokens.createMint({ program: 'token-2022' })
      expect_(tokens.createAta(o, t22), 'eligible', 'T22 ATA (immutableOwner)')
      expect_(
        tokens.createAccount(owner, t22, { immutableOwner: true, memoTransfer: true, cpiGuard: true }),
        'eligible',
        'T22 immutableOwner + memoTransfer + cpiGuard',
      )
      const feeMint = tokens.createMint({ program: 'token-2022', transferFee: { basisPoints: 100, maximumFee: 1_000_000n } })
      const feeSource = tokens.createAta(tokens.payer.publicKey, feeMint)
      tokens.mintTo(feeMint, feeSource, 1_000_000n)
      const withheld = tokens.createAta(o, feeMint)
      tokens.transferWithFee(feeMint, feeSource, withheld, tokens.payer, 10_000n, 100n)
      tokens.burn(feeMint, withheld, owner, 9_900n) // balance 0, 100 withheld
      expect_(withheld, 'unsupported', 'T22 empty with withheld fees', 'withheld-fees')
      expect_(tokens.createAccount(o, feeMint, { immutableOwner: true }), 'eligible', 'T22 transferFeeAmount, nothing withheld')
      const nonTransferable = tokens.createMint({ program: 'token-2022', nonTransferable: true })
      expect_(tokens.createAta(o, nonTransferable), 'eligible', 'T22 non-transferable')
      const hook = tokens.createMint({ program: 'token-2022', transferHook: Keypair.generate().publicKey })
      expect_(tokens.createAta(o, hook), 'eligible', 'T22 transfer hook account')
      const pausable = tokens.createMint({ program: 'token-2022', pausable: true })
      expect_(tokens.createAta(o, pausable), 'eligible', 'T22 pausable account')

      // ── Scan ──────────────────────────────────────────────────────────────
      const result = await scan(ctx)
      const seen = byAddress(result)
      expect([...seen.keys()].sort()).toEqual([...expected.keys()].sort())
      for (const [address, want] of expected) {
        const got = seen.get(address)!
        expect({ label: want.label, status: got.status, reason: got.reason }).toEqual({
          label: want.label,
          status: want.status,
          reason: want.reason,
        })
        // The scan reports the account SOL the chain really holds.
        expect(got.lamports, want.label).toBe(chain.balance(address))
      }
      const eligible = result.eligible
      expect(eligible).toHaveLength([...expected.values()].filter((e) => e.status === 'eligible').length)

      // ── Quote, with a priority fee estimated from (real-shaped) recent fees ──
      chain.prioritizationFees = [0, 50_000, 120_000, 80_000].map((prioritizationFee, k) => ({ slot: chain.slot - k, prioritizationFee }))
      const price = await estimatePriorityFee(ctx.connection, [o, ...eligible.map((a) => a.address)])
      expect(price).toBe(120_000)
      const fee = feeConfig(feeWallet, { priorityFeeMicroLamports: price })
      const quote = buildQuote(eligible, fee)
      expect(quote.batches.map((b) => b.accounts.length)).toEqual([20, eligible.length - 20])
      expect(quote.reclaimLamports).toBe(eligible.reduce((s, a) => s + chain.balance(a.address), 0))
      expect(quote.serviceFeeLamports).toBeGreaterThan(0)

      const skipped = [...expected.keys()].filter((a) => expected.get(a)!.status !== 'eligible')
      const before = new Map(skipped.map((a) => [a, snapshot(chain, a)]))
      const ownerBefore = chain.balance(o)
      const feeWalletBefore = chain.balance(feeWallet)

      // ── Execute ───────────────────────────────────────────────────────────
      const wallet = keypairWallet(owner)
      const progress = await run(ctx, quote, fee, wallet)
      expect(progress.map((p) => [p.status, p.error])).toEqual(quote.batches.map(() => ['confirmed', undefined]))
      expect(wallet.prompts).toBe(1)

      // Every eligible account is gone; every skipped one is byte-for-byte untouched.
      for (const a of eligible) expect(chain.exists(a.address), expected.get(a.address)!.label).toBe(false)
      for (const a of skipped) expect(snapshot(chain, a), expected.get(a)!.label).toBe(before.get(a))

      // Money: the runtime charged exactly the quoted network fee, the fee
      // wallet got exactly the quoted service fee, and the owner got the rest.
      const signatures = progress.map((p) => p.signature!)
      const charged = feesCharged(chain, signatures)
      expect(charged).toBe(quote.networkFeeLamports)
      expect(chain.balance(feeWallet) - feeWalletBefore).toBe(quote.serviceFeeLamports)
      expect(chain.balance(o) - ownerBefore).toBe(quote.reclaimLamports - quote.serviceFeeLamports - charged)
      expect(chain.balance(o) - ownerBefore).toBe(quote.netLamports)

      // What landed is exactly what the wallet signed, and each passes the allowlist.
      const executed = chain.sends.filter((s) => s.executed)
      expect(executed.map((s) => s.signature)).toEqual(signatures)
      executed.forEach((s, k) => {
        expect(Buffer.from(s.bytes).equals(Buffer.from(wallet.signed[k].serialize()))).toBe(true)
        expect(() => assertSafeCleanupTransaction(VersionedTransaction.deserialize(s.bytes), o, quote.batches[k], fee)).not.toThrow()
      })

      // A rescan sees only what was skipped.
      const after = await scan(ctx)
      expect(after.eligible).toEqual([])
      expect(after.accounts.map((a) => a.address).sort()).toEqual([...skipped].sort())
    },
    TIMEOUT,
  )
})

describe('on-chain truth of the Token-2022 allowlist', () => {
  it(
    'every allowlisted account extension really closes when empty; withheld fees really block the close',
    async () => {
      const ctx = setup()
      const { chain, tokens, owner } = ctx
      const o = owner.publicKey
      const t22 = (opts: Parameters<TokenFactory['createMint']>[0] = {}) => tokens.createMint({ program: 'token-2022', ...opts })

      const cases: Array<{ extension: string; address: PublicKey }> = [
        { extension: 'immutableOwner', address: tokens.createAccount(o, t22(), { immutableOwner: true }) },
        {
          extension: 'transferFeeAmount',
          address: tokens.createAccount(o, t22({ transferFee: { basisPoints: 50, maximumFee: 10n } })),
        },
        { extension: 'memoTransfer', address: tokens.createAccount(owner, t22(), { memoTransfer: true }) },
        { extension: 'cpiGuard', address: tokens.createAccount(owner, t22(), { cpiGuard: true }) },
        {
          // Token-2022 requires ImmutableOwner on non-transferable accounts.
          extension: 'nonTransferableAccount',
          address: tokens.createAccount(o, t22({ nonTransferable: true }), { immutableOwner: true }),
        },
        { extension: 'transferHookAccount', address: tokens.createAccount(o, t22({ transferHook: Keypair.generate().publicKey })) },
        { extension: 'pausableAccount', address: tokens.createAccount(o, t22({ pausable: true })) },
      ]

      // Withheld fees: receive with a fee, burn the balance, keep the withheld amount.
      const feeMint = t22({ transferFee: { basisPoints: 100, maximumFee: 1_000n } })
      const source = tokens.createAta(tokens.payer.publicKey, feeMint)
      tokens.mintTo(feeMint, source, 100_000n)
      const withheld = tokens.createAta(o, feeMint)
      tokens.transferWithFee(feeMint, source, withheld, tokens.payer, 10_000n, 100n)
      tokens.burn(feeMint, withheld, owner, 9_900n)

      const seen = byAddress(await scan(ctx))
      // The allowlist covers every account extension the cases exercise…
      for (const c of cases) {
        const info = seen.get(c.address.toBase58())!
        expect(info.extensions, c.extension).toContain(c.extension)
        expect([c.extension, info.status]).toEqual([c.extension, 'eligible'])
      }
      // …and the withheld-fee account is refused.
      expect(seen.get(withheld.toBase58())).toMatchObject({ status: 'unsupported', reason: 'withheld-fees' })

      // On-chain: each eligible one really closes with a top-level owner-signed CloseAccount.
      for (const c of cases) {
        const lamports = chain.balance(c.address)
        const ownerBefore = chain.balance(o)
        const out = tokens.tryClose(c.address, owner, TOKEN_2022_PROGRAM_ID)
        expect([c.extension, out.err]).toEqual([c.extension, null])
        expect(chain.exists(c.address)).toBe(false)
        // The fee payer is the factory, so the owner receives the full deposit.
        expect(chain.balance(o) - ownerBefore).toBe(lamports)
      }

      // The withheld-fee account really cannot close: Token-2022 error 0x23 (TokenError::AccountHasWithheldTransferFees).
      const blocked = tokens.tryClose(withheld, owner, TOKEN_2022_PROGRAM_ID)
      expect(blocked.err).toEqual({ InstructionError: [1, { Custom: 0x23 }] })
      expect(blocked.logs.join('\n')).toMatch(/withheld/i)
      expect(chain.exists(withheld)).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'informational: an empty FROZEN account CAN be closed by its owner on-chain (SPL Token and Token-2022); mopi still skips it',
    async () => {
      const ctx = setup()
      const { chain, tokens, owner } = ctx
      const frozen: Record<string, PublicKey> = {}
      for (const program of ['spl-token', 'token-2022'] as const) {
        const mint = tokens.createMint({ program, freezable: true })
        const account = tokens.createAta(owner.publicKey, mint)
        tokens.freeze(mint, account)
        frozen[program] = account
      }
      // mopi's classification: frozen → unsupported (conservative).
      const seen = byAddress(await scan(ctx))
      for (const account of Object.values(frozen)) {
        expect(seen.get(account.toBase58())).toMatchObject({ state: 'frozen', status: 'unsupported', reason: 'frozen' })
      }
      // The chain's behaviour: neither program checks the frozen state in
      // CloseAccount for an empty account, so the owner's close succeeds.
      const outcomes: Record<string, unknown> = {}
      for (const [program, account] of Object.entries(frozen)) {
        const deposit = chain.balance(account)
        const ownerBefore = chain.balance(owner.publicKey)
        const out = tokens.tryClose(account, owner, program === 'spl-token' ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID)
        outcomes[program] = out.err
        expect(chain.exists(account)).toBe(false)
        expect(chain.balance(owner.publicKey) - ownerBefore).toBe(deposit)
      }
      expect(outcomes).toEqual({ 'spl-token': null, 'token-2022': null })
    },
    TIMEOUT,
  )
})

describe('batching and compute budget on real programs', () => {
  it(
    '45 eligible accounts → 3 transactions that all land, each ≤ 1232 bytes, within the quoted compute limits',
    async () => {
      const ctx = setup()
      const { chain, tokens, owner } = ctx
      const o = owner.publicKey
      const feeWallet = chain.fundedKeypair(LAMPORTS_PER_SOL).publicKey

      // 20 of the heaviest Token-2022 accounts mopi accepts (6 allowlisted extensions, 201 bytes)…
      const heavy = tokens.createMint({
        program: 'token-2022',
        transferFee: { basisPoints: 25, maximumFee: 5_000n },
        transferHook: Keypair.generate().publicKey,
        pausable: true,
      })
      const heavyAccounts = Array.from({ length: 20 }, () =>
        tokens.createAccount(owner, heavy, {
          immutableOwner: true,
          memoTransfer: true,
          cpiGuard: true,
          extra: [ExtensionType.TransferFeeAmount, ExtensionType.TransferHookAccount, ExtensionType.PausableAccount],
        }),
      )
      // …and 25 SPL Token accounts.
      const spl = tokens.createMint()
      const splAccounts = Array.from({ length: 25 }, () => tokens.createAccount(o, spl))

      const result = await scan(ctx)
      expect(result.eligible).toHaveLength(45)
      expect(result.eligible.filter((a) => a.program === 'token-2022').every((a) => a.extensions.length === 6)).toBe(true)
      const fee = feeConfig(feeWallet)
      const quote = buildQuote(result.eligible, fee)
      expect(quote.batches.map((b) => b.accounts.length)).toEqual([20, 20, 5])
      // Higher deposits sort first: batch 0 is the full Token-2022 batch.
      expect(quote.batches[0].accounts.every((a) => a.program === 'token-2022')).toBe(true)

      const ownerBefore = chain.balance(o)
      const progress = await run(ctx, quote, fee, keypairWallet(owner))
      expect(progress.map((p) => p.status)).toEqual(['confirmed', 'confirmed', 'confirmed'])
      for (const a of [...heavyAccounts, ...splAccounts]) expect(chain.exists(a)).toBe(false)
      const charged = feesCharged(chain, progress.map((p) => p.signature!))
      expect(charged).toBe(quote.networkFeeLamports)
      expect(chain.balance(o) - ownerBefore).toBe(quote.netLamports)

      // Size: every sent transaction fits.
      const sizes = chain.sends.map((s) => s.bytes.length)
      expect(sizes).toHaveLength(3)
      for (const size of sizes) expect(size).toBeLessThanOrEqual(MAX_TRANSACTION_BYTES)

      // Compute: per-close cost from the simulations mopi ran, against the budget.
      expect(chain.simulations).toHaveLength(3)
      const closes = chain.simulations.flatMap((s) => closeUnits(s.logs))
      expect(closes).toHaveLength(45)
      const maxOf = (program: string) => Math.max(...closes.filter((c) => c.program === program).map((c) => c.units))
      const splMax = maxOf('spl-token')
      const t22Max = maxOf('token-2022')
      expect(CONFIG.computeUnitsPerClose).toBeGreaterThanOrEqual(1.5 * splMax)
      expect(CONFIG.computeUnitsPerClose).toBeGreaterThanOrEqual(1.5 * t22Max)
      // The full 20-close Token-2022 batch fits its own limit (whole transaction, compute budget + fee transfer included).
      const t22Batch = chain.simulations[0]
      expect(t22Batch.unitsConsumed).toBeLessThanOrEqual(quote.batches[0].computeUnitLimit)
      chain.history().slice(-3).forEach((record, k) => {
        expect(record.unitsConsumed).toBeLessThanOrEqual(quote.batches[k].computeUnitLimit)
      })

      // Note: LiteSVM 0.8.0 bundles the p-token (pinocchio) build of SPL Token
      // (no "Instruction: CloseAccount" log, ~120 CU); the classic SPL Token
      // program's CloseAccount costs roughly 3k CU, still ≥ 1.5× under budget.
      console.info(
        `[onchain] CU per close: SPL Token (p-token build) max ${splMax}, Token-2022 (6 extensions) max ${t22Max}; ` +
          `budget ${CONFIG.computeUnitsPerClose}/close (${(CONFIG.computeUnitsPerClose / t22Max).toFixed(1)}× T22 headroom); ` +
          `20-close T22 batch ${t22Batch.unitsConsumed} of ${quote.batches[0].computeUnitLimit} CU; ` +
          `tx sizes ${sizes.join(', ')} bytes`,
      )
    },
    TIMEOUT,
  )
})

describe('failure paths on real programs', () => {
  /** n empty SPL accounts for ctx.owner (one mint, distinct accounts). */
  function emptyAccounts(ctx: Ctx, n: number): { mint: MintRef; accounts: PublicKey[] } {
    const mint = ctx.tokens.createMint()
    return { mint, accounts: Array.from({ length: n }, () => ctx.tokens.createAccount(ctx.owner.publicKey, mint)) }
  }

  it(
    'unfunded fee wallet: the small fee transfer fails simulation, the batch says so, and nothing is signed or sent',
    async () => {
      const ctx = setup()
      const { chain, owner } = ctx
      const { accounts } = emptyAccounts(ctx, 2)
      const feeWallet = Keypair.generate().publicKey // never funded: 0 lamports
      const fee = feeConfig(feeWallet)
      const quote = buildQuote((await scan(ctx)).eligible, fee)
      expect(quote.serviceFeeLamports).toBeGreaterThan(0)
      expect(quote.serviceFeeLamports).toBeLessThan(chain.rentExempt(0)) // 163,142 < 890,880

      const before = accounts.map((a) => snapshot(chain, a.toBase58()))
      const ownerBefore = chain.balance(owner.publicKey)
      const wallet = keypairWallet(owner)
      const progress = await run(ctx, quote, fee, wallet)
      expect(progress).toMatchObject([{ status: 'failed', error: MESSAGES.feeWalletUnfunded }])
      expect(wallet.prompts).toBe(0)
      expect(chain.sends).toEqual([])
      expect(accounts.map((a) => snapshot(chain, a.toBase58()))).toEqual(before)
      expect(chain.balance(owner.publicKey)).toBe(ownerBefore)
      expect(chain.balance(feeWallet)).toBe(0)
      // The runtime really rejects it as rent: the fee wallet's index in the transaction.
      expect(chain.simulations[0].err).toMatchObject({ InsufficientFundsForRent: { account_index: expect.any(Number) } })
    },
    TIMEOUT,
  )

  it(
    'tokens arrive between scan and execute: that batch fails simulation ("received tokens"), the other batch still lands',
    async () => {
      const ctx = setup()
      const { chain, tokens, owner } = ctx
      const { mint, accounts } = emptyAccounts(ctx, 25)
      const feeWallet = chain.fundedKeypair(LAMPORTS_PER_SOL).publicKey
      const fee = feeConfig(feeWallet)
      const quote = buildQuote((await scan(ctx)).eligible, fee)
      expect(quote.batches.map((b) => b.accounts.length)).toEqual([20, 5])

      // After the scan, someone sends tokens to an account in the second batch.
      const victim = new PublicKey(quote.batches[1].accounts[2].address)
      tokens.mintTo(mint, victim, 42n)

      const wallet = keypairWallet(owner)
      const progress = await run(ctx, quote, fee, wallet)
      expect(progress[0].status).toBe('confirmed')
      expect(progress[1]).toMatchObject({ status: 'failed', error: MESSAGES.hasTokens })
      expect(wallet.signed).toHaveLength(1)
      expect(chain.sends).toHaveLength(1)
      for (const a of quote.batches[0].accounts) expect(chain.exists(a.address)).toBe(false)
      for (const a of quote.batches[1].accounts) expect(chain.exists(a.address)).toBe(true)
      expect(accounts.filter((a) => chain.exists(a))).toHaveLength(5)
    },
    TIMEOUT,
  )

  it(
    'tokens arrive while the wallet prompt is open: preflight rejects the signed bytes with the "received tokens" message',
    async () => {
      const ctx = setup()
      const { chain, tokens, owner } = ctx
      const { mint, accounts } = emptyAccounts(ctx, 3)
      const fee = feeConfig(chain.fundedKeypair(LAMPORTS_PER_SOL).publicKey)
      const quote = buildQuote((await scan(ctx)).eligible, fee)
      const ownerBefore = chain.balance(owner.publicKey)
      const wallet = keypairWallet(owner, { beforeSign: () => tokens.mintTo(mint, accounts[1], 1n) })
      const progress = await run(ctx, quote, fee, wallet)
      expect(progress).toMatchObject([{ status: 'failed', error: MESSAGES.hasTokens }])
      expect(chain.sends).toEqual([]) // rejected at preflight: never executed, no fee
      expect(chain.balance(owner.publicKey)).toBe(ownerBefore)
      for (const a of accounts) expect(chain.exists(a)).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'an empty wSOL account is funded while the wallet prompt is open: that batch is not sent (CloseAccount would succeed on-chain)',
    async () => {
      const ctx = setup()
      const { chain, tokens, owner } = ctx
      const wsol = tokens.createEmptyWsol(owner.publicKey)
      const fee = feeConfig(chain.fundedKeypair(LAMPORTS_PER_SOL).publicKey)
      const quote = buildQuote((await scan(ctx)).eligible, fee)
      expect(quote.batches[0].accounts.map((a) => a.address)).toEqual([wsol.toBase58()])
      const wallet = keypairWallet(owner, {
        // Someone wraps 0.01 SOL into it while the prompt is open.
        beforeSign: () => {
          chain.send([SystemProgram.transfer({ fromPubkey: tokens.payer.publicKey, toPubkey: wsol, lamports: 10_000_000 })], [tokens.payer])
        },
      })
      const progress = await run(ctx, quote, fee, wallet)
      expect(progress).toMatchObject([{ status: 'failed', error: MESSAGES.nativeChanged }])
      expect(chain.sends).toEqual([])
      expect(chain.exists(wsol)).toBe(true)

      // Proof that the guard matters: the chain itself would have closed it, balance and all.
      const out = tokens.tryClose(wsol, owner, TOKEN_PROGRAM_ID)
      expect(out.err).toBeNull()
    },
    TIMEOUT,
  )

  it(
    'the blockhash expires while the wallet prompt is open: every batch fails as expired and nothing is sent',
    async () => {
      const ctx = setup()
      const { chain, owner } = ctx
      const { accounts } = emptyAccounts(ctx, 25)
      const fee = feeConfig(chain.fundedKeypair(LAMPORTS_PER_SOL).publicKey)
      const quote = buildQuote((await scan(ctx)).eligible, fee)
      const ownerBefore = chain.balance(owner.publicKey)
      const wallet = keypairWallet(owner, { beforeSign: () => chain.expireBlockhash() })
      const progress = await run(ctx, quote, fee, wallet)
      expect(progress).toMatchObject([
        { status: 'failed', error: MESSAGES.expired },
        { status: 'failed', error: MESSAGES.expired },
      ])
      expect(chain.sends).toEqual([])
      expect(chain.balance(owner.publicKey)).toBe(ownerBefore)
      for (const a of accounts) expect(chain.exists(a)).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'one prompt per batch: the first prompt outlives its blockhash (expired, not sent); the next batch gets a fresh blockhash and lands',
    async () => {
      const ctx = setup()
      const { chain, owner } = ctx
      const { accounts } = emptyAccounts(ctx, 25)
      const fee = feeConfig(chain.fundedKeypair(LAMPORTS_PER_SOL).publicKey)
      const quote = buildQuote((await scan(ctx)).eligible, fee)
      const wallet = keypairWallet(owner, {
        mode: 'single',
        beforeSign: (_txs, call) => {
          if (call === 1) chain.expireBlockhash()
        },
      })
      const progress = await run(ctx, quote, fee, wallet)
      expect(progress[0]).toMatchObject({ status: 'failed', error: MESSAGES.expired })
      expect(progress[1].status).toBe('confirmed')
      expect(wallet.prompts).toBe(2)
      expect(chain.sends).toHaveLength(1)
      for (const a of quote.batches[0].accounts) expect(chain.exists(a.address)).toBe(true)
      for (const a of quote.batches[1].accounts) expect(chain.exists(a.address)).toBe(false)
      expect(accounts.filter((a) => chain.exists(a))).toHaveLength(20)
    },
    TIMEOUT,
  )

  it(
    'close authority handed away / account already closed since the scan: simulation fails with the matching message',
    async () => {
      const ctx = setup()
      const { chain, tokens, owner } = ctx
      const o = owner.publicKey
      const spl = tokens.createMint()
      const t22 = tokens.createMint({ program: 'token-2022' })
      const accounts = {
        splHanded: tokens.createAccount(o, spl),
        t22Handed: tokens.createAccount(o, t22),
        splClosed: tokens.createAccount(o, spl),
        t22Closed: tokens.createAccount(o, t22),
      }
      const fee = feeConfig(chain.fundedKeypair(LAMPORTS_PER_SOL).publicKey, { maxClosesPerTx: 1 })
      const quote = buildQuote((await scan(ctx)).eligible, fee)
      expect(quote.batches).toHaveLength(4)
      const other = Keypair.generate().publicKey
      tokens.setCloseAuthority(spl, accounts.splHanded, owner, other)
      tokens.setCloseAuthority(t22, accounts.t22Handed, owner, other)
      expect(tokens.tryClose(accounts.splClosed, owner, TOKEN_PROGRAM_ID).err).toBeNull()
      expect(tokens.tryClose(accounts.t22Closed, owner, TOKEN_2022_PROGRAM_ID).err).toBeNull()

      const progress = await run(ctx, quote, fee, keypairWallet(owner))
      const errorFor = (account: PublicKey) =>
        progress[quote.batches.findIndex((b) => b.accounts[0].address === account.toBase58())].error
      expect(errorFor(accounts.splHanded)).toBe(MESSAGES.ownerChanged)
      expect(errorFor(accounts.t22Handed)).toBe(MESSAGES.ownerChanged)
      expect(errorFor(accounts.splClosed)).toBe(MESSAGES.alreadyClosed)
      expect(errorFor(accounts.t22Closed)).toBe(MESSAGES.alreadyClosed)
      expect(progress.every((p) => p.status === 'failed')).toBe(true)
      expect(chain.sends).toEqual([])
    },
    TIMEOUT,
  )

  it(
    'a near-empty wallet can still clean; one that would drop below the rent-exempt minimum paying the fee, or has 0 SOL, is told why not',
    async () => {
      // 0.0009 SOL: the rent-exempt minimum plus 10,000 lamports — enough for the network fee.
      const dustLamports = 890_880 + 10_000
      const dust = setup(dustLamports)
      const { accounts } = emptyAccounts(dust, 3)
      const feeWallet = dust.chain.fundedKeypair(LAMPORTS_PER_SOL).publicKey
      const fee = feeConfig(feeWallet)
      const quote = buildQuote((await scan(dust)).eligible, fee)
      const progress = await run(dust, quote, fee, keypairWallet(dust.owner))
      expect(progress).toMatchObject([{ status: 'confirmed' }])
      expect(dust.chain.balance(dust.owner.publicKey)).toBe(dustLamports + quote.netLamports)
      for (const a of accounts) expect(dust.chain.exists(a)).toBe(false)

      // Just above the minimum, but paying the fee would take the wallet below it:
      // the runtime rejects the fee payer (index 0) with InsufficientFundsForRent.
      const edge = setup(890_880 + 1_000)
      emptyAccounts(edge, 2)
      const edgeFee = feeConfig(edge.chain.fundedKeypair(LAMPORTS_PER_SOL).publicKey)
      const edgeQuote = buildQuote((await scan(edge)).eligible, edgeFee)
      const edgeResult = await run(edge, edgeQuote, edgeFee, keypairWallet(edge.owner))
      expect(edge.chain.simulations[0].err).toEqual({ InsufficientFundsForRent: { account_index: 0 } })
      expect(edgeResult).toMatchObject([{ status: 'failed', error: MESSAGES.feePayerRent }])
      expect(edge.chain.sends).toEqual([])

      // No SOL at all: the fee payer account doesn't exist.
      const empty = setup(0)
      emptyAccounts(empty, 2)
      const emptyFee = feeConfig(empty.chain.fundedKeypair(LAMPORTS_PER_SOL).publicKey)
      const emptyQuote = buildQuote((await scan(empty)).eligible, emptyFee)
      const wallet = keypairWallet(empty.owner)
      const failed = await run(empty, emptyQuote, emptyFee, wallet)
      expect(failed).toMatchObject([{ status: 'failed', error: MESSAGES.noSolForFee }])
      expect(wallet.prompts).toBe(0)
      expect(empty.chain.sends).toEqual([])
    },
    TIMEOUT,
  )

  it(
    'the RPC drops the first send: the identical signed bytes are rebroadcast and land',
    async () => {
      const ctx = setup()
      const { chain, owner } = ctx
      const { accounts } = emptyAccounts(ctx, 2)
      const fee = feeConfig(chain.fundedKeypair(LAMPORTS_PER_SOL).publicKey)
      const quote = buildQuote((await scan(ctx)).eligible, fee)
      let dropped: string | null = null
      chain.onRpc = (method, params) => {
        if (method !== 'sendTransaction' || dropped) return
        // Accept (signature returned) but never forward to the leader.
        const tx = VersionedTransaction.deserialize(Buffer.from(String(params[0]), 'base64'))
        dropped = Buffer.from(tx.serialize()).toString('base64')
        return { result: signatureOf(tx) }
      }
      const progress = await run(ctx, quote, fee, keypairWallet(owner))
      expect(progress).toMatchObject([{ status: 'confirmed' }])
      // The rebroadcast is byte-for-byte what was first sent, without preflight.
      expect(chain.sends).toHaveLength(1)
      expect(chain.sends[0]).toMatchObject({ skipPreflight: true, executed: true, signature: progress[0].signature })
      expect(Buffer.from(chain.sends[0].bytes).toString('base64')).toBe(dropped)
      for (const a of accounts) expect(chain.exists(a)).toBe(false)
    },
    TIMEOUT,
  )

  it(
    'a sent transaction that never lands before its blockhash expires is reported as expired, never as confirmed',
    async () => {
      const ctx = setup()
      const { chain, owner } = ctx
      const { accounts } = emptyAccounts(ctx, 2)
      const fee = feeConfig(chain.fundedKeypair(LAMPORTS_PER_SOL).publicKey)
      const quote = buildQuote((await scan(ctx)).eligible, fee)
      chain.onRpc = (method, params) => {
        if (method !== 'sendTransaction') return
        const tx = VersionedTransaction.deserialize(Buffer.from(String(params[0]), 'base64'))
        // Dropped by the leader, and the cluster moves on past its blockhash.
        chain.expireBlockhash()
        return { result: signatureOf(tx) }
      }
      const progress = await run(ctx, quote, fee, keypairWallet(owner))
      expect(progress).toMatchObject([{ status: 'failed', error: MESSAGES.expired }])
      for (const a of accounts) expect(chain.exists(a)).toBe(true)
    },
    TIMEOUT,
  )
})

describe('harness fidelity', () => {
  it('holder check reads balances through the mint filter (SPL Token and Token-2022 accounts of one mint)', async () => {
    const ctx = setup()
    const { tokens, owner } = ctx
    const mopi = tokens.createMint({ decimals: 6 })
    tokens.mintTo(mopi, tokens.createAta(owner.publicKey, mopi), 80_000_000_000n) // 80,000
    tokens.mintTo(mopi, tokens.createAccount(owner.publicKey, mopi), 25_500_000_000n) // 25,500
    tokens.createAta(owner.publicKey, tokens.createMint()) // another mint: ignored
    const status = await checkHolderStatus(ctx.connection, owner.publicKey, { mint: mopi.address.toBase58(), minRequired: 100_000 })
    expect(status).toMatchObject({ checked: true, isHolder: true, balanceUi: 105_500 })
  })
})

// ── Real-world RPC reliability ──────────────────────────────────────────────
// The chain is the truth; the transport between app and "nodes" misbehaves the
// way mainnet RPCs do (lost answers, stalls, lagging preflight banks, slow
// optimistic confirmation).

describe('reliability: what the user is told matches what landed', () => {
  const PRIMARY = 'https://primary.invalid'
  const FALLBACK = 'https://fallback.invalid'

  function world(accounts: number) {
    const chain = new LiteSvmChain()
    const tokens = new TokenFactory(chain)
    const owner = Keypair.generate()
    chain.airdrop(owner.publicKey, 2 * LAMPORTS_PER_SOL)
    for (let k = 0; k < accounts; k++) tokens.createAta(owner.publicKey, tokens.createMint())
    const feeWallet = chain.fundedKeypair(LAMPORTS_PER_SOL).publicKey
    const fee: FeeConfig = { ...defaultFeeConfig(false), serviceFeeBps: CONFIG.serviceFeeBps, feeWallet: feeWallet.toBase58() }
    return { chain, owner, fee }
  }

  type Transport = (input: unknown, init?: RequestInit) => Promise<Response>
  const methodOf = (init?: RequestInit) => (JSON.parse(String(init?.body ?? '{}')) as { method?: string }).method

  function failoverConnection(transport: Transport) {
    return new Connection(PRIMARY, {
      commitment: 'confirmed',
      disableRetryOnRateLimit: true,
      fetch: createFailoverFetch({ endpoints: [PRIMARY, FALLBACK], fetch: transport as unknown as typeof fetch, sleep: async () => {} }),
    })
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it(
    'primary delivers the tx but its answer is lost; failover re-sends, the fallback says "already processed" → confirmed, not failed',
    async () => {
      const { chain, owner, fee } = world(3)
      const base = createLiteSvmFetch(chain)
      let lost = false
      const connection = failoverConnection(async (input, init) => {
        if (!lost && String(input).startsWith(PRIMARY) && methodOf(init) === 'sendTransaction') {
          lost = true
          await base(input, init as { body?: unknown }) // forwarded to the leader…
          throw new TypeError('Failed to fetch') // …then the HTTP answer is lost (reset, 502/524 after forwarding)
        }
        return base(input, init as { body?: unknown })
      })
      const scan = await scanWallet(connection, owner.publicKey, { cluster: 'mainnet-beta' })
      const quote = buildQuote(scan.eligible, fee)
      const progress = await executeCleanup({ connection, wallet: keypairWallet(owner), quote, fee, onProgress: () => {} })

      expect(lost).toBe(true)
      for (const a of quote.batches[0].accounts) expect(chain.exists(a.address)).toBe(false)
      expect(chain.history().filter((r) => r.err === null && r.signature === progress[0].signature)).toHaveLength(1)
      expect(progress[0]).toMatchObject({ status: 'confirmed' })
      expect(progress[0].error).toBeUndefined()
    },
    TIMEOUT,
  )

  it(
    'a first send that fails in transport before reaching any node is tracked and lands through the rebroadcast of the same bytes',
    async () => {
      const { chain, owner, fee } = world(2)
      const base = createLiteSvmFetch(chain)
      let dropped = 0
      // Single endpoint (no failover): the request dies on the way, no node sees it,
      // and there is no JSON-RPC answer about the tx at all.
      const connection = new Connection(PRIMARY, {
        commitment: 'confirmed',
        disableRetryOnRateLimit: true,
        fetch: (async (input: unknown, init?: RequestInit) => {
          if (methodOf(init) === 'sendTransaction' && dropped++ === 0) throw new TypeError('Failed to fetch')
          return base(input, init as { body?: unknown })
        }) as unknown as typeof fetch,
      })
      const scan = await scanWallet(connection, owner.publicKey, { cluster: 'mainnet-beta' })
      const quote = buildQuote(scan.eligible, fee)
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      const done = executeCleanup({ connection, wallet: keypairWallet(owner), quote, fee, onProgress: () => {} })
      await vi.advanceTimersByTimeAsync(30_000)
      const progress = await done
      expect(progress[0].status).toBe('confirmed')
      expect(dropped).toBeGreaterThanOrEqual(2)
      const sends = chain.callsTo('sendTransaction')
      expect(sends.length).toBeGreaterThanOrEqual(1)
      // Every send that reached the chain carried the same signed bytes.
      expect(new Set(sends.map((c) => String(c.params[0]))).size).toBe(1)
    },
    TIMEOUT,
  )

  it(
    'a primary that accepts the connection but never answers sendTransaction: times out, fails over, and the run settles',
    async () => {
      const { chain, owner, fee } = world(2)
      const base = createLiteSvmFetch(chain)
      const connection = failoverConnection(async (input, init) => {
        if (String(input).startsWith(PRIMARY) && methodOf(init) === 'sendTransaction') {
          return new Promise<Response>(() => {}) // overloaded node: TCP open, no answer
        }
        return base(input, init as { body?: unknown })
      })
      const scan = await scanWallet(connection, owner.publicKey, { cluster: 'mainnet-beta' })
      const quote = buildQuote(scan.eligible, fee)
      vi.useFakeTimers()
      let settled = false
      const done = executeCleanup({ connection, wallet: keypairWallet(owner), quote, fee, onProgress: () => {} }).finally(
        () => (settled = true),
      )
      await vi.advanceTimersByTimeAsync(2 * 60_000)
      expect(settled).toBe(true)
      const progress = await done
      expect(progress[0].status).toBe('confirmed')
      for (const a of quote.batches[0].accounts) expect(chain.exists(a.address)).toBe(false)
    },
    TIMEOUT,
  )

  it(
    'preflight "Blockhash not found" from a lagging node while the blockhash is still valid → the verified bytes still land',
    async () => {
      const { chain, owner, fee } = world(2)
      const connection = createLiteSvmConnection(chain)
      let lagged = false
      chain.onRpc = (method, params) => {
        const cfg = (params[1] ?? {}) as { skipPreflight?: boolean }
        if (method !== 'sendTransaction' || cfg.skipPreflight || lagged) return
        lagged = true
        // What Agave answers when the preflight bank has not seen the blockhash yet.
        throw new RpcFailure(-32002, 'Transaction simulation failed: Blockhash not found', {
          accounts: null, err: 'BlockhashNotFound', innerInstructions: null, loadedAccountsDataSize: 0,
          logs: [], replacementBlockhash: null, returnData: null, unitsConsumed: 0,
        })
      }
      const scan = await scanWallet(connection, owner.publicKey, { cluster: 'mainnet-beta' })
      const quote = buildQuote(scan.eligible, fee)
      const progress = await executeCleanup({ connection, wallet: keypairWallet(owner), quote, fee, onProgress: () => {} })
      expect(lagged).toBe(true)
      expect(progress[0].status).toBe('confirmed')
      for (const a of quote.batches[0].accounts) expect(chain.exists(a.address)).toBe(false)
    },
    TIMEOUT,
  )

  it(
    'preflight "Blockhash not found" after the blockhash really expired → "expired", nothing lands',
    async () => {
      const { chain, owner, fee } = world(2)
      const connection = createLiteSvmConnection(chain)
      chain.onRpc = (method, params) => {
        const cfg = (params[1] ?? {}) as { skipPreflight?: boolean }
        if (method === 'sendTransaction' && !cfg.skipPreflight) chain.expireBlockhash()
      }
      const scan = await scanWallet(connection, owner.publicKey, { cluster: 'mainnet-beta' })
      const quote = buildQuote(scan.eligible, fee)
      const progress = await executeCleanup({ connection, wallet: keypairWallet(owner), quote, fee, onProgress: () => {} })
      expect(progress[0]).toMatchObject({ status: 'failed', error: MESSAGES.expired })
      for (const a of quote.batches[0].accounts) expect(chain.exists(a.address)).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'a transaction the RPC already reports as processed (in a block) is not rebroadcast',
    async () => {
      vi.useFakeTimers()
      const { chain, owner, fee } = world(45) // 3 batches
      const connection = createLiteSvmConnection(chain)
      // Landed immediately, but stays 'processed' for ~20 polls (slow optimistic confirmation).
      chain.processedPolls = 20
      const scan = await scanWallet(connection, owner.publicKey, { cluster: 'mainnet-beta' })
      const quote = buildQuote(scan.eligible, fee)
      expect(quote.batches).toHaveLength(3)
      const done = executeCleanup({ connection, wallet: keypairWallet(owner), quote, fee, onProgress: () => {} })
      await vi.advanceTimersByTimeAsync(120_000)
      const progress = await done
      expect(progress.map((p) => p.status)).toEqual(['confirmed', 'confirmed', 'confirmed'])
      expect(chain.callsTo('sendTransaction')).toHaveLength(3) // first sends only
    },
    TIMEOUT,
  )
})

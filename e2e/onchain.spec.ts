import { Buffer } from 'node:buffer'
import { expect, test, type Page } from '@playwright/test'
import { Keypair, LAMPORTS_PER_SOL, PublicKey, VersionedTransaction } from '@solana/web3.js'
import { LiteSvmChain, TokenFactory } from '../src/test/litesvm'
import { NODE_SIGNER, exposeKeypairSigner, routeRpcToChain } from './support/chain'
import { collectErrors, isPhone } from './support/page'
import { FAKE_WALLET_NAME, installFakeWallet, walletState } from './support/wallet'

// THE REAL APP ON A REAL RUNTIME. The production build talks to a LiteSVM
// chain (real SPL Token / Token-2022 / ATA / System programs) through
// page.route, and its Wallet Standard wallet signs with a real ed25519 key in
// node. Nothing about the cleanup is mocked: the scan reads accounts the
// programs created, the simulation and the send are executed by the SVM, and
// the assertions at the end read the chain's state.

const OWNER = Keypair.fromSeed(new Uint8Array(32).fill(42))
const OWNER_B58 = OWNER.publicKey.toBase58()
const SHORT = `${OWNER_B58.slice(0, 4)}...${OWNER_B58.slice(-4)}`
/** The default build has no fee wallet; a build with VITE_FEE_WALLET charges VITE_SERVICE_FEE_BPS (default 400). */
const FEE_WALLET = process.env.VITE_FEE_WALLET?.trim() || null
const FEE_BPS = FEE_WALLET ? Number(process.env.VITE_SERVICE_FEE_BPS?.trim() || 400) : 0
const OWNER_START = LAMPORTS_PER_SOL / 20

// The app's static fee settings (src/config.ts); the chain reports no recent
// prioritization fees, so the dynamic estimate stays at the floor.
const BASE_FEE = 5_000
const PRICE = 20_000
const CU_PER_CLOSE = 6_000
const CU_BASE = 2_000

interface World {
  chain: LiteSvmChain
  tokens: TokenFactory
  eligible: PublicKey[]
  skipped: PublicKey[]
  /** A mint of one eligible SPL account (to send it tokens later). */
  raceMint: ReturnType<TokenFactory['createMint']>
}

/** A wallet with 4 closable accounts and 3 that must be left alone, all made by the real programs. */
function buildWorld(): World {
  const chain = new LiteSvmChain()
  const tokens = new TokenFactory(chain)
  chain.airdrop(OWNER.publicKey, OWNER_START)
  if (FEE_WALLET) chain.airdrop(new PublicKey(FEE_WALLET), LAMPORTS_PER_SOL)
  const o = OWNER.publicKey

  const raceMint = tokens.createMint()
  const eligible = [
    tokens.createAta(o, raceMint),
    tokens.createAta(o, tokens.createMint()),
    tokens.createAta(o, tokens.createMint()),
    tokens.createAta(o, tokens.createMint({ program: 'token-2022' })),
  ]

  const rich = tokens.createMint({ decimals: 6 })
  const richAta = tokens.createAta(o, rich)
  tokens.mintTo(rich, richAta, 12_500_000n)
  const freezable = tokens.createMint({ freezable: true })
  const frozen = tokens.createAta(o, freezable)
  tokens.freeze(freezable, frozen)
  const feeMint = tokens.createMint({ program: 'token-2022', transferFee: { basisPoints: 100, maximumFee: 1_000n } })
  const source = tokens.createAta(tokens.payer.publicKey, feeMint)
  tokens.mintTo(feeMint, source, 100_000n)
  const withheld = tokens.createAta(o, feeMint)
  tokens.transferWithFee(feeMint, source, withheld, tokens.payer, 10_000n, 100n)
  tokens.burn(feeMint, withheld, OWNER, 9_900n)

  return { chain, tokens, eligible, skipped: [richAta, frozen, withheld], raceMint }
}

function snapshot(chain: LiteSvmChain, key: PublicKey): string {
  const info = chain.account(key)
  return info ? `${info.lamports}:${Buffer.from(info.data).toString('hex')}` : 'closed'
}

/** formatSol(…, 4 decimals) for amounts ≥ 0.001 SOL. */
function sol(lamports: number): string {
  return (Math.round(lamports / 100_000) / 10_000).toFixed(4)
}

/** The quote mopi must show and charge for closing `deposits` in one transaction. */
function expectedQuote(deposits: number[]) {
  const reclaim = deposits.reduce((s, d) => s + d, 0)
  const networkFee = BASE_FEE + Math.ceil(((CU_BASE + deposits.length * CU_PER_CLOSE) * PRICE) / 1_000_000)
  const serviceFee = Math.floor((reclaim * FEE_BPS) / 10_000)
  return { reclaim, networkFee, serviceFee, net: reclaim - networkFee - serviceFee }
}

async function start(page: Page, world: World) {
  await installFakeWallet(page, OWNER.publicKey, { signer: NODE_SIGNER })
  const signer = await exposeKeypairSigner(page, OWNER)
  await routeRpcToChain(page, world.chain)
  return signer
}

async function connectAndScan(page: Page, counts: { eligible: number; skipped: number }) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Connect wallet' }).click()
  const picker = page.getByRole('dialog', { name: 'Connect a wallet' })
  await picker.getByRole('list', { name: 'Detected wallets' }).getByRole('button', { name: new RegExp(FAKE_WALLET_NAME) }).click()
  await expect(picker).toBeHidden()
  await expect(page.getByRole('button', { name: new RegExp(`^Wallet ${SHORT.replace(/\./g, '\\.')}`) })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Solana wallet address' })).toHaveValue(OWNER_B58)
  await expect(page.getByRole('tab', { name: `Eligible (${counts.eligible})` })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('tab', { name: `Skipped (${counts.skipped})` })).toBeVisible()
}

async function openReview(page: Page, accounts: number) {
  const review = page.getByRole('region', { name: /cleanup preview/i }).getByRole('button', { name: /^Review/ })
  if (!isPhone(page)) await expect(review).toHaveAccessibleName(`Review ${accounts} accounts`)
  await review.click()
  const dialog = page.getByRole('dialog', { name: 'Review cleanup' })
  await expect(dialog).toBeVisible()
  return dialog
}

test('connect → the scan reads the real chain → review → approve → accounts really closed and SOL really moved as quoted', async ({
  page,
}) => {
  test.setTimeout(60_000)
  const errors = collectErrors(page)
  const world = buildWorld()
  const { chain } = world
  // Landed transactions report 'processed' once before 'confirmed': the app has to poll.
  chain.processedPolls = 1
  const signer = await start(page, world)

  await connectAndScan(page, { eligible: 4, skipped: 3 })
  // The scan really went to the chain, for both token programs.
  expect(chain.callsTo('getTokenAccountsByOwner').map((c) => (c.params[1] as { programId?: string }).programId).sort()).toEqual([
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  ])

  const deposits = world.eligible.map((a) => chain.balance(a))
  const quote = expectedQuote(deposits)
  const skippedBefore = world.skipped.map((a) => snapshot(chain, a))
  const ownerBefore = chain.balance(OWNER.publicKey)
  const feeWalletBefore = FEE_WALLET ? chain.balance(FEE_WALLET) : 0

  const dialog = await openReview(page, 4)
  await expect(dialog.getByText('Close 4 empty token accounts')).toBeVisible()
  await expect(dialog.getByText(`Their account SOL returns to ${SHORT}`)).toBeVisible()
  await expect(dialog.getByRole('heading', { name: '1 transaction' })).toBeVisible()
  expect(chain.sends).toEqual([])

  await dialog.getByRole('button', { name: 'Approve in wallet' }).click()
  const done = page.getByRole('dialog', { name: 'Cleanup complete' })
  await expect(done).toBeVisible({ timeout: 30_000 })
  await expect(done.getByRole('status').filter({ hasText: 'returned to your wallet' })).toHaveText(
    `${sol(quote.net)} SOL returned to your wallet`,
  )
  await expect(done.getByText('1 of 1 transaction confirmed.')).toBeVisible()

  // ── On-chain truth ───────────────────────────────────────────────────────
  expect(chain.sends).toHaveLength(1)
  const sent = chain.sends[0]
  const record = chain.record(sent.signature)!
  expect(record.err).toBeNull()
  // The link points at the transaction that really landed.
  await expect(done.getByRole('link', { name: /Transaction 1:/ })).toHaveAttribute('href', `https://solscan.io/tx/${sent.signature}`)
  // What landed is byte-for-byte what the wallet's key signed.
  expect(signer.signed).toHaveLength(1)
  expect(Buffer.from(sent.bytes).equals(Buffer.from(signer.signed[0]))).toBe(true)
  const tx = VersionedTransaction.deserialize(sent.bytes)
  expect(tx.message.staticAccountKeys[0].toBase58()).toBe(OWNER_B58)
  expect(tx.message.header.numRequiredSignatures).toBe(1)
  // Accounts: the eligible ones are gone, the rest are untouched.
  for (const a of world.eligible) expect(chain.exists(a), a.toBase58()).toBe(false)
  expect(world.skipped.map((a) => snapshot(chain, a))).toEqual(skippedBefore)
  // Money: exactly the quoted network fee was charged and the rest came home.
  expect(record.fee).toBe(quote.networkFee)
  expect(chain.balance(OWNER.publicKey) - ownerBefore).toBe(quote.net)
  if (FEE_WALLET) expect(chain.balance(FEE_WALLET) - feeWalletBefore).toBe(quote.serviceFee)
  // Confirmation was polled over HTTP until 'confirmed'.
  expect(chain.callsTo('getSignatureStatuses').length).toBeGreaterThanOrEqual(2)
  expect((await walletState(page)).signCalls).toBe(1)

  // The background refresh reads the chain again: nothing left to clean.
  await done.getByRole('button', { name: 'Done' }).click()
  await expect(page.getByRole('tab', { name: 'Eligible (0)' })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Skipped (3)' })).toBeVisible()
  expect(errors).toEqual([])
})

test('tokens arrive after the scan: the real program rejects the close in simulation, nothing is signed, nothing moves', async ({
  page,
}) => {
  test.setTimeout(60_000)
  const errors = collectErrors(page)
  const world = buildWorld()
  const { chain, tokens } = world
  await start(page, world)
  await connectAndScan(page, { eligible: 4, skipped: 3 })

  // Someone sends a token to one of the scanned empty accounts.
  tokens.mintTo(world.raceMint, world.eligible[0], 7n)
  const before = [...world.eligible, ...world.skipped].map((a) => snapshot(chain, a))
  const ownerBefore = chain.balance(OWNER.publicKey)

  const dialog = await openReview(page, 4)
  await dialog.getByRole('button', { name: 'Approve in wallet' }).click()
  const failed = page.getByRole('dialog', { name: 'Cleanup didn’t finish' })
  await expect(failed).toBeVisible({ timeout: 30_000 })
  await expect(failed.getByText('An account received tokens since the scan — rescan and try again').first()).toBeVisible()

  expect(chain.simulations).toHaveLength(1)
  expect(chain.simulations[0].err).toEqual({ InstructionError: [expect.any(Number), { Custom: 11 }] })
  expect((await walletState(page)).signCalls).toBe(0)
  expect(chain.sends).toEqual([])
  expect([...world.eligible, ...world.skipped].map((a) => snapshot(chain, a))).toEqual(before)
  expect(chain.balance(OWNER.publicKey)).toBe(ownerBefore)
  expect(errors).toEqual([])
})

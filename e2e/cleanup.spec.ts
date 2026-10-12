import { Buffer } from 'node:buffer'
import { expect, test, type Page } from '@playwright/test'
import { PublicKey, VersionedTransaction } from '@solana/web3.js'
import { context, mockRpc, mockRpcWebSocket } from './support/rpc'
import {
  COMPUTE_BUDGET,
  SPL_RENT,
  SPL_TOKEN,
  SYSTEM_PROGRAM,
  TOKEN_2022,
  address,
  base58,
  keyFromSeed,
  parsedTokenAccount,
  type ParsedTokenAccount,
} from './support/solana'
import { collectErrors, isPhone } from './support/page'
import { FAKE_WALLET_NAME, installFakeWallet, walletState } from './support/wallet'

// FULL REAL CLEANUP against a fake Wallet Standard wallet and a mocked RPC.
// The transactions the app sends are decoded on the node side and checked
// instruction by instruction.

const WALLET = keyFromSeed(7)
const WALLET_B58 = WALLET.toBase58()
const EMPTY = [1, 2, 3].map((n) => address(150 + n))
const MINTS = [1, 2, 3].map((n) => address(250 + n))
/** The default build has no fee wallet; a build with VITE_FEE_WALLET may add exactly one transfer to it. */
const FEE_WALLET = process.env.VITE_FEE_WALLET?.trim() || null

const BLOCKHASH = base58(new Uint8Array(32).fill(9))
const BLOCK_HEIGHT = 280_000_000
const LAST_VALID_BLOCK_HEIGHT = BLOCK_HEIGHT + 150
const SHORT = `${WALLET_B58.slice(0, 4)}...${WALLET_B58.slice(-4)}`

interface SetupOptions {
  rejectSigning?: boolean
  /**
   * The mocked RPC reports the signature as unknown (null status) until it has received this many
   * sendTransaction calls, i.e. the first send was "dropped" and the app has to rebroadcast.
   */
  unseenUntilSends?: number
}

async function setup(page: Page, opts: SetupOptions = {}) {
  await installFakeWallet(page, WALLET, { rejectSigning: opts.rejectSigning })
  const closed = new Set<string>()
  const sent: string[] = []
  const simulated: string[] = []
  const live = (): ParsedTokenAccount[] =>
    EMPTY.filter((a) => !closed.has(a)).map((pubkey, i) =>
      parsedTokenAccount({ pubkey, owner: WALLET_B58, mint: MINTS[i], program: 'spl-token', lamports: SPL_RENT }),
    )

  const rpc = await mockRpc(page, {
    handlers: {
      getTokenAccountsByOwner: (params) => {
        const [owner, filter] = params as [string, { programId?: string }]
        if (owner === WALLET_B58 && filter?.programId === SPL_TOKEN) return { context: context(), value: live() }
        return { context: context(), value: [] }
      },
      getLatestBlockhash: () => ({ context: context(), value: { blockhash: BLOCKHASH, lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT } }),
      simulateTransaction: (params) => {
        simulated.push(String(params[0]))
        return {
          context: context(),
          value: { err: null, logs: ['Program log: Instruction: CloseAccount'], accounts: null, unitsConsumed: 9_123, returnData: null },
        }
      },
      getBlockHeight: () => BLOCK_HEIGHT,
      sendTransaction: (params) => {
        const b64 = String(params[0])
        sent.push(b64)
        const tx = VersionedTransaction.deserialize(Buffer.from(b64, 'base64'))
        // The token accounts in this transaction are gone from now on.
        for (const ix of tx.message.compiledInstructions) {
          const program = tx.message.staticAccountKeys[ix.programIdIndex].toBase58()
          if (program === SPL_TOKEN || program === TOKEN_2022) closed.add(tx.message.staticAccountKeys[ix.accountKeyIndexes[0]].toBase58())
        }
        return base58(tx.signatures[0])
      },
      getSignatureStatuses: (params) => ({
        context: context(),
        value: (params[0] as string[]).map((signature) =>
          sent.filter((b64) => signatureOf(b64) === signature).length < (opts.unseenUntilSends ?? 1)
            ? null
            : { slot: 300_000_005, confirmations: null, err: null, status: { Ok: null }, confirmationStatus: 'confirmed' },
        ),
      }),
      getSignatureStatus: () => ({ context: context(), value: null }),
      getMultipleAccounts: (params) => ({ context: context(), value: (params[0] as string[]).map(() => null) }),
      getBalance: () => ({ context: context(), value: 1_000_000_000 }),
    },
  })
  const ws = await mockRpcWebSocket(page)

  return { rpc, ws, sent, simulated }
}

function signatureOf(b64: string): string {
  return base58(VersionedTransaction.deserialize(Buffer.from(b64, 'base64')).signatures[0])
}

/** Connects through mopi's wallet picker and waits for the automatic scan of the connected wallet. */
async function connectAndScan(page: Page) {
  await page.goto('/')
  await expect(page.getByText('Demo estimates', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Connect wallet' }).click()
  const picker = page.getByRole('dialog', { name: 'Connect a wallet' })
  await expect(picker).toBeVisible()
  await expect(picker.getByText('mopi never asks for your seed phrase.', { exact: false })).toBeVisible()
  await picker.getByRole('list', { name: 'Detected wallets' }).getByRole('button', { name: new RegExp(FAKE_WALLET_NAME) }).click()
  await expect(picker).toBeHidden()

  // Connected: the header shows the short address (desktop) / a connected account button (phone).
  await expect(page.getByRole('button', { name: new RegExp(`^Wallet ${SHORT.replace(/\./g, '\\.')}`) })).toBeVisible()
  expect((await walletState(page)).connectCalls).toBeGreaterThan(0)

  // The app scans the connected wallet automatically (read-only).
  await expect(page.getByRole('textbox', { name: 'Solana wallet address' })).toHaveValue(WALLET_B58)
  await expect(page.getByRole('tab', { name: 'Eligible (3)' })).toBeVisible()
  await expect(page.getByText('Demo estimates', { exact: true })).toHaveCount(0)
}

async function openReview(page: Page) {
  const review = page.getByRole('region', { name: /cleanup preview/i }).getByRole('button', { name: /^Review/ })
  if (!isPhone(page)) await expect(review).toHaveAccessibleName('Review 3 accounts')
  await review.click()
  const dialog = page.getByRole('dialog', { name: 'Review cleanup' })
  await expect(dialog).toBeVisible()
  return dialog
}

test('connect a Wallet Standard wallet → auto-scan → review → approve → confirmed, and only safe instructions are sent', async ({
  page,
}) => {
  const errors = collectErrors(page)
  const { rpc, ws, sent, simulated } = await setup(page)

  // 1–2. Connect through the picker; the connected wallet is scanned automatically.
  await connectAndScan(page)
  expect(rpc.callsTo('getTokenAccountsByOwner').length).toBeGreaterThanOrEqual(2)
  expect(rpc.callsTo('getTokenAccountsByOwner').every((c) => c.params[0] === WALLET_B58)).toBe(true)

  // 3. Review.
  const dialog = await openReview(page)
  await expect(dialog.getByText('Close 3 empty token accounts')).toBeVisible()
  await expect(dialog.getByText(`Their account SOL returns to ${SHORT}`)).toBeVisible()
  await expect(dialog.getByText('Nothing else — no token transfers, no approvals or delegations.')).toBeVisible()
  await expect(dialog.getByRole('heading', { name: '1 transaction' })).toBeVisible()
  if (!FEE_WALLET) {
    await expect(dialog.locator('.review__summary-row').filter({ hasText: 'Service fee' })).toContainText('none')
  }
  expect(sent).toEqual([])
  expect(simulated).toEqual([])

  // 4. Approve in wallet → simulate → sign → send → confirm.
  await dialog.getByRole('button', { name: 'Approve in wallet' }).click()
  const done = page.getByRole('dialog', { name: 'Cleanup complete' })
  await expect(done).toBeVisible({ timeout: 20_000 })
  // 3 × 2,039,280 − (5,000 + 400 priority) = 6,112,440 lamports → 0.0061 SOL (no service fee in the default build).
  const expectedReturn = FEE_WALLET ? /SOL returned to your wallet/ : /^0\.0061 SOL returned to your wallet$/
  await expect(done.getByRole('status').filter({ hasText: 'returned to your wallet' })).toHaveText(expectedReturn)
  await expect(done.getByText('1 of 1 transaction confirmed.')).toBeVisible()
  const href = await done.getByRole('link', { name: /Transaction 1:/ }).getAttribute('href')
  const signature = base58(VersionedTransaction.deserialize(Buffer.from(sent[0], 'base64')).signatures[0])
  expect(href).toBe(`https://solscan.io/tx/${signature}`)
  // Confirmation is HTTP polling of the signature (works with any RPC); no websocket subscription.
  expect(rpc.callsTo('getSignatureStatuses').some((c) => (c.params[0] as string[]).includes(signature))).toBe(true)
  expect(ws.signatureSubscriptions).toEqual([])

  const wallet = await walletState(page)
  expect(wallet.signCalls).toBe(1)
  expect(wallet.signedCount).toBe(1)

  await done.getByRole('button', { name: 'Done' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  // The background refresh sees the accounts gone.
  await expect(page.getByRole('tab', { name: 'Eligible (0)' })).toBeVisible()
  await expect(page.getByText('Nothing to clean — this wallet is already tidy.')).toBeVisible()

  // ── Node side: decode exactly what was simulated and sent ─────────────────
  expect(simulated).toHaveLength(1)
  expect(sent).toHaveLength(1)
  // What was simulated is the same message that was signed and sent.
  const simTx = VersionedTransaction.deserialize(Buffer.from(simulated[0], 'base64'))
  const sentTx = VersionedTransaction.deserialize(Buffer.from(sent[0], 'base64'))
  expect(Buffer.from(sentTx.message.serialize()).equals(Buffer.from(simTx.message.serialize()))).toBe(true)
  // Every sendTransaction payload the RPC received carries exactly these verified, signed bytes.
  const sendCalls = rpc.callsTo('sendTransaction')
  expect(sendCalls.length).toBeGreaterThanOrEqual(1)
  for (const call of sendCalls) expect(call.params[0]).toBe(sent[0])
  // The first send keeps preflight.
  expect(sendCalls[0].params[1]).not.toMatchObject({ skipPreflight: true })

  const closedAccounts: string[] = []
  for (const b64 of sent) {
    const sendCall = rpc.callsTo('sendTransaction').find((c) => c.params[0] === b64)!
    expect(sendCall.params[1]).toMatchObject({ encoding: 'base64' })

    const tx = VersionedTransaction.deserialize(Buffer.from(b64, 'base64'))
    const msg = tx.message
    const keys = msg.staticAccountKeys.map((k: PublicKey) => k.toBase58())
    expect(tx.version).toBe(0)
    expect(msg.addressTableLookups).toEqual([])
    expect(msg.header.numRequiredSignatures).toBe(1)
    expect(tx.signatures).toHaveLength(1)
    expect(tx.signatures[0].some((b) => b !== 0), 'signed by the wallet').toBe(true)
    expect(keys[0], 'fee payer is the wallet').toBe(WALLET_B58)
    expect(msg.recentBlockhash).toBe(BLOCKHASH)
    // The wallet is the only signer.
    expect(msg.isAccountSigner(0)).toBe(true)
    for (let i = 1; i < keys.length; i++) expect(msg.isAccountSigner(i)).toBe(false)

    let transfers = 0
    for (const ix of msg.compiledInstructions) {
      const program = keys[ix.programIdIndex]
      const accounts = ix.accountKeyIndexes.map((i) => keys[i])
      const data = Array.from(ix.data)
      if (program === COMPUTE_BUDGET) {
        // SetComputeUnitLimit (2) or SetComputeUnitPrice (3) only.
        expect([2, 3]).toContain(data[0])
        expect(accounts).toEqual([])
      } else if (program === SPL_TOKEN || program === TOKEN_2022) {
        expect(data, 'CloseAccount').toEqual([9])
        expect(accounts).toHaveLength(3)
        const [account, destination, authority] = accounts
        expect(EMPTY, 'only the empty accounts are closed').toContain(account)
        expect(destination, 'account SOL goes back to the wallet').toBe(WALLET_B58)
        expect(authority).toBe(WALLET_B58)
        closedAccounts.push(account)
      } else if (program === SYSTEM_PROGRAM && FEE_WALLET) {
        transfers++
        expect(data[0], 'SystemProgram.transfer').toBe(2)
        expect(accounts).toEqual([WALLET_B58, FEE_WALLET])
      } else {
        throw new Error(`unexpected instruction for program ${program} (data ${JSON.stringify(data)})`)
      }
    }
    expect(transfers).toBeLessThanOrEqual(1)
  }
  expect(closedAccounts.sort()).toEqual([...EMPTY].sort())

  expect(errors).toEqual([])
})

test('declining in the wallet sends nothing and explains what happened', async ({ page }) => {
  const { sent } = await setup(page, { rejectSigning: true })
  await connectAndScan(page)
  const dialog = await openReview(page)
  await dialog.getByRole('button', { name: 'Approve in wallet' }).click()

  const failed = page.getByRole('dialog', { name: 'Cleanup didn’t finish' })
  await expect(failed).toBeVisible({ timeout: 20_000 })
  await expect(failed.getByRole('alert')).toHaveText('You declined the request in your wallet.')
  await expect(failed.getByText('Nothing was closed unless a transaction above shows “Confirmed”.')).toBeVisible()
  await expect(failed.getByText('Confirmed', { exact: true })).toHaveCount(0)
  expect((await walletState(page)).signCalls).toBe(1)
  expect(sent).toEqual([])

  await failed.getByRole('button', { name: 'Close' }).first().click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  // The accounts are untouched and still selected.
  await expect(page.getByRole('tab', { name: 'Eligible (3)' })).toBeVisible()
})

test('a dropped send is rebroadcast with the identical verified bytes until the RPC confirms it', async ({ page }) => {
  test.setTimeout(45_000)
  const errors = collectErrors(page)
  // The RPC "loses" the first send: the signature stays unknown until a second copy arrives.
  const { rpc, ws, sent, simulated } = await setup(page, { unseenUntilSends: 2 })
  await connectAndScan(page)
  const dialog = await openReview(page)
  await dialog.getByRole('button', { name: 'Approve in wallet' }).click()

  const done = page.getByRole('dialog', { name: 'Cleanup complete' })
  await expect(done).toBeVisible({ timeout: 30_000 })
  await expect(done.getByText('1 of 1 transaction confirmed.')).toBeVisible()

  // One signature from the wallet, one simulation, at least two sends of the very same bytes.
  expect((await walletState(page)).signCalls).toBe(1)
  expect(simulated).toHaveLength(1)
  expect(sent.length).toBeGreaterThanOrEqual(2)
  expect(new Set(sent).size, 'every send carries identical bytes').toBe(1)
  const simTx = VersionedTransaction.deserialize(Buffer.from(simulated[0], 'base64'))
  const sentTx = VersionedTransaction.deserialize(Buffer.from(sent[0], 'base64'))
  expect(Buffer.from(sentTx.message.serialize()).equals(Buffer.from(simTx.message.serialize()))).toBe(true)

  const sendCalls = rpc.callsTo('sendTransaction')
  // First send: with preflight. Rebroadcasts: no preflight and no RPC-side retries (mopi re-sends itself).
  expect(sendCalls[0].params[1]).not.toMatchObject({ skipPreflight: true })
  for (const call of sendCalls.slice(1)) expect(call.params[1]).toMatchObject({ encoding: 'base64', skipPreflight: true, maxRetries: 0 })

  // Confirmation came from HTTP polling of the signature computed from the signed bytes.
  const signature = signatureOf(sent[0])
  const href = await done.getByRole('link', { name: /Transaction 1:/ }).getAttribute('href')
  expect(href).toBe(`https://solscan.io/tx/${signature}`)
  const polls = rpc.callsTo('getSignatureStatuses').filter((c) => (c.params[0] as string[]).includes(signature))
  expect(polls.length).toBeGreaterThanOrEqual(2)
  expect(ws.signatureSubscriptions).toEqual([])

  // Rebroadcasting stops once the RPC knows the transaction.
  const sendsAtDone = sent.length
  await page.waitForTimeout(4_000)
  expect(sent.length).toBe(sendsAtDone)
  expect(errors).toEqual([])
})

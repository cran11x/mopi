import { expect, test, type Page } from '@playwright/test'
import { RpcError, context, mockRpc } from './support/rpc'
import {
  SPL_RENT,
  SPL_TOKEN,
  T22_FEE_RENT,
  T22_IMMUTABLE_RENT,
  TOKEN_2022,
  address,
  parsedTokenAccount,
} from './support/solana'

// A real (read-only) scan against a mocked mainnet JSON-RPC.

const OWNER = address(41)
const acct = (n: number) => address(100 + n)
const mint = (n: number) => address(200 + n)

const SPL_ACCOUNTS = [
  // 3 empty → eligible
  parsedTokenAccount({ pubkey: acct(1), owner: OWNER, mint: mint(1), program: 'spl-token', lamports: SPL_RENT }),
  parsedTokenAccount({ pubkey: acct(2), owner: OWNER, mint: mint(2), program: 'spl-token', lamports: SPL_RENT }),
  parsedTokenAccount({ pubkey: acct(3), owner: OWNER, mint: mint(3), program: 'spl-token', lamports: SPL_RENT }),
  // holds 1,250 tokens → has tokens
  parsedTokenAccount({
    pubkey: acct(4),
    owner: OWNER,
    mint: mint(4),
    program: 'spl-token',
    lamports: SPL_RENT,
    amount: '1250000000',
    decimals: 6,
  }),
  // empty but frozen → unsupported
  parsedTokenAccount({
    pubkey: acct(5),
    owner: OWNER,
    mint: mint(5),
    program: 'spl-token',
    lamports: SPL_RENT,
    state: 'frozen',
  }),
]

const T22_ACCOUNTS = [
  // empty Token-2022 with ImmutableOwner → eligible
  parsedTokenAccount({
    pubkey: acct(6),
    owner: OWNER,
    mint: mint(6),
    program: 'spl-token-2022',
    lamports: T22_IMMUTABLE_RENT,
    extensions: [{ extension: 'immutableOwner' }],
  }),
  // empty Token-2022 with withheld transfer fees → unsupported
  parsedTokenAccount({
    pubkey: acct(7),
    owner: OWNER,
    mint: mint(7),
    program: 'spl-token-2022',
    lamports: T22_FEE_RENT,
    space: 182,
    extensions: [{ extension: 'immutableOwner' }, { extension: 'transferFeeAmount', state: { withheldAmount: 5 } }],
  }),
]

async function mockScan(page: Page) {
  return mockRpc(page, {
    handlers: {
      getTokenAccountsByOwner: (params) => {
        const [owner, filter] = params as [string, { programId?: string; mint?: string }]
        if (owner !== OWNER) return { context: context(), value: [] }
        if (filter?.programId === SPL_TOKEN) return { context: context(), value: SPL_ACCOUNTS }
        if (filter?.programId === TOKEN_2022) return { context: context(), value: T22_ACCOUNTS }
        throw new RpcError(-32602, 'Invalid params')
      },
    },
  })
}

async function scan(page: Page, value: string) {
  const input = page.getByRole('textbox', { name: 'Solana wallet address' })
  await input.fill(value)
  await page.getByRole('search', { name: 'Scan a wallet' }).getByRole('button', { name: /Scan wallet/ }).click()
}

test('scans a real-looking wallet: counts, tabs, reasons, no demo chip', async ({ page }) => {
  const rpc = await mockScan(page)
  await page.goto('/')
  await expect(page.getByText('Demo estimates', { exact: true })).toBeVisible()

  await scan(page, OWNER)

  await expect(page.getByRole('tab', { name: 'Eligible (4)' })).toBeVisible()
  await expect(page.locator('.scan-summary__tile--mint .scan-summary__num')).toHaveText('4')
  await expect(page.locator('.scan-summary__tile--neutral .scan-summary__num')).toHaveText('1')
  await expect(page.locator('.scan-summary__tile--rose .scan-summary__num')).toHaveText('2')
  await expect(page.getByText('Demo estimates', { exact: true })).toHaveCount(0)

  // Both token programs were queried, jsonParsed, for this owner.
  const scans = rpc.callsTo('getTokenAccountsByOwner')
  expect(scans.map((c) => (c.params[1] as { programId: string }).programId).sort()).toEqual([SPL_TOKEN, TOKEN_2022].sort())
  for (const c of scans) {
    expect(c.params[0]).toBe(OWNER)
    expect(c.params[2]).toMatchObject({ encoding: 'jsonParsed' })
  }

  // Eligible: the Token-2022 account (more account SOL) first, then the 3 SPL ones.
  const eligible = page.getByRole('table', { name: 'Eligible accounts' })
  const rows = eligible.getByRole('row').filter({ has: page.getByRole('cell') })
  await expect(rows).toHaveCount(4)
  await expect(rows.first()).toContainText('0.002 SOL')
  // Real accounts link to the explorer.
  await expect(rows.first().getByRole('link')).toHaveAttribute('href', `https://solscan.io/account/${acct(6)}`)
  for (const n of [1, 2, 3]) {
    await expect(eligible.getByRole('link', { name: new RegExp(`^${acct(n).slice(0, 4)}\\.\\.\\.${acct(n).slice(-4)}`) })).toHaveCount(1)
  }
  for (const n of [4, 5, 7]) {
    await expect(eligible.locator(`a[href$="${acct(n)}"]`)).toHaveCount(0)
  }

  // Preview: 3 × 2,039,280 + 2,074,080 = 8,191,920 lamports; no fee wallet → service fee "none".
  const preview = page.getByRole('region', { name: /cleanup preview/i })
  await expect(preview.locator('.preview__row').filter({ hasText: 'Account SOL detected' })).toContainText('0.0082')
  await expect(preview.locator('.preview__row').filter({ hasText: 'Service fee' })).toContainText('none')
  await expect(preview.getByText('Final amounts appear in your wallet before you approve.')).toBeVisible()

  // Skipped: has tokens, frozen, withheld transfer fees.
  await page.getByRole('tab', { name: 'Skipped (3)' }).click()
  const skipped = page.getByRole('table', { name: 'Skipped accounts' })
  const skippedRows = skipped.getByRole('row').filter({ has: page.getByRole('cell') })
  await expect(skippedRows).toHaveCount(3)
  await expect(page.getByText('Showing 3 of 3 skipped accounts')).toBeVisible()
  await expect(page.getByRole('button', { name: 'View all' })).toHaveCount(0)

  const tokens = skippedRows.filter({ hasText: 'Has tokens' })
  await expect(tokens).toHaveCount(1)
  await expect(tokens).toContainText('1,250')
  await expect(tokens).toContainText('Holds tokens — mopi never touches accounts with a balance.')

  const unsupported = skippedRows.filter({ hasText: 'Unsupported' })
  await expect(unsupported).toHaveCount(2)
  await expect(unsupported.filter({ hasText: "Frozen by the token's freeze authority." })).toHaveCount(1)
  await expect(
    unsupported.filter({
      hasText: 'Token-2022 account with withheld transfer fees. They must be harvested before it can close.',
    }),
  ).toHaveCount(1)
})

test('an invalid address shows an inline error and makes no RPC call', async ({ page }) => {
  const rpc = await mockScan(page)
  await page.goto('/')
  await scan(page, 'not-a-solana-address')

  const alert = page.getByRole('alert')
  await expect(alert).toContainText('look like a Solana address')
  await expect(page.getByRole('textbox', { name: 'Solana wallet address' })).toHaveAttribute('aria-invalid', 'true')
  expect(rpc.calls).toEqual([])

  // An empty field asks for an address.
  await scan(page, '')
  await expect(page.getByRole('alert')).toContainText('Paste a wallet address to scan.')

  // "Try demo wallet" recovers.
  await page.getByRole('button', { name: 'Try demo wallet' }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByRole('tab', { name: 'Eligible (24)' })).toBeVisible()
})

test('an RPC 429 shows a friendly rate-limit error', async ({ page }) => {
  // The app retries a 429 twice (0.6 s, then 1.2 s) before showing the error.
  test.setTimeout(30_000)
  const rpc = await mockRpc(page, { handlers: {}, httpStatus: 429 })
  await page.goto('/')
  await scan(page, OWNER)

  await expect(page.getByRole('button', { name: /Scanning/ })).toBeVisible()
  const alert = page.getByRole('alert')
  await expect(alert).toHaveText('The RPC endpoint is rate limiting requests. Try again in a moment.', { timeout: 10_000 })
  await expect(page.getByRole('search', { name: 'Scan a wallet' }).getByRole('button', { name: /Scan wallet/ })).toBeEnabled()
  expect(rpc.calls.length).toBe(0) // answered at the HTTP layer, before JSON-RPC
})

import { expect, test } from '@playwright/test'
import { collectErrors } from './support/page'

// The demo run is simulated in the browser: no wallet prompt, no RPC, nothing sent.

test('demo run: review → run demo → progress → done ("nothing was sent") → Done closes', async ({ page }) => {
  const errors = collectErrors(page)
  const rpcRequests: string[] = []
  page.on('request', (req) => {
    if (/solana\.com/.test(req.url())) rpcRequests.push(req.url())
  })

  await page.goto('/')
  await page
    .getByRole('region', { name: /cleanup preview/i })
    .getByRole('button', { name: /^Review/ })
    .click()

  const dialog = page.getByRole('dialog', { name: 'Review cleanup' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('Accounts to close')).toBeVisible()
  await expect(dialog.locator('.review__summary-row').filter({ hasText: 'Accounts to close' })).toContainText('24')
  await expect(dialog.getByText('Demo estimates — based on a sample wallet.')).toBeVisible()
  await expect(dialog.getByRole('heading', { name: '2 transactions' })).toBeVisible()
  await expect(dialog.getByText('Close 24 empty token accounts')).toBeVisible()
  await expect(dialog.getByText(/This is the demo wallet/)).toBeVisible()
  // The demo never offers a real approval.
  await expect(dialog.getByRole('button', { name: 'Approve in wallet' })).toHaveCount(0)

  await dialog.getByRole('button', { name: 'Run demo (nothing is sent)' }).click()

  const running = page.getByRole('dialog', { name: 'Running demo…' })
  await expect(running).toBeVisible()
  await expect(running.getByText('Simulating the cleanup. Nothing is sent and no wallet prompt appears.')).toBeVisible()
  await expect(running.getByText('Transaction 1 of 2')).toBeVisible()
  await expect(running.getByText('Transaction 2 of 2')).toBeVisible()
  // Not dismissible while running.
  await expect(running.getByRole('button', { name: 'Close' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(running).toBeVisible()

  const done = page.getByRole('dialog', { name: 'Demo run' })
  await expect(done).toBeVisible({ timeout: 10_000 })
  await expect(done.getByRole('status').filter({ hasText: 'nothing was sent' })).toHaveText('Demo complete — nothing was sent.')
  await expect(done.getByText(/(?:With the example 4% fee, a|A) real run would return about\s*0\.0470 SOL\s*after fees\./)).toBeVisible()
  await expect(done.getByRole('link', { name: /View transaction|Transaction \d/ })).toHaveCount(0)

  await done.getByRole('button', { name: 'Done' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)

  // Still the demo wallet afterwards; nothing was closed.
  await expect(page.getByRole('tab', { name: 'Eligible (24)' })).toBeVisible()
  expect(rpcRequests, 'the demo run makes no RPC requests').toEqual([])
  expect(errors).toEqual([])
})

test('demo review can be cancelled', async ({ page }) => {
  await page.goto('/')
  await page
    .getByRole('region', { name: /cleanup preview/i })
    .getByRole('button', { name: /^Review/ })
    .click()
  const dialog = page.getByRole('dialog', { name: 'Review cleanup' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

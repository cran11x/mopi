import { expect, test, type Page } from '@playwright/test'
import { collectErrors, isPhone } from './support/page'

// First paint is the labelled demo wallet: 24 eligible / 6 with tokens / 1
// unsupported. Nothing here touches the network.
//
// Demo amounts (standard 4% demo service fee, 20 closes per transaction):
//   account SOL  24 × 2,039,280            = 48,942,720 lamports → 0.0489 SOL
//   network fee  (5,000 + 2,440) + (5,000 + 520) = 12,960        → −0.000013 SOL
//   service fee  1,631,424 + 326,284       =  1,957,708          → −0.0020 SOL
//   return                                    46,972,052          → 0.0470 SOL
// With one account unchecked (23): account SOL 46,903,440 → 0.0469 SOL.

function preview(page: Page) {
  return page.getByRole('region', { name: /cleanup preview/i })
}

function previewRow(page: Page, label: string) {
  return preview(page).locator('.preview__row').filter({ hasText: label })
}

function tileNumber(page: Page, tone: 'mint' | 'neutral' | 'rose') {
  return page.locator(`.scan-summary__tile--${tone} .scan-summary__num`)
}

function eligibleRows(page: Page) {
  return page.getByRole('table', { name: 'Eligible accounts' }).getByRole('row').filter({ has: page.getByRole('cell') })
}

function reviewButton(page: Page) {
  return preview(page).getByRole('button', { name: /^Review/ })
}

async function expectReviewCount(page: Page, n: number) {
  if (isPhone(page)) {
    // The phone layout always reads "Review accounts" (the count lives in the summary).
    await expect(reviewButton(page)).toHaveAccessibleName('Review accounts')
  } else {
    await expect(reviewButton(page)).toHaveAccessibleName(n === 1 ? 'Review 1 account' : `Review ${n} accounts`)
  }
}

test.describe('home — demo first paint', () => {
  let errors: string[]
  test.beforeEach(async ({ page }) => {
    errors = collectErrors(page)
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: /Clean up\.\s*Get your SOL back\./ })).toBeVisible()
  })

  test.afterEach(() => {
    expect(errors, 'no console errors').toEqual([])
  })

  test('shows the demo counts, the demo chip and the preview values', async ({ page }) => {
    await expect(tileNumber(page, 'mint')).toHaveText('24')
    await expect(tileNumber(page, 'neutral')).toHaveText('6')
    await expect(tileNumber(page, 'rose')).toHaveText('1')
    await expect(page.getByText('Demo estimates', { exact: true })).toBeVisible()

    await expect(page.getByRole('tab', { name: 'Eligible (24)' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('tab', { name: 'Skipped (7)' })).toBeVisible()

    await expect(previewRow(page, 'Account SOL detected')).toContainText('0.0489')
    await expect(previewRow(page, 'Est. network fee')).toContainText('−0.000013')
    await expect(previewRow(page, 'Service fee')).toContainText('−0.0020')
    await expect(preview(page).getByText('0.0470 SOL')).toBeVisible()
    await expect(preview(page).getByText('Amounts shown are demo estimates.')).toBeVisible()
    await expectReviewCount(page, 24)
    await expect(reviewButton(page)).toBeEnabled()

    // The demo wallet is shown shortened in the scan field and is never a real link.
    await expect(page.getByRole('textbox', { name: 'Solana wallet address' })).toHaveValue(
      'GmaDr7kQ2vNw8XpLs4TfHc9ZyB3uMe6RjWnK5aYqAEGB',
    )
    await expect(page.getByRole('table', { name: 'Eligible accounts' }).getByRole('link')).toHaveCount(0)
  })

  test('unchecking a row updates the Review count and the account SOL', async ({ page }) => {
    const first = page.getByRole('checkbox', { name: 'Select Account 01' })
    await expect(first).toBeChecked()
    await first.uncheck()
    await expect(first).not.toBeChecked()
    await expect(eligibleRows(page).first()).toHaveAttribute('aria-selected', 'false')

    await expectReviewCount(page, 23)
    await expect(previewRow(page, 'Account SOL detected')).toContainText('0.0469')

    // Clicking the row itself toggles it back.
    await eligibleRows(page).first().getByText('Account 01').click()
    await expect(first).toBeChecked()
    await expectReviewCount(page, 24)
    await expect(previewRow(page, 'Account SOL detected')).toContainText('0.0489')
  })

  test('select-all toggles every eligible account', async ({ page }) => {
    if (isPhone(page)) {
      // Phone layout (per the mockup) hides the table header, and with it the
      // select-all box; a compact "Select all / Clear all" button above the
      // rows does the same job.
      await expect(page.getByRole('checkbox', { name: /select all eligible accounts/i })).toBeHidden()
      await expect(page.locator('.acct-bulk')).toContainText('24 of 24 selected')
      await page.getByRole('button', { name: 'Clear all' }).click()
      await expect(page.locator('.acct-bulk')).toContainText('0 of 24 selected')
      await page.getByRole('button', { name: 'View all' }).click()
      await expect(page.getByRole('checkbox', { name: /^Select Account \d+$/, checked: true })).toHaveCount(0)
      await expect(reviewButton(page)).toBeDisabled()
      await expect(preview(page).getByText('Select at least one account to continue.')).toBeVisible()
      await expect(previewRow(page, 'Account SOL detected')).toContainText('0.0000')
      await page.getByRole('checkbox', { name: 'Select Account 07' }).check()
      await expect(reviewButton(page)).toBeEnabled()
      await expect(previewRow(page, 'Account SOL detected')).toContainText('0.0020')
      // Partially selected → the button reads "Select all" and selects everything.
      await page.getByRole('button', { name: 'Select all' }).click()
      await expect(page.getByRole('checkbox', { name: /^Select Account \d+$/, checked: false })).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Clear all' })).toBeVisible()
      await expect(previewRow(page, 'Account SOL detected')).toContainText('0.0489')
      return
    }

    const all = page.getByRole('checkbox', { name: 'Deselect all eligible accounts' })
    await expect(all).toBeChecked()
    await all.uncheck()

    const selectAll = page.getByRole('checkbox', { name: 'Select all eligible accounts' })
    await expect(selectAll).not.toBeChecked()
    await expect(page.getByRole('checkbox', { name: /^Select Account \d+$/, checked: true })).toHaveCount(0)
    await expect(reviewButton(page)).toBeDisabled()
    await expect(preview(page).getByText('Select at least one account to continue.')).toBeVisible()
    await expect(previewRow(page, 'Account SOL detected')).toContainText('0.0000')

    await selectAll.check()
    await expect(page.getByRole('checkbox', { name: 'Deselect all eligible accounts' })).toBeChecked()
    await expect(page.getByRole('checkbox', { name: /^Select Account \d+$/, checked: false })).toHaveCount(0)
    await expectReviewCount(page, 24)
    await expect(reviewButton(page)).toBeEnabled()

    // Partially selected → the header box reads "Select all" and selects everything.
    await page.getByRole('checkbox', { name: 'Select Account 02' }).uncheck()
    await page.getByRole('checkbox', { name: 'Select all eligible accounts' }).check()
    await expectReviewCount(page, 24)
  })

  test('"View all" expands the eligible list to 24 rows', async ({ page }) => {
    await expect(eligibleRows(page)).toHaveCount(4)
    await expect(page.getByText('Showing 4 of 24 eligible accounts')).toBeVisible()

    const more = page.getByRole('button', { name: 'View all' })
    await expect(more).toHaveAttribute('aria-expanded', 'false')
    await more.click()
    await expect(eligibleRows(page)).toHaveCount(24)
    await expect(page.getByText('Showing 24 of 24 eligible accounts')).toBeVisible()
    await expect(page.getByRole('checkbox', { name: 'Select Account 24' })).toBeChecked()

    await page.getByRole('button', { name: 'Show less' }).click()
    await expect(eligibleRows(page)).toHaveCount(4)
  })

  test('Skipped tab lists the 7 skipped accounts with reasons', async ({ page }) => {
    await page.getByRole('tab', { name: 'Skipped (7)' }).click()
    await expect(page.getByRole('tab', { name: 'Skipped (7)' })).toHaveAttribute('aria-selected', 'true')

    const table = page.getByRole('table', { name: 'Skipped accounts' })
    const rows = table.getByRole('row').filter({ has: page.getByRole('cell') })
    await expect(rows).toHaveCount(4)
    await page.getByRole('button', { name: 'View all' }).click()
    await expect(rows).toHaveCount(7)
    await expect(page.getByText('Showing 7 of 7 skipped accounts')).toBeVisible()

    // Skipped rows are never selectable.
    await expect(table.getByRole('checkbox')).toHaveCount(0)

    const withTokens = rows.filter({ hasText: 'Has tokens' })
    await expect(withTokens).toHaveCount(6)
    for (const row of await withTokens.all()) {
      await expect(row).toContainText('Holds tokens — mopi never touches accounts with a balance.')
    }
    const unsupported = rows.filter({ hasText: 'Unsupported' })
    await expect(unsupported).toHaveCount(1)
    await expect(unsupported).toContainText('withheld transfer fees')

    // The balances are shown, e.g. the 1,250-token account.
    await expect(rows.filter({ hasText: '1,250' })).toHaveCount(1)
  })
})

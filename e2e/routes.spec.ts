import { expect, test } from '@playwright/test'
import { collectErrors, horizontalOverflow, isPhone } from './support/page'

// Every hash route: main heading, document title, no console errors, no
// horizontal overflow — in both the desktop (1440) and phone (375) projects.

const ROUTES = [
  { hash: '#/', key: 'clean', heading: /Clean up\.\s*Get your SOL back\./, title: 'mopi — Clean up. Get your SOL back.', primary: 'Clean wallet', quick: 'Clean' },
  { hash: '#/how-it-works', key: 'how-it-works', heading: /Three small steps\.\s*You approve the cleanup\./, title: 'How it works · mopi', primary: 'How it works', quick: null },
  { hash: '#/fees', key: 'fees', heading: /Every fee,\s*shown first\./, title: 'Fees · mopi', primary: 'Fees', quick: null },
  { hash: '#/docs', key: 'docs', heading: /How mopi decides,\s*written down\./, title: 'Docs · mopi', primary: 'Docs', quick: null },
  { hash: '#/benefits', key: 'benefits', heading: /\$MOPI\s*holder access\./, title: '$MOPI benefits · mopi', primary: null, quick: 'Benefits' },
  { hash: '#/wallets', key: 'wallets', heading: /Your wallets,\s*one tap from tidy\./, title: 'Saved wallets · mopi', primary: null, quick: 'Wallets' },
] as const

for (const r of ROUTES) {
  test(`${r.hash} renders its heading and title, without errors or horizontal overflow`, async ({ page }) => {
    const errors = collectErrors(page)
    await page.goto(`/${r.hash}`)

    const h1 = page.getByRole('heading', { level: 1 })
    await expect(h1).toHaveCount(1)
    await expect(h1).toHaveText(r.heading)
    await expect(h1).toBeVisible()
    await expect(page).toHaveTitle(r.title)
    await expect(page.getByRole('main')).toBeVisible()

    // Let fonts and images settle before measuring.
    await page.evaluate(() => (globalThis as unknown as { document: { fonts: { ready: Promise<unknown> } } }).document.fonts.ready)
    await page.waitForLoadState('load')
    expect(await horizontalOverflow(page), 'horizontal overflow (px)').toBe(0)
    // Scrolled to the bottom too (footer, CTA bands).
    await page.evaluate(() => (globalThis as unknown as { scrollTo: (x: number, y: number) => void }).scrollTo(0, 1e6))
    expect(await horizontalOverflow(page), 'horizontal overflow at the bottom (px)').toBe(0)

    const primary = page.getByRole('navigation', { name: 'Primary' })
    const quick = page.getByRole('navigation', { name: 'Quick' })
    if (isPhone(page)) {
      await expect(primary).toBeHidden()
      await expect(quick).toBeVisible()
      await expect(quick.getByRole('link')).toHaveCount(3)
      const current = quick.locator('[aria-current="page"]')
      if (r.quick) {
        await expect(current).toHaveCount(1)
        await expect(current).toHaveAccessibleName(r.quick)
      } else {
        await expect(current).toHaveCount(0)
      }
    } else {
      await expect(quick).toBeHidden()
      await expect(primary).toBeVisible()
      const current = primary.locator('[aria-current="page"]')
      if (r.primary) {
        await expect(current).toHaveCount(1)
        await expect(current).toHaveText(r.primary)
      } else {
        await expect(current).toHaveCount(0)
      }
    }

    expect(errors).toEqual([])
  })
}

test('header navigation moves between routes and updates the active link and title', async ({ page }) => {
  const errors = collectErrors(page)
  await page.goto('/')

  if (isPhone(page)) {
    // Phone: the burger menu lists every route; the bottom bar covers Clean / Wallets / Benefits.
    await page.getByRole('button', { name: 'Open menu' }).click()
    const menu = page.getByRole('navigation', { name: 'Menu' })
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('link', { name: 'Clean wallet' })).toHaveAttribute('aria-current', 'page')
    await menu.getByRole('link', { name: 'Fees' }).click()
    await expect(page).toHaveURL(/#\/fees$/)
    await expect(page).toHaveTitle('Fees · mopi')
    await expect(menu).toBeHidden()

    const quick = page.getByRole('navigation', { name: 'Quick' })
    await quick.getByRole('link', { name: 'Wallets' }).click()
    await expect(page).toHaveTitle('Saved wallets · mopi')
    await expect(quick.getByRole('link', { name: 'Wallets' })).toHaveAttribute('aria-current', 'page')
    await expect(quick.getByRole('link', { name: 'Clean' })).not.toHaveAttribute('aria-current', /.*/)
    await quick.getByRole('link', { name: 'Clean' }).click()
    await expect(page).toHaveTitle('mopi — Clean up. Get your SOL back.')
    await expect(quick.getByRole('link', { name: 'Clean' })).toHaveAttribute('aria-current', 'page')
  } else {
    const nav = page.getByRole('navigation', { name: 'Primary' })
    await expect(nav.getByRole('link', { name: 'Clean wallet' })).toHaveAttribute('aria-current', 'page')
    for (const [label, hash, title] of [
      ['How it works', '#/how-it-works', 'How it works · mopi'],
      ['Fees', '#/fees', 'Fees · mopi'],
      ['Docs', '#/docs', 'Docs · mopi'],
      ['Clean wallet', '#/', 'mopi — Clean up. Get your SOL back.'],
    ] as const) {
      await nav.getByRole('link', { name: label }).click()
      await expect(page).toHaveURL(new RegExp(`${hash.replace(/[/#]/g, '\\$&')}$`))
      await expect(page).toHaveTitle(title)
      await expect(nav.locator('[aria-current="page"]')).toHaveCount(1)
      await expect(nav.getByRole('link', { name: label })).toHaveAttribute('aria-current', 'page')
    }
  }

  expect(errors).toEqual([])
})

test('an unknown route falls back to the clean page', async ({ page }) => {
  await page.goto('/#/does-not-exist')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Clean up\./)
  await expect(page).toHaveTitle('mopi — Clean up. Get your SOL back.')
})

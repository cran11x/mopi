import type { Page } from '@playwright/test'

/** True for the 375px project (the app's phone layout starts at ≤ 720px). */
export function isPhone(page: Page): boolean {
  return (page.viewportSize()?.width ?? 1440) <= 720
}

/** Collects console errors and uncaught page errors from now on. */
export function collectErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`)
  })
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`))
  return errors
}

/** Horizontal overflow in CSS px (0 = none). */
export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const doc = (globalThis as unknown as { document: { documentElement: { scrollWidth: number } } }).document
    const win = globalThis as unknown as { innerWidth: number }
    return Math.max(0, doc.documentElement.scrollWidth - win.innerWidth)
  })
}

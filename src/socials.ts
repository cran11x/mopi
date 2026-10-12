import type { IconName } from './components/ui/Icon'

// Community links and the $MOPI contract address are env-driven so the operator
// only sets env vars after launch. Unset or invalid values render nothing.
// The contract address itself comes from CONFIG.mopiMint (src/config.ts).

/**
 * Accepts only absolute https URLs with a host and no embedded credentials.
 * Anything else (http:, javascript:, data:, relative paths, junk) returns null
 * so a typo in the env can never put an unsafe link on the page.
 */
export function readHttpsUrl(value: string | undefined | null): string | null {
  if (typeof value !== 'string') return null
  const raw = value.trim()
  if (raw === '' || /[\s\u0000-\u001f\u007f]/.test(raw)) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null
  return url.href
}

function readEnvUrl(name: string, value: string | undefined): string | null {
  const url = readHttpsUrl(value)
  if (value && value.trim() !== '' && !url) console.warn(`[mopi] ignoring invalid ${name} (https URLs only): ${value}`)
  return url
}

export interface SocialLink {
  key: 'x' | 'telegram'
  /** Visible name, e.g. in the mobile menu. */
  name: string
  /** Accessible label for icon-only links. */
  label: string
  /** Visible call to action next to the icon (mobile menu). */
  cta: string
  icon: IconName
  href: string
}

export function buildSocialLinks(env: { x?: string | null; telegram?: string | null }): SocialLink[] {
  const links: SocialLink[] = []
  const x = readHttpsUrl(env.x)
  const telegram = readHttpsUrl(env.telegram)
  if (x) links.push({ key: 'x', name: 'X', label: 'mopi on X', cta: 'Follow on X', icon: 'x', href: x })
  if (telegram) links.push({ key: 'telegram', name: 'Telegram', label: 'mopi on Telegram', cta: 'Join Telegram', icon: 'telegram', href: telegram })
  return links
}

/** Configured social links, in display order. Empty when none are set. */
export const SOCIAL_LINKS: readonly SocialLink[] = buildSocialLinks({
  x: readEnvUrl('VITE_X_URL', import.meta.env.VITE_X_URL),
  telegram: readEnvUrl('VITE_TELEGRAM_URL', import.meta.env.VITE_TELEGRAM_URL),
})

/** Solscan token page for a mint. $MOPI lives on mainnet, so no cluster suffix. */
export function tokenExplorerUrl(mint: string): string {
  return `https://solscan.io/token/${encodeURIComponent(mint)}`
}

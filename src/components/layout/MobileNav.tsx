import { routeHref, useRoute, type Route } from '../../lib/router'
import { Icon, type IconName } from '../ui'
import './MobileNav.css'

const TABS: Array<{ route: Route; label: string; icon: IconName }> = [
  { route: 'clean', label: 'Clean', icon: 'search' },
  { route: 'wallets', label: 'Wallets', icon: 'wallet' },
  { route: 'benefits', label: 'Benefits', icon: 'star' },
]

/** Phone-only bottom tab bar (≤ 720px). */
export function MobileNav() {
  const { route } = useRoute()
  return (
    <nav className="mobile-nav" aria-label="Quick">
      <ul>
        {TABS.map((t) => (
          <li key={t.route}>
            <a href={routeHref(t.route)} className="mobile-nav__tab" aria-current={route === t.route ? 'page' : undefined}>
              <Icon name={t.icon} size={22} />
              <span>{t.label}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}

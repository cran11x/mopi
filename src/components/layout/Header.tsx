import { useEffect, useRef, useState } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { CLUSTER_LABELS } from '../../config'
import { shortAddress } from '../../lib/format'
import { ROUTE_LABELS, routeHref, useRoute, type Route } from '../../lib/router'
import type { Cluster } from '../../lib/types'
import { useCluster } from '../../state/cluster'
import { useWalletModal } from '../../state/walletModal'
import { Logo } from '../mascot/Mascot'
import { Button, Icon, SolanaMark, cx, type IconName } from '../ui'
import { ConnectButton } from './ConnectButton'
import { NetworkSelect } from './NetworkSelect'
import './Header.css'

const PRIMARY: Route[] = ['clean', 'how-it-works', 'fees', 'docs']
const MOBILE_LINKS: Array<{ route: Route; icon: IconName }> = [
  { route: 'clean', icon: 'search' },
  { route: 'how-it-works', icon: 'sparkle' },
  { route: 'fees', icon: 'doc' },
  { route: 'docs', icon: 'info' },
  { route: 'benefits', icon: 'star' },
  { route: 'wallets', icon: 'wallet' },
]

export function Header() {
  const { route } = useRoute()
  const [menuOpen, setMenuOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  const headerRef = useRef<HTMLElement>(null)
  const burgerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 4)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  // Close the mobile panel on navigation.
  useEffect(() => {
    setMenuOpen(false)
  }, [route])

  useEffect(() => {
    if (!menuOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuOpen(false)
        burgerRef.current?.focus()
      }
    }
    const onPointer = (e: PointerEvent) => {
      if (headerRef.current && !headerRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    const mq = window.matchMedia('(min-width: 721px)')
    const onMq = () => mq.matches && setMenuOpen(false)
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer)
    mq.addEventListener('change', onMq)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer)
      mq.removeEventListener('change', onMq)
    }
  }, [menuOpen])

  return (
    <header ref={headerRef} className={cx('site-header', (scrolled || menuOpen) && 'is-raised')}>
      <div className="container site-header__bar">
        <a href={routeHref('clean')} className="site-header__logo" aria-label="mopi home">
          <span className="site-header__logo-md">
            <Logo />
          </span>
          <span className="site-header__logo-sm">
            <Logo size="sm" />
          </span>
        </a>

        <nav className="site-nav" aria-label="Primary">
          <ul>
            {PRIMARY.map((r) => (
              <li key={r}>
                <a href={routeHref(r)} className="site-nav__link" aria-current={route === r ? 'page' : undefined}>
                  {ROUTE_LABELS[r]}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="site-header__actions site-header__actions--desktop">
          <NetworkSelect variant="pill" />
          <ConnectButton variant="full" />
        </div>

        <div className="site-header__actions site-header__actions--mobile">
          <NetworkSelect variant="icon" />
          <ConnectButton variant="icon" />
          <button
            ref={burgerRef}
            type="button"
            className="hicon hicon--plain"
            aria-expanded={menuOpen}
            aria-controls="mobile-menu"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <Icon name={menuOpen ? 'close' : 'menu'} size={22} />
          </button>
        </div>
      </div>

      {menuOpen && <MobilePanel route={route} onClose={() => setMenuOpen(false)} />}
    </header>
  )
}

function MobilePanel({ route, onClose }: { route: Route; onClose: () => void }) {
  const { cluster, setCluster } = useCluster()
  const { publicKey, disconnect } = useWallet()
  const { open: openModal } = useWalletModal()
  const firstRef = useRef<HTMLAnchorElement>(null)

  useEffect(() => {
    firstRef.current?.focus()
  }, [])

  return (
    <div id="mobile-menu" className="mobile-panel">
      <nav className="container" aria-label="Menu">
        <ul className="mobile-panel__links">
          {MOBILE_LINKS.map(({ route: r, icon }, i) => (
            <li key={r}>
              <a
                ref={i === 0 ? firstRef : undefined}
                href={routeHref(r)}
                className="mobile-panel__link"
                aria-current={route === r ? 'page' : undefined}
                onClick={onClose}
              >
                <Icon name={icon} size={20} />
                <span>{ROUTE_LABELS[r]}</span>
                <Icon name="arrow-right" size={16} className="mobile-panel__arrow" />
              </a>
            </li>
          ))}
        </ul>

        <div className="mobile-panel__group">
          <p className="mobile-panel__label" id="mobile-network-label">
            Network
          </p>
          <div className="mobile-panel__seg" role="radiogroup" aria-labelledby="mobile-network-label">
            {(['mainnet-beta', 'devnet'] as Cluster[]).map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={cluster === c}
                className="mobile-panel__seg-btn"
                onClick={() => setCluster(c)}
              >
                <SolanaMark size={16} />
                {CLUSTER_LABELS[c]}
              </button>
            ))}
          </div>
        </div>

        <div className="mobile-panel__group">
          {publicKey ? (
            <div className="mobile-panel__wallet">
              <span className="mobile-panel__connected">
                <Icon name="wallet" size={18} />
                <span className="mono">{shortAddress(publicKey.toBase58())}</span>
              </span>
              <Button variant="secondary" size="sm" iconLeft="logout" onClick={() => void disconnect().catch(() => {})}>
                Disconnect
              </Button>
            </div>
          ) : (
            <Button
              block
              iconLeft="wallet"
              onClick={() => {
                onClose()
                openModal()
              }}
            >
              Connect wallet
            </Button>
          )}
          <p className="mobile-panel__note">Read-only scans · You approve every transaction</p>
        </div>
      </nav>
    </div>
  )
}

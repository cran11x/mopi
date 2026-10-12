import { useEffect, useLayoutEffect, useRef } from 'react'
import { AppProviders } from './state/AppProviders'
import { useRoute, type Route } from './lib/router'
import { HomePage } from './pages/HomePage'
import { HowItWorksPage } from './pages/HowItWorksPage'
import { FeesPage } from './pages/FeesPage'
import { DocsPage } from './pages/DocsPage'
import { BenefitsPage } from './pages/BenefitsPage'
import { WalletsPage } from './pages/WalletsPage'
import { Header } from './components/layout/Header'
import { Footer } from './components/layout/Footer'
import { MobileNav } from './components/layout/MobileNav'
import { WalletModal } from './components/layout/WalletModal'
import { WatchlistSync } from './components/layout/WatchlistSync'
import './components/layout/shell.css'

const TITLES: Record<Route, string> = {
  clean: 'mopi — Clean up. Get your SOL back.',
  'how-it-works': 'How it works · mopi',
  fees: 'Fees · mopi',
  docs: 'Docs · mopi',
  benefits: '$MOPI benefits · mopi',
  wallets: 'Saved wallets · mopi',
}

function RoutePage({ route }: { route: Route }) {
  switch (route) {
    case 'how-it-works':
      return <HowItWorksPage />
    case 'fees':
      return <FeesPage />
    case 'docs':
      return <DocsPage />
    case 'benefits':
      return <BenefitsPage />
    case 'wallets':
      return <WalletsPage />
    default:
      return <HomePage />
  }
}

const prefersReducedMotion = () => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

function Shell() {
  const { route, anchor } = useRoute()
  const mainRef = useRef<HTMLElement>(null)
  const firstRender = useRef(true)
  const lastRoute = useRef(route)

  useEffect(() => {
    document.title = TITLES[route]
  }, [route])

  // Scroll to top on route change, or to the requested in-page section.
  useLayoutEffect(() => {
    const routeChanged = lastRoute.current !== route
    lastRoute.current = route
    const isFirst = firstRender.current
    firstRender.current = false

    if (anchor) {
      // Let the page render its sections first.
      const raf = requestAnimationFrame(() => {
        const el = document.getElementById(anchor)
        if (!el) return
        el.scrollIntoView({ behavior: isFirst || routeChanged || prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' })
        if (!isFirst) {
          if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1')
          el.focus({ preventScroll: true })
        }
      })
      return () => cancelAnimationFrame(raf)
    }
    if (routeChanged) {
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior })
      mainRef.current?.focus({ preventScroll: true })
    }
  }, [route, anchor])

  return (
    <div className="app-shell">
      <a href="#content" className="skip-link" onClick={(e) => {
        e.preventDefault()
        mainRef.current?.focus()
        mainRef.current?.scrollIntoView()
      }}>
        Skip to content
      </a>
      <Header />
      <main id="content" ref={mainRef} tabIndex={-1} className="app-main">
        <RoutePage route={route} />
      </main>
      <Footer />
      <MobileNav />
      <WalletModal />
      <WatchlistSync />
    </div>
  )
}

export function App() {
  return (
    <AppProviders>
      <Shell />
    </AppProviders>
  )
}

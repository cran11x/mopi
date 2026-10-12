import { Suspense, lazy, useEffect, useLayoutEffect, useRef, useState, type ComponentType } from 'react'
import { AppProviders } from './state/AppProviders'
import { useWalletModal } from './state/walletModal'
import { parseHash, useRoute, type Route } from './lib/router'
import { HomePage } from './pages/HomePage'
import { Header } from './components/layout/Header'
import { Footer } from './components/layout/Footer'
import { MobileNav } from './components/layout/MobileNav'
import { WatchlistSync } from './components/layout/WatchlistSync'
import './components/layout/shell.css'

// The home page is the first paint and ships in the entry chunk. The
// secondary pages and the wallet picker load on demand (and are prefetched on
// link hover/focus), which keeps their JS and CSS off the critical path.
const PAGE_LOADERS = {
  'how-it-works': () => import('./pages/HowItWorksPage').then((m) => ({ default: m.HowItWorksPage })),
  fees: () => import('./pages/FeesPage').then((m) => ({ default: m.FeesPage })),
  docs: () => import('./pages/DocsPage').then((m) => ({ default: m.DocsPage })),
  benefits: () => import('./pages/BenefitsPage').then((m) => ({ default: m.BenefitsPage })),
  wallets: () => import('./pages/WalletsPage').then((m) => ({ default: m.WalletsPage })),
} satisfies Partial<Record<Route, () => Promise<{ default: ComponentType }>>>

const HowItWorksPage = lazy(PAGE_LOADERS['how-it-works'])
const FeesPage = lazy(PAGE_LOADERS.fees)
const DocsPage = lazy(PAGE_LOADERS.docs)
const BenefitsPage = lazy(PAGE_LOADERS.benefits)
const WalletsPage = lazy(PAGE_LOADERS.wallets)
const WalletModal = lazy(() => import('./components/layout/WalletModal').then((m) => ({ default: m.WalletModal })))

function prefetchRoute(route: Route) {
  const load = (PAGE_LOADERS as Partial<Record<Route, () => Promise<unknown>>>)[route]
  load?.().catch(() => {})
}

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

/** Mounted once the picker has been asked for; stays mounted so it can animate/close normally. */
function LazyWalletModal() {
  const { visible } = useWalletModal()
  const [wanted, setWanted] = useState(visible)
  if (visible && !wanted) setWanted(true)
  if (!wanted) return null
  return (
    <Suspense fallback={null}>
      <WalletModal />
    </Suspense>
  )
}

const prefersReducedMotion = () => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/**
 * Scrolls to `#anchor` once it exists (retrying for up to ~2 s while a lazy
 * page loads) and optionally moves focus there. Returns a cancel function.
 */
function scrollToAnchor(anchor: string, { smooth, focus }: { smooth: boolean; focus: boolean }): () => void {
  let raf = 0
  const deadline = performance.now() + 2000
  const attempt = () => {
    const el = document.getElementById(anchor)
    if (!el) {
      if (performance.now() < deadline) raf = requestAnimationFrame(attempt)
      return
    }
    el.scrollIntoView({ behavior: smooth && !prefersReducedMotion() ? 'smooth' : 'auto', block: 'start' })
    if (focus) {
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1')
      el.focus({ preventScroll: true })
    }
  }
  // Let the page render its sections first.
  raf = requestAnimationFrame(attempt)
  return () => cancelAnimationFrame(raf)
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
      // A lazily loaded page renders its sections a little later; wait for the target.
      return scrollToAnchor(anchor, { smooth: !(isFirst || routeChanged), focus: !isFirst })
    }
    if (routeChanged) {
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior })
      mainRef.current?.focus({ preventScroll: true })
    }
  }, [route, anchor])

  // Links to the section already in the URL don't fire hashchange; scroll anyway.
  // Hovering/focusing an internal link prefetches that page's chunk.
  useEffect(() => {
    const internalLink = (e: Event) =>
      e.target instanceof Element ? e.target.closest<HTMLAnchorElement>('a[href^="#/"]') : null
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const link = internalLink(e)
      if (!link) return
      const target = parseHash(link.getAttribute('href') ?? '')
      const current = parseHash(window.location.hash)
      if (!target.anchor || target.route !== current.route || target.anchor !== current.anchor) return
      e.preventDefault()
      scrollToAnchor(target.anchor, { smooth: true, focus: true })
    }
    const onIntent = (e: Event) => {
      const link = internalLink(e)
      if (link) prefetchRoute(parseHash(link.getAttribute('href') ?? '').route)
    }
    document.addEventListener('click', onClick)
    document.addEventListener('pointerover', onIntent, { passive: true })
    document.addEventListener('focusin', onIntent)
    return () => {
      document.removeEventListener('click', onClick)
      document.removeEventListener('pointerover', onIntent)
      document.removeEventListener('focusin', onIntent)
    }
  }, [])

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
        <Suspense fallback={<div className="page container" style={{ minHeight: '70vh' }} aria-busy="true" />}>
          <RoutePage route={route} />
        </Suspense>
      </main>
      <Footer />
      <MobileNav />
      <LazyWalletModal />
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

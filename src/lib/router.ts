import { useEffect, useState } from 'react'

// Tiny hash router — the app is a static SPA, so hash routes work on any host.

export type Route = 'clean' | 'how-it-works' | 'fees' | 'docs' | 'benefits' | 'wallets'

export const ROUTES: Route[] = ['clean', 'how-it-works', 'fees', 'docs', 'benefits', 'wallets']

export const ROUTE_LABELS: Record<Route, string> = {
  clean: 'Clean wallet',
  'how-it-works': 'How it works',
  fees: 'Fees',
  docs: 'Docs',
  benefits: 'Benefits',
  wallets: 'Wallets',
}

export function routeHref(route: Route, anchor?: string): string {
  const base = route === 'clean' ? '#/' : `#/${route}`
  return anchor ? `${base}?s=${encodeURIComponent(anchor)}` : base
}

export function parseHash(hash: string): { route: Route; anchor: string | null } {
  const raw = hash.replace(/^#\/?/, '')
  const [path, query = ''] = raw.split('?')
  const route = (ROUTES as string[]).includes(path) ? (path as Route) : 'clean'
  const anchor = new URLSearchParams(query).get('s')
  return { route, anchor }
}

export function navigate(route: Route, anchor?: string): void {
  window.location.hash = routeHref(route, anchor)
}

export function useRoute(): { route: Route; anchor: string | null } {
  const [state, setState] = useState(() => parseHash(window.location.hash))
  useEffect(() => {
    const onChange = () => setState(parseHash(window.location.hash))
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return state
}

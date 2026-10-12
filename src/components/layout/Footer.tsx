import { routeHref } from '../../lib/router'
import './Footer.css'

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="container site-footer__inner">
        <p className="site-footer__brand">
          <strong>mopi</strong>
          <span aria-hidden="true"> · </span>
          <span className="sr-only">, </span>
          small cleaner, useful little finds.
        </p>
        <nav className="site-footer__links" aria-label="Footer">
          <a href={routeHref('how-it-works')}>How it works</a>
          <span aria-hidden="true">·</span>
          <a href={routeHref('fees')}>Fees</a>
          <span aria-hidden="true">·</span>
          <a href={routeHref('docs')}>Docs</a>
        </nav>
        <p className="site-footer__note">Read-only scans · You approve every transaction</p>
      </div>
    </footer>
  )
}

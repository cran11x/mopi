import { CONFIG } from '../../config'
import { routeHref } from '../../lib/router'
import { SOCIAL_LINKS, tokenExplorerUrl } from '../../socials'
import { Icon } from '../ui'
import { CopyAddress } from '../ui/CopyAddress'
import './Footer.css'

export function Footer() {
  const mint = CONFIG.mopiMint
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
          {SOCIAL_LINKS.length > 0 && (
            <span className="site-footer__social">
              {SOCIAL_LINKS.map((l) => (
                <a
                  key={l.key}
                  href={l.href}
                  className="site-footer__icon"
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={l.label}
                  title={l.label}
                >
                  <Icon name={l.icon} size={16} />
                </a>
              ))}
            </span>
          )}
        </nav>
        <p className="site-footer__note">Read-only scans · You approve every transaction</p>
        {mint && (
          <div className="site-footer__ca">
            <CopyAddress address={mint} tag="CA" what="$MOPI contract address" href={tokenExplorerUrl(mint)} />
          </div>
        )}
      </div>
    </footer>
  )
}

import { CONFIG } from '../../config'
import { useCleaner } from '../../state/cleaner'
import { routeHref } from '../../lib/router'
import { Icon, cx } from '../ui'
import { CopyAddress } from '../ui/CopyAddress'
import { Mascot } from '../mascot/Mascot'
import './HolderBanner.css'

export function HolderBanner({ className }: { className?: string }) {
  const { holder } = useCleaner()
  const planned = !holder.mintConfigured

  return (
    <section className={cx('holder', holder.isHolder && 'holder--active', className)} aria-labelledby="holder-title">
      <Mascot pose="head" width={60} decorative className="holder__mascot" />
      <h2 id="holder-title" className="holder__title">
        {holder.isHolder ? (
          <>
            You have <strong>holder access</strong>
          </>
        ) : (
          <>
            <strong>$MOPI</strong> holder access
          </>
        )}
      </h2>
      {planned && <span className="holder__planned">Planned</span>}
      <p className="holder__text">
        {holder.isHolder
          ? 'Lower service fee applied. Saved wallet watchlists unlocked.'
          : 'Lower service fee. Saved wallet watchlists.'}
      </p>
      {CONFIG.mopiMint && (
        <CopyAddress address={CONFIG.mopiMint} tag="CA" what="$MOPI contract address" className="holder__ca" />
      )}
      <a className="holder__cta" href={routeHref('benefits')}>
        View benefits
        <Icon name="arrow-right" size={14} />
      </a>
    </section>
  )
}

import { Icon, cx } from '../ui'
import { Mascot } from '../mascot/Mascot'
import './ExplainsCard.css'

export function ExplainsCard({ className }: { className?: string }) {
  return (
    <aside className={cx('explains', className)} aria-labelledby="explains-title">
      <div className="explains__body">
        <h2 id="explains-title" className="explains__title">
          <span className="explains__bulb" aria-hidden="true">
            <Icon name="bulb" size={26} strokeWidth={1.6} />
          </span>
          Mopi explains
        </h2>
        <p className="explains__text">
          These accounts hold zero tokens. Closing an eligible account returns its stored SOL.
        </p>
      </div>
      <Mascot pose="explain" width={132} decorative className="explains__mascot" />
    </aside>
  )
}

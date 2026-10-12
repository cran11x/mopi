import { routeHref } from '../../lib/router'
import { Icon, cx, type IconName } from '../ui'
import './HowStrip.css'

const ITEMS: Array<{ icon: IconName; title: string; text: string }> = [
  { icon: 'search', title: 'Scan', text: 'Read public account data.' },
  { icon: 'doc', title: 'Review', text: 'Choose accounts and see every fee.' },
  { icon: 'shield', title: 'Approve', text: 'Confirm the proposed transaction in your wallet.' },
]

export function HowStrip({ className }: { className?: string }) {
  return (
    <section className={cx('how', className)} aria-labelledby="how-title">
      <h2 id="how-title" className="sr-only">
        How a cleanup works
      </h2>
      <ul className="how__list">
        {ITEMS.map((item) => (
          <li key={item.title} className="how__item">
            <Icon name={item.icon} size={34} strokeWidth={1.6} className="how__icon" />
            <span className="how__body">
              <span className="how__title">{item.title}</span>
              <span className="how__text">{item.text}</span>
            </span>
          </li>
        ))}
      </ul>
      <a className="link how__link" href={routeHref('docs', 'supported')}>
        See supported accounts
        <Icon name="arrow-right" size={14} />
      </a>
    </section>
  )
}

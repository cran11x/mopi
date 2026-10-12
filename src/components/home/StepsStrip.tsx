import { cx } from '../ui'
import './StepsStrip.css'

const STEPS = [
  { n: '01', label: 'scan', text: 'Read public account data.' },
  { n: '02', label: 'review', text: 'Choose accounts and see every fee.' },
  { n: '03', label: 'approve in wallet', text: 'Confirm the proposed transaction in your wallet.' },
]

export function StepsStrip({ className }: { className?: string }) {
  return (
    <ol className={cx('steps', className)} aria-label="Three steps">
      {STEPS.map((s) => (
        <li key={s.n} className="steps__item">
          <span className="steps__num" aria-hidden="true">
            {s.n}
          </span>
          <span className="steps__body">
            <span className="steps__label">{s.label}</span>
            <span className="steps__text">{s.text}</span>
          </span>
        </li>
      ))}
    </ol>
  )
}

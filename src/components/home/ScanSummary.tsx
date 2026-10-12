import { useCleaner } from '../../state/cleaner'
import { Chip, cx } from '../ui'
import './ScanSummary.css'

export function ScanSummary({ className }: { className?: string }) {
  const { scan, scanStatus } = useCleaner()
  const scanning = scanStatus === 'scanning'

  const eligible = scan?.eligible.length ?? 0
  const withTokens = scan?.withTokens.length ?? 0
  const unsupported = scan?.unsupported.length ?? 0
  const has = Boolean(scan) && !scanning

  const tiles = [
    {
      key: 'eligible',
      n: eligible,
      long: eligible === 1 ? 'eligible account' : 'eligible accounts',
      plural: 'eligible accounts',
      short: 'eligible',
      tone: 'mint',
    },
    {
      key: 'tokens',
      n: withTokens,
      long: withTokens === 1 ? 'account with tokens' : 'accounts with tokens',
      plural: 'accounts with tokens',
      short: 'with tokens',
      tone: 'neutral',
    },
    {
      key: 'unsupported',
      n: unsupported,
      long: unsupported === 1 ? 'unsupported account' : 'unsupported accounts',
      plural: 'unsupported accounts',
      short: 'unsupported',
      tone: 'rose',
    },
  ] as const

  return (
    <div className={cx('scan-summary', className)}>
      <div className="scan-summary__head">
        <h3 className="scan-summary__title">Scan results</h3>
        {scan?.isDemo && !scanning && <Chip tone="cream">Demo estimates</Chip>}
        <p className="scan-summary__scope">
          <span className="home-wide">Only empty, supported accounts close.</span>
          <span className="home-narrow">Only empty accounts close.</span>
        </p>
      </div>

      <ul className="scan-summary__tiles" aria-busy={scanning || undefined}>
        {tiles.map((t) => (
          <li key={t.key} className={cx('scan-summary__tile', `scan-summary__tile--${t.tone}`)}>
            <span
              className={cx('scan-summary__num', 'tabular', !has && 'scan-summary__num--empty', scanning && 'scan-summary__skel')}
              aria-hidden={!has || undefined}
            >
              {has ? t.n : scanning ? '' : '–'}
            </span>
            <span className="scan-summary__label">
              <span className="home-wide">{has ? t.long : t.plural}</span>
              <span className="home-narrow">{t.short}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

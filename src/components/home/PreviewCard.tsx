import { useCleaner } from '../../state/cleaner'
import { CONFIG } from '../../config'
import { formatBps, formatSol } from '../../lib/format'
import { isExampleServiceFee } from '../../lib/demo'
import { loadReviewModal } from '../review/loadReviewModal'
import { Icon, InfoTip, cx } from '../ui'
import { Mascot } from '../mascot/Mascot'
import './PreviewCard.css'

function Amount({ lamports, minus }: { lamports: number; minus?: boolean }) {
  return (
    <span className="preview__amount tabular">
      <strong>{formatSol(lamports, { decimals: 4, sign: minus ? 'always-minus' : 'auto' })}</strong>
      <span className="preview__unit">SOL</span>
    </span>
  )
}

export function PreviewCard({ className }: { className?: string }) {
  const { quote, scan, scanStatus, holder, feeConfig, openReview, cleanup } = useCleaner()
  const isDemo = Boolean(scan?.isDemo)
  const scanning = scanStatus === 'scanning'
  const count = quote?.accountCount ?? 0
  const bps = quote?.serviceFeeBps ?? feeConfig.serviceFeeBps
  const noServiceFee = Boolean(quote) && !isDemo && (quote!.serviceFeeBps === 0 || !feeConfig.feeWallet)
  const ready = Boolean(quote) && count > 0 && !scanning
  // The amount counts selected accounts only; say so once the selection is partial.
  const eligibleTotal = scan?.eligible.length ?? 0
  const partial = Boolean(scan) && !scanning && eligibleTotal > 0 && count < eligibleTotal

  const holderNote = holder.isHolder
    ? ''
    : ` $MOPI holders pay ${formatBps(CONFIG.holderFeeBps)}${holder.mintConfigured ? '' : ' (planned)'}.`
  // Demo on a deployment with no fee wallet: the fee is illustrative only.
  const exampleFee = isExampleServiceFee(feeConfig)
  const feeTip = exampleFee
    ? `Example only — this deployment charges no service fee. With a fee wallet set, ${formatBps(bps)} of the account SOL returned would go to mopi.`
    : `${formatBps(bps)} of the account SOL returned${
        holder.isHolder ? ', holder rate' : ''
      } — sent to mopi in the same transaction and shown in your wallet before you approve.${holderNote}`

  const note = !scan
    ? 'Scan a wallet to see an estimate.'
    : isDemo
      ? 'Amounts shown are demo estimates.'
      : 'Final amounts appear in your wallet before you approve.'

  return (
    <section className={cx('preview', className)} aria-labelledby="preview-title">
      <div className="preview__head">
        <h2 id="preview-title" className="preview__title">
          <span className="home-wide">Your cleanup preview</span>
          <span className="home-narrow">Cleanup preview</span>
        </h2>
        <Mascot pose="head" width={52} decorative className="preview__mascot" />
      </div>

      <dl className={cx('preview__rows', scanning && 'is-loading')} aria-busy={scanning || undefined}>
        <div className={cx('preview__row', partial && 'preview__row--partial')}>
          <dt>
            Account SOL detected
            {partial && (
              <span className="preview__sel tabular">
                {count} of {eligibleTotal} selected
              </span>
            )}
          </dt>
          <dd>
            <Amount lamports={quote?.reclaimLamports ?? 0} />
          </dd>
        </div>
        <div className="preview__row">
          <dt>Est. network fee</dt>
          <dd>
            <Amount lamports={quote?.networkFeeLamports ?? 0} minus />
          </dd>
        </div>
        <div className="preview__row">
          <dt>
            Service fee
            {exampleFee && <span className="preview__example">(example)</span>}
            {!noServiceFee && <InfoTip label="About the service fee" content={feeTip} />}
            {holder.isHolder && <span className="preview__holder">holder rate</span>}
          </dt>
          <dd>
            {noServiceFee ? (
              <span className="preview__none">none</span>
            ) : (
              <Amount lamports={quote?.serviceFeeLamports ?? 0} minus />
            )}
          </dd>
        </div>
      </dl>

      <div className="preview__total">
        <span className="preview__total-label">Estimated return</span>
        <span className="preview__total-value tabular" aria-live="polite">
          {formatSol(quote?.netLamports ?? 0, { decimals: 4 })} SOL
        </span>
      </div>
      <p className="preview__note">{note}</p>

      <button
        type="button"
        className="btn btn--primary btn--lg btn--block preview__cta"
        disabled={!ready || cleanup.phase === 'executing'}
        onClick={openReview}
        onPointerEnter={() => void loadReviewModal().catch(() => {})}
        onFocus={() => void loadReviewModal().catch(() => {})}
      >
        <span className="home-wide">
          {count > 0 ? `Review ${count} ${count === 1 ? 'account' : 'accounts'}` : 'Review accounts'}
        </span>
        <span className="home-narrow">Review accounts</span>
        <Icon name="arrow-right" size={18} />
      </button>
      <p className="preview__caption">
        {scan && count === 0 && !scanning && scan.eligible.length > 0
          ? 'Select at least one account to continue.'
          : 'Approval happens in your wallet.'}
      </p>
    </section>
  )
}

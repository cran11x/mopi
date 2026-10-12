import { useCallback, type ReactNode } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { useCleaner } from '../../state/cleaner'
import { useCluster } from '../../state/cluster'
import { useWalletModal } from '../../state/walletModal'
import { explorerTxUrl } from '../../config'
import { formatBps, formatSol, shortAddress } from '../../lib/format'
import type { BatchProgress, BatchStatus, CleanupQuote } from '../../lib/types'
import { Button, Icon, Modal, cx, type IconName } from '../ui'
import { Mascot } from '../mascot/Mascot'
import './ReviewModal.css'

const sol = (lamports: number, minus = false) =>
  `${formatSol(lamports, { decimals: 4, sign: minus ? 'always-minus' : 'auto' })} SOL`

/** A base58 public key is 32–44 chars; anything else (e.g. the demo placeholder) is labelled plainly. */
function walletLabel(address: string | null): string {
  if (!address) return 'mopi'
  if (address.length < 32) return 'demo fee wallet'
  return shortAddress(address)
}

export function ReviewModal() {
  const { cleanup, closeReview, resetCleanup, openReview, scan } = useCleaner()
  const { phase } = cleanup
  const open = phase !== 'idle'
  const executing = phase === 'executing'

  const onClose = useCallback(() => {
    if (phase === 'done') resetCleanup()
    else closeReview()
  }, [phase, resetCleanup, closeReview])

  const title =
    phase === 'review'
      ? 'Review cleanup'
      : phase === 'executing'
        ? cleanup.isDemoRun
          ? 'Running demo…'
          : 'Cleaning up…'
        : phase === 'done'
          ? cleanup.isDemoRun
            ? 'Demo run'
            : 'Cleanup complete'
          : 'Cleanup didn’t finish'

  return (
    <Modal open={open} onClose={onClose} title={title} dismissible={!executing}>
      <div className="review">
        {phase === 'review' && <ReviewStep />}
        {phase === 'executing' && <ProgressStep />}
        {phase === 'done' && <DoneStep onDone={resetCleanup} />}
        {phase === 'error' && (
          <div className="review__error-wrap">
            <p className="review__error" role="alert">
              <Icon name="alert" size={18} />
              <span>{cleanup.error ?? 'Something went wrong.'}</span>
            </p>
            {cleanup.progress.length > 0 && <ProgressList progress={cleanup.progress} />}
            <p className="review__fine">Nothing was closed unless a transaction above shows “Confirmed”.</p>
            <div className="review__actions">
              <Button variant="secondary" onClick={closeReview}>
                Close
              </Button>
              <Button variant="primary" onClick={openReview} disabled={!scan} iconRight="refresh">
                Try again
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}

/* ---------- Review ---------- */

function ReviewStep() {
  const { quote, scan, feeConfig, executeBlocker, startCleanup, closeReview, runScan } = useCleaner()
  const wallet = useWallet()
  const walletModal = useWalletModal()
  if (!quote || !scan) return null

  const connected = wallet.publicKey?.toBase58() ?? null
  const n = quote.accountCount
  const hasFee = quote.serviceFeeLamports > 0

  let action: ReactNode
  let blockerNote: ReactNode = null
  switch (executeBlocker) {
    case 'demo':
      action = (
        <Button variant="primary" onClick={() => void startCleanup()} iconRight="arrow-right">
          Run demo (nothing is sent)
        </Button>
      )
      blockerNote = 'This is the demo wallet. The run is simulated in your browser — no wallet prompt, no transaction.'
      break
    case 'not-connected':
      action = (
        <Button variant="primary" onClick={walletModal.open} iconLeft="wallet">
          Connect wallet
        </Button>
      )
      blockerNote = `Connect the wallet that owns ${shortAddress(scan.owner)} to approve this cleanup.`
      break
    case 'wrong-wallet':
      action = connected ? (
        <Button variant="primary" onClick={() => void runScan(connected)} iconLeft="search">
          Scan connected wallet
        </Button>
      ) : null
      blockerNote = (
        <>
          The connected wallet doesn’t own these accounts. You scanned {shortAddress(scan.owner)}
          {connected ? <> but connected {shortAddress(connected)}</> : null}.
        </>
      )
      break
    case 'wallet-cannot-sign':
      action = (
        <Button variant="primary" disabled>
          Approve in wallet
        </Button>
      )
      blockerNote = 'This wallet can’t sign transactions here. Try another wallet that supports transaction signing.'
      break
    case 'nothing-selected':
      action = (
        <Button variant="primary" disabled>
          Approve in wallet
        </Button>
      )
      blockerNote = 'Select at least one eligible account first.'
      break
    default:
      action = (
        <Button variant="primary" onClick={() => void startCleanup()} iconRight="arrow-right">
          Approve in wallet
        </Button>
      )
  }

  return (
    <>
      <dl className="review__summary">
        <Row label="Accounts to close" value={String(n)} />
        <Row label="Account SOL" value={sol(quote.reclaimLamports)} />
        <Row label="Est. network fee" value={sol(quote.networkFeeLamports, true)} />
        <Row
          label={`Service fee${hasFee ? ` (${formatBps(quote.serviceFeeBps)}${quote.isHolderRate ? ', holder rate' : ''})` : ''}`}
          value={hasFee ? sol(quote.serviceFeeLamports, true) : 'none'}
        />
        <div className="review__summary-total">
          <dt>Estimated return</dt>
          <dd className="tabular">{sol(quote.netLamports)}</dd>
        </div>
      </dl>
      {scan.isDemo && <p className="review__fine">Demo estimates — based on a sample wallet.</p>}

      <h3 className="review__h3">What you’ll sign</h3>
      <ul className="review__sign">
        <SignItem icon="check">
          Close {n} empty token {n === 1 ? 'account' : 'accounts'}
        </SignItem>
        <SignItem icon="wallet">Their account SOL returns to {shortAddress(scan.owner)}</SignItem>
        {hasFee && (
          <SignItem icon="doc">
            Service fee {sol(quote.serviceFeeLamports)} to mopi ({walletLabel(feeConfig.feeWallet)})
          </SignItem>
        )}
        <SignItem icon="shield">Nothing else — no token transfers, no approvals or delegations.</SignItem>
      </ul>

      <h3 className="review__h3">
        {quote.batches.length === 1 ? '1 transaction' : `${quote.batches.length} transactions`}
      </h3>
      <Batches quote={quote} />

      {blockerNote && (
        <p className={cx('review__blocker', executeBlocker === 'demo' && 'review__blocker--info')} role="status">
          <Icon name={executeBlocker === 'demo' ? 'info' : 'alert'} size={16} />
          <span>{blockerNote}</span>
        </p>
      )}

      <div className="review__actions">
        <Button variant="secondary" onClick={closeReview}>
          Cancel
        </Button>
        {action}
      </div>
      {executeBlocker === null && (
        <p className="review__fine review__fine--center">Your wallet shows the final amounts before you approve.</p>
      )}
    </>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="review__summary-row">
      <dt>{label}</dt>
      <dd className="tabular">{value}</dd>
    </div>
  )
}

function SignItem({ icon, children }: { icon: IconName; children: ReactNode }) {
  return (
    <li>
      <span className="review__sign-icon" aria-hidden="true">
        <Icon name={icon} size={15} strokeWidth={2} />
      </span>
      <span>{children}</span>
    </li>
  )
}

function Batches({ quote }: { quote: CleanupQuote }) {
  const total = quote.batches.length
  return (
    <ol className="review__batches">
      {quote.batches.map((b) => {
        const ret = Math.max(0, b.reclaimLamports - b.serviceFeeLamports - b.networkFeeLamports)
        return (
          <li key={b.index}>
            <details className="review__batch">
              <summary>
                <span className="review__batch-title">
                  Transaction {b.index + 1} of {total}
                  <span className="review__dot" aria-hidden="true">
                    ·
                  </span>
                  {b.accounts.length} {b.accounts.length === 1 ? 'account' : 'accounts'}
                </span>
                <span className="review__batch-ret tabular">returns {sol(ret)}</span>
                <Icon name="chevron-down" size={16} className="review__chev" />
              </summary>
              <ul className="review__addrs">
                {b.accounts.map((a) => (
                  <li key={a.address} className="mono" title={a.address}>
                    {shortAddress(a.address)}
                  </li>
                ))}
              </ul>
            </details>
          </li>
        )
      })}
    </ol>
  )
}

/* ---------- Executing ---------- */

const STATUS: Record<BatchStatus, { label: string; icon: IconName | 'spin' | 'dot'; tone: string }> = {
  pending: { label: 'Pending', icon: 'dot', tone: 'muted' },
  simulating: { label: 'Simulating…', icon: 'spin', tone: 'busy' },
  'awaiting-signature': { label: 'Waiting for your approval in wallet', icon: 'wallet', tone: 'wait' },
  sending: { label: 'Sending…', icon: 'spin', tone: 'busy' },
  confirmed: { label: 'Confirmed', icon: 'check', tone: 'ok' },
  failed: { label: 'Failed', icon: 'close', tone: 'bad' },
  skipped: { label: 'Skipped', icon: 'dot', tone: 'muted' },
}

function ProgressStep() {
  const { cleanup } = useCleaner()
  return (
    <>
      <p className="review__lead">
        {cleanup.isDemoRun
          ? 'Simulating the cleanup. Nothing is sent and no wallet prompt appears.'
          : 'Keep this window open. Approve each prompt in your wallet.'}
      </p>
      {cleanup.progress.length === 0 ? (
        <p className="review__preparing" role="status" aria-live="polite">
          <span className="review__spinner" aria-hidden="true" /> Preparing transactions…
        </p>
      ) : (
        <ProgressList progress={cleanup.progress} />
      )}
    </>
  )
}

function ProgressList({ progress }: { progress: BatchProgress[] }) {
  const { cluster } = useCluster()
  const { cleanup } = useCleaner()
  const total = progress.length
  return (
    <ol className="review__progress" aria-live="polite">
      {progress.map((p) => {
        const s = STATUS[p.status]
        return (
          <li key={p.index} className={cx('review__step', `review__step--${s.tone}`)}>
            <span className="review__step-icon" aria-hidden="true">
              {s.icon === 'spin' ? (
                <span className="review__spinner" />
              ) : s.icon === 'dot' ? (
                <span className="review__dotmark" />
              ) : (
                <Icon name={s.icon} size={14} strokeWidth={2.2} />
              )}
            </span>
            <span className="review__step-body">
              <span className="review__step-title">
                Transaction {p.index + 1} of {total}
                <span className="review__step-meta">
                  {' '}
                  · {p.accountCount} {p.accountCount === 1 ? 'account' : 'accounts'} · {sol(p.reclaimLamports)} account SOL
                </span>
              </span>
              <span className="review__step-status">
                {s.label}
                {p.status === 'confirmed' && cleanup.isDemoRun && ' (demo)'}
                {p.signature && (
                  <a
                    className="review__tx"
                    href={explorerTxUrl(p.signature, cluster)}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    View transaction
                    <Icon name="external" size={13} />
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                )}
              </span>
              {p.error && <span className="review__step-error">{p.error}</span>}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/* ---------- Done ---------- */

function DoneStep({ onDone }: { onDone: () => void }) {
  const { cleanup } = useCleaner()
  const { cluster } = useCluster()
  const r = cleanup.result
  if (!r) return null
  const total = r.confirmedBatches + r.failedBatches

  return (
    <div className="review__done">
      <Mascot pose="happy" width={150} decorative className="review__done-mascot" />
      <p className="review__done-title" role="status">
        {cleanup.isDemoRun ? 'Demo complete — nothing was sent.' : `${sol(r.returnedLamports)} returned to your wallet`}
      </p>
      <p className="review__done-sub">
        {cleanup.isDemoRun ? (
          <>
            A real run would return about <strong className="tabular">{sol(r.returnedLamports)}</strong> after fees.
          </>
        ) : (
          <>
            {r.confirmedBatches} of {total} {total === 1 ? 'transaction' : 'transactions'} confirmed
            {r.failedBatches > 0 && <> · {r.failedBatches} failed — those accounts were left untouched</>}.
          </>
        )}
      </p>
      {r.signatures.length > 0 && (
        <ul className="review__sigs">
          {r.signatures.map((sig, i) => (
            <li key={sig}>
              <a href={explorerTxUrl(sig, cluster)} target="_blank" rel="noreferrer noopener" className="review__tx">
                Transaction {i + 1}: <span className="mono">{shortAddress(sig, 6, 6)}</span>
                <Icon name="external" size={13} />
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </li>
          ))}
        </ul>
      )}
      <div className="review__actions review__actions--center">
        <Button variant="primary" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  )
}

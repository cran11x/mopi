import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { FEE_WALLET_UNFUNDED_MESSAGE, STOP_WAITING_AFTER_MS, useCleaner } from '../../state/cleaner'
import { useCluster } from '../../state/cluster'
import { useWalletModal } from '../../state/walletModal'
import { explorerTxUrl } from '../../config'
import { formatBps, formatSol, shortAddress } from '../../lib/format'
import { isExampleServiceFee } from '../../lib/demo'
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

/** Start of MESSAGES.walletModified (execute.ts is loaded lazily, so it is matched by text, not imported). */
const WALLET_MODIFIED_PREFIX = 'Your wallet changed the transaction'

/** Focus target on close when "Review" is gone or disabled (e.g. a refresh found nothing left). */
const focusScanField = () => document.querySelector<HTMLElement>('.scan-form input')

export function ReviewModal() {
  const { cleanup, closeReview, resetCleanup, openReview, runScan, scan } = useCleaner()
  const { phase } = cleanup
  const open = phase !== 'idle'
  const executing = phase === 'executing'
  // Errors that mean the scan is out of date (tokens arrived, account closed or
  // frozen, owner changed…) all say "rescan": retrying the same quote would just
  // fail again, so offer a fresh scan instead.
  const failures = [cleanup.error, ...cleanup.progress.map((p) => (p.status === 'failed' ? p.error : null))].filter(
    (e): e is string => typeof e === 'string',
  )
  const needsRescan = phase === 'error' && failures.some((e) => /rescan/i.test(e))
  // The wallet changes every transaction it signs (a fee override or tx
  // protection setting): retrying as-is gives the same result, so don't offer it.
  const walletChangesTx = phase === 'error' && failures.length > 0 && failures.every((e) => e.startsWith(WALLET_MODIFIED_PREFIX))

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
    <Modal open={open} onClose={onClose} title={title} dismissible={!executing} returnFocus={focusScanField}>
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
            {cleanup.progress.length > 0 && <ProgressList progress={cleanup.progress} hideError={cleanup.error} />}
            <p className="review__fine">Nothing was closed unless a transaction above shows “Confirmed”.</p>
            <div className="review__actions">
              <Button variant="secondary" onClick={closeReview}>
                Close
              </Button>
              {walletChangesTx ? null : needsRescan ? (
                <Button
                  variant="primary"
                  disabled={!scan}
                  iconLeft="refresh"
                  onClick={() => {
                    if (!scan) return
                    closeReview()
                    void runScan(scan.owner)
                  }}
                >
                  Rescan wallet
                </Button>
              ) : (
                <Button variant="primary" onClick={openReview} disabled={!scan} iconRight="refresh">
                  Try again
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}

/* ---------- Review ---------- */

function ReviewStep() {
  const { quote, scan, feeConfig, executeBlocker, startCleanup, closeReview, runScan, checkingFees, quoteNotice } =
    useCleaner()
  const wallet = useWallet()
  const walletModal = useWalletModal()
  if (!quote || !scan) return null

  const connected = wallet.publicKey?.toBase58() ?? null
  const n = quote.accountCount
  const hasFee = quote.serviceFeeLamports > 0
  const exampleFee = isExampleServiceFee(feeConfig)

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
    case 'fee-wallet-unfunded':
      action = (
        <Button variant="primary" disabled>
          Approve in wallet
        </Button>
      )
      blockerNote = FEE_WALLET_UNFUNDED_MESSAGE
      break
    case 'stale-scan':
      action = (
        <Button variant="primary" onClick={() => void runScan(scan.owner)} iconLeft="refresh">
          Rescan wallet
        </Button>
      )
      blockerNote = 'These results are from another network or are still refreshing. Rescan before approving.'
      break
    case null:
      // Disabled while current network fees / the fee wallet are being checked,
      // so what gets approved is always the final quote.
      action = (
        <Button
          variant="primary"
          onClick={() => void startCleanup()}
          iconRight="arrow-right"
          disabled={checkingFees}
          aria-describedby={checkingFees ? 'review-checking' : undefined}
        >
          Approve in wallet
        </Button>
      )
      break
    default: {
      // Compile-time exhaustiveness: a new blocker must get its own case.
      const unhandled: never = executeBlocker
      throw new Error(`Unhandled execute blocker: ${String(unhandled)}`)
    }
  }

  return (
    <>
      <dl className="review__summary">
        <Row label="Accounts to close" value={String(n)} />
        <Row label="Account SOL" value={sol(quote.reclaimLamports)} />
        <Row label="Est. network fee" value={sol(quote.networkFeeLamports, true)} />
        <Row
          label={`Service fee${
            hasFee
              ? ` (${exampleFee ? 'example, ' : ''}${formatBps(quote.serviceFeeBps)}${quote.isHolderRate ? ', holder rate' : ''})`
              : ''
          }`}
          value={hasFee ? sol(quote.serviceFeeLamports, true) : 'none'}
        />
        <div className="review__summary-total">
          <dt>Estimated return</dt>
          <dd className="tabular">{sol(quote.netLamports)}</dd>
        </div>
      </dl>
      {(scan.isDemo || (exampleFee && hasFee)) && (
        <p className="review__fine">
          {scan.isDemo && 'Demo estimates — based on a sample wallet.'}
          {scan.isDemo && exampleFee && hasFee && ' '}
          {exampleFee && hasFee && 'The service fee is an example; this deployment charges none.'}
        </p>
      )}

      <h3 className="review__h3">What you’ll sign</h3>
      <ul className="review__sign">
        <SignItem icon="check">
          Close {n} empty token {n === 1 ? 'account' : 'accounts'}
        </SignItem>
        <SignItem icon="wallet">Their account SOL returns to {shortAddress(scan.owner)}</SignItem>
        {hasFee && (
          <SignItem icon="doc">
            {`${exampleFee ? 'Example service fee' : 'Service fee'} ${sol(quote.serviceFeeLamports)} to mopi (${walletLabel(feeConfig.feeWallet)})`}
          </SignItem>
        )}
        <SignItem icon="shield">Nothing else — no token transfers, no approvals or delegations.</SignItem>
      </ul>

      <h3 className="review__h3">
        {quote.batches.length === 1 ? '1 transaction' : `${quote.batches.length} transactions`}
      </h3>
      <Batches quote={quote} />

      {quoteNotice && executeBlocker === null && (
        <p className="review__blocker" role="alert">
          <Icon name="alert" size={16} />
          <span>{quoteNotice}</span>
        </p>
      )}

      {blockerNote && (
        <p
          className={cx('review__blocker', executeBlocker === 'demo' && 'review__blocker--info')}
          role={executeBlocker === 'fee-wallet-unfunded' ? 'alert' : 'status'}
        >
          <Icon name={executeBlocker === 'demo' ? 'info' : 'alert'} size={16} />
          <span>{blockerNote}</span>
        </p>
      )}

      {/* On phones this footer sticks to the bottom of the scrolling sheet so the
          main action never hides below the batch list. */}
      <div className="review__footer">
        <div className="review__actions">
          <Button variant="secondary" onClick={closeReview}>
            Cancel
          </Button>
          {action}
        </div>
        {executeBlocker === null &&
          (checkingFees ? (
            <p className="review__fine review__fine--center" id="review-checking" role="status">
              Checking current network fees…
            </p>
          ) : (
            <p className="review__fine review__fine--center">Your wallet shows the final amounts before you approve.</p>
          ))}
      </div>
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
                  <span className="sr-only">, </span>
                  {b.accounts.length} {b.accounts.length === 1 ? 'account' : 'accounts'}
                </span>
                <span className="sr-only">, </span>
                <span className="review__batch-ret tabular">{sol(ret)} back to you</span>
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
  const { cleanup, stopCleanup } = useCleaner()
  // A wallet prompt that never returns, or a confirmation that takes long,
  // must not trap the user in a dialog that can't be closed.
  const [canStop, setCanStop] = useState(false)
  useEffect(() => {
    if (cleanup.isDemoRun) return
    const timer = setTimeout(() => setCanStop(true), STOP_WAITING_AFTER_MS)
    return () => clearTimeout(timer)
  }, [cleanup.isDemoRun])
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
      {canStop && (
        <div className="review__actions">
          <Button variant="secondary" onClick={stopCleanup}>
            Stop waiting
          </Button>
        </div>
      )}
    </>
  )
}

/** `hideError`: a message already shown in the step's alert — not repeated per transaction. */
function ProgressList({ progress, hideError }: { progress: BatchProgress[]; hideError?: string | null }) {
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
                {p.status === 'sending' && p.signature ? 'Confirming…' : s.label}
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
              {p.error && p.error !== hideError && <span className="review__step-error">{p.error}</span>}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/* ---------- Done ---------- */

function DoneStep({ onDone }: { onDone: () => void }) {
  const { cleanup, feeConfig } = useCleaner()
  const exampleFee = isExampleServiceFee(feeConfig)
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
            {exampleFee ? `With the example ${formatBps(feeConfig.serviceFeeBps)} fee, a real run` : 'A real run'} would
            return about <strong className="tabular">{sol(r.returnedLamports)}</strong> after fees.
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

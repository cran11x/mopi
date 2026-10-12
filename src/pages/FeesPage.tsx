import { useMemo } from 'react'
import { CONFIG } from '../config'
import { formatBps, formatSol } from '../lib/format'
import { routeHref } from '../lib/router'
import { EXAMPLE_ACCOUNT_LAMPORTS, exampleQuote, illustrativeFeeConfig } from '../lib/examples'
import { CtaBand, LinkButton, Page, PageIntro, Section } from '../components/layout/Page'
import { Card, Chip, Icon, type IconName } from '../components/ui'
import './FeesPage.css'

const EXAMPLE_COUNTS = [1, 5, 24, 60]

const sol = (lamports: number) => formatSol(lamports)

export function FeesPage() {
  const { isPlaceholder } = illustrativeFeeConfig()
  const noFee = CONFIG.feeWallet === null
  const standard = formatBps(CONFIG.serviceFeeBps)
  const holderRate = formatBps(CONFIG.holderFeeBps)
  const holderLive = Boolean(CONFIG.mopiMint)
  const rows = useMemo(() => EXAMPLE_COUNTS.map((n) => ({ n, q: exampleQuote(n) })), [])
  const fullTxNetwork = rows.find((r) => r.n === CONFIG.maxClosesPerTx)?.q.networkFeeLamports ?? exampleQuote(CONFIG.maxClosesPerTx).networkFeeLamports

  return (
    <Page className="fees">
      <PageIntro
        eyebrow="Fees"
        title="Every fee,"
        accent="shown first."
        lede="Before anything reaches your wallet, mopi shows the account SOL it found, what the network charges and what mopi keeps. Here’s exactly how it adds up."
        mascot="explain"
        bubble="No surprises."
      >
        <Chip tone="outline">
          <Icon name="doc" size={14} /> Fees shown before you approve
        </Chip>
        <Chip tone="outline">
          <Icon name="shield" size={14} /> Fee paid inside the cleanup transaction
        </Chip>
      </PageIntro>

      {noFee && (
        <p className="fees__nofee" role="note">
          <Icon name="check" size={18} />
          <span>
            <strong>This deployment charges no service fee.</strong> You only pay the Solana network fee. The examples
            below use the standard {standard} fee for illustration.
          </span>
        </p>
      )}

      <div className="page-grid-3 fees__cards">
        <Card className="fees__card">
          <div className="fees__card-head">
            <span className="page-icon-tile">
              <Icon name="broom" size={22} />
            </span>
            <h2 className="page-card-title">Service fee</h2>
          </div>
          <p className="fees__big">
            {noFee ? '0%' : standard}
            <span className="fees__big-unit">of returned account SOL</span>
          </p>
          <p className="page-muted fees__copy">
            {noFee
              ? `Off in this deployment. When a fee wallet is set, the standard rate is ${standard}.`
              : 'Paid to mopi inside the same transaction, as one visible transfer. Nothing is charged up front.'}
          </p>
          <p className="fees__holder">
            <Icon name="star" size={16} />
            <span>
              $MOPI holders: <strong>{holderRate}</strong>
            </span>
            {!holderLive && <Chip tone="cream">Planned</Chip>}
          </p>
        </Card>

        <Card className="fees__card">
          <div className="fees__card-head">
            <span className="page-icon-tile">
              <SolGlyph />
            </span>
            <h2 className="page-card-title">Network fee</h2>
          </div>
          <p className="fees__big">
            {CONFIG.baseFeeLamportsPerSignature.toLocaleString('en-US')}
            <span className="fees__big-unit">lamports per signature</span>
          </p>
          <p className="page-muted fees__copy">
            Plus a small priority fee so the transaction lands. One signature covers a transaction of up to{' '}
            {CONFIG.maxClosesPerTx} accounts — about {sol(fullTxNetwork)} SOL for a full one.
          </p>
          <p className="fees__holder fees__holder--quiet">
            <Icon name="info" size={16} />
            <span>Goes to Solana validators, not to mopi.</span>
          </p>
        </Card>

        <Card className="fees__card" tone="mint">
          <div className="fees__card-head">
            <span className="page-icon-tile fees__tile-white">
              <Icon name="wallet" size={22} />
            </span>
            <h2 className="page-card-title">Account SOL</h2>
          </div>
          <p className="fees__big fees__big--money">
            ≈ {sol(EXAMPLE_ACCOUNT_LAMPORTS)}
            <span className="fees__big-unit">SOL per token account</span>
          </p>
          <p className="fees__copy fees__copy--ink">
            Not a fee — it’s the deposit every token account holds. Closing an empty account sends it back to your
            wallet.
          </p>
          <p className="fees__holder fees__holder--quiet">
            <Icon name="sparkle" size={16} />
            <span>Token-2022 accounts may hold a little more.</span>
          </p>
        </Card>
      </div>

      <Section
        id="examples"
        eyebrow="Examples"
        title="What a cleanup looks like"
        intro={
          <>
            Computed live with mopi’s own fee math at {EXAMPLE_ACCOUNT_LAMPORTS.toLocaleString('en-US')} lamports per
            account
            {isPlaceholder ? `, with the standard ${standard} fee for illustration.` : '.'}
          </>
        }
      >
        <div className="fees-table-wrap">
          <table className="fees-table">
            <caption className="sr-only">
              Estimated fees and return by number of accounts
              {isPlaceholder ? `, with the standard ${standard} fee for illustration` : ''}
            </caption>
            <thead>
              <tr>
                <th scope="col">Accounts</th>
                <th scope="col">Transactions</th>
                <th scope="col">Account SOL</th>
                <th scope="col">Network fee</th>
                <th scope="col">Service fee ({formatBps(rows[0].q.serviceFeeBps)})</th>
                <th scope="col">You receive</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ n, q }) => (
                <tr key={n}>
                  <th scope="row" data-label="Accounts">
                    <span className="fees-table__count">{n}</span>
                    <span className="fees-table__unit">{n === 1 ? 'account' : 'accounts'}</span>
                  </th>
                  <td data-label="Transactions" className="tabular">
                    {q.batches.length}
                  </td>
                  <td data-label="Account SOL" className="tabular">
                    <span>
                      {sol(q.reclaimLamports)} <span className="fees-table__sol">SOL</span>
                    </span>
                  </td>
                  <td data-label="Network fee" className="tabular fees-table__minus">
                    <span>
                      {formatSol(q.networkFeeLamports, { sign: 'always-minus' })} <span className="fees-table__sol">SOL</span>
                    </span>
                  </td>
                  <td data-label="Service fee" className="tabular fees-table__minus">
                    <span>
                      {formatSol(q.serviceFeeLamports, { sign: 'always-minus' })} <span className="fees-table__sol">SOL</span>
                    </span>
                  </td>
                  <td data-label="You receive" className="tabular fees-table__net">
                    <span>
                      {sol(q.netLamports)} <span className="fees-table__sol">SOL</span>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="fees__table-note">
          <Icon name="info" size={16} />
          Estimates. Your wallet shows the final numbers before you sign.
        </p>
      </Section>

      <Section id="good-to-know" eyebrow="Good to know" title="The small print, in plain words">
        <ul className="page-grid-2 fees__points">
          {POINTS.map((p) => (
            <li key={p.title} className="fees__point">
              <span className="page-icon-tile">
                <Icon name={p.icon} size={20} />
              </span>
              <div>
                <h3 className="fees__point-title">{p.title}</h3>
                <p className="page-muted">{p.body}</p>
              </div>
            </li>
          ))}
        </ul>
      </Section>

      <CtaBand title="See what your wallet is holding." copy="Scans are read-only and free. Fees only apply to accounts you close.">
        <LinkButton href={routeHref('clean')} iconRight={<Icon name="arrow-right" size={18} />}>
          Scan a wallet
        </LinkButton>
        <LinkButton href={routeHref('how-it-works')} variant="secondary">
          How it works
        </LinkButton>
      </CtaBand>
    </Page>
  )
}

const POINTS: Array<{ icon: IconName; title: string; body: string }> = [
  {
    icon: 'search',
    title: 'No fee when nothing is closed',
    body: 'Scanning, reviewing and cancelling are free. The service fee only exists inside a cleanup transaction you approve.',
  },
  {
    icon: 'shield',
    title: 'In the same transaction, visible in your wallet',
    body: 'The fee is a single transfer next to the CloseAccount instructions, so your wallet shows it before you sign.',
  },
  {
    icon: 'doc',
    title: 'Estimates until your wallet shows the final transaction',
    body: 'mopi’s numbers come from the scan. If an account changes before you sign, the transaction is re-checked first.',
  },
  {
    icon: 'star',
    title: 'A lower rate for $MOPI holders',
    body: CONFIG.mopiMint
      ? `Holding at least ${CONFIG.holderMin.toLocaleString('en-US')} $MOPI in the connected wallet lowers the service fee from ${formatBps(CONFIG.serviceFeeBps)} to ${formatBps(CONFIG.holderFeeBps)}.`
      : `Holder access is planned to lower the service fee from ${formatBps(CONFIG.serviceFeeBps)} to ${formatBps(CONFIG.holderFeeBps)}. It applies once the operator configures the $MOPI mint.`,
  },
]

function SolGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d="M6.2 16.2a.8.8 0 0 1 .56-.23H21l-3.2 3.2a.8.8 0 0 1-.56.23H3l3.2-3.2Z" />
      <path d="M6.2 4.83A.8.8 0 0 1 6.76 4.6H21l-3.2 3.2a.8.8 0 0 1-.56.23H3l3.2-3.2Z" />
      <path d="M17.8 10.5a.8.8 0 0 0-.56-.23H3l3.2 3.2a.8.8 0 0 0 .56.23H21l-3.2-3.2Z" />
    </svg>
  )
}

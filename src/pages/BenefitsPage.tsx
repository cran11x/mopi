import { useWallet } from '@solana/wallet-adapter-react'
import { CONFIG } from '../config'
import { formatBps, formatSol, shortAddress } from '../lib/format'
import { routeHref } from '../lib/router'
import { buildQuote } from '../lib/solana/fees'
import { useCleaner } from '../state/cleaner'
import { useWalletModal } from '../state/walletModal'
import { LinkButton, Page, PageIntro, Section } from '../components/layout/Page'
import { Button, Card, Chip, Icon } from '../components/ui'
import { CopyAddress } from '../components/ui/CopyAddress'
import { tokenExplorerUrl } from '../socials'
import { exampleAccounts, illustrativeFeeConfig } from '../lib/examples'
import './BenefitsPage.css'

const fmtTokens = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 })

export function BenefitsPage() {
  const live = Boolean(CONFIG.mopiMint)
  const standard = formatBps(CONFIG.serviceFeeBps)
  const holderRate = formatBps(CONFIG.holderFeeBps)

  const { fee } = illustrativeFeeConfig()
  const accounts = exampleAccounts(24)
  const stdQuote = buildQuote(accounts, { ...fee, serviceFeeBps: CONFIG.serviceFeeBps })
  const holderQuote = buildQuote(accounts, { ...fee, serviceFeeBps: CONFIG.holderFeeBps })

  return (
    <Page className="benefits">
      <PageIntro
        eyebrow="Benefits"
        title="$MOPI"
        accent="holder access."
        lede={
          live
            ? 'Two small perks for people who tidy up often: a lower service fee and saved wallet watchlists. They apply automatically to wallets that hold $MOPI.'
            : 'Two small perks for people who tidy up often: a lower service fee and saved wallet watchlists. Both are planned for $MOPI holders.'
        }
        mascot="happy"
        bubble={live ? 'Thanks for sticking around!' : 'Coming soon.'}
      >
        {live ? (
          <Chip tone="mint">
            <Icon name="check" size={14} /> Live in this build
          </Chip>
        ) : (
          <Chip tone="cream">
            <Icon name="sparkle" size={14} /> Planned
          </Chip>
        )}
        <Chip tone="outline">Min. {fmtTokens(CONFIG.holderMin)} $MOPI</Chip>
      </PageIntro>

      {CONFIG.mopiMint && <ContractAddress mint={CONFIG.mopiMint} />}

      <HolderStatusPanel />

      <div className="page-grid-2 benefits__cards">
        <Card as="article" className="benefit">
          <div className="benefit__head">
            <span className="page-icon-tile">
              <Icon name="broom" size={22} />
            </span>
            <div>
              <h2 className="page-card-title">Lower service fee</h2>
              <p className="page-muted benefit__sub">On every cleanup you approve.</p>
            </div>
          </div>
          <p className="benefit__rate" aria-label={`Service fee goes from ${standard} to ${holderRate}`}>
            <span className="benefit__rate-old">{standard}</span>
            <Icon name="arrow-right" size={26} />
            <span className="benefit__rate-new">{holderRate}</span>
          </p>
          <div className="benefit__compare">
            <p className="benefit__compare-title">Example: 24 empty accounts</p>
            <dl>
              <div>
                <dt>Service fee at {standard}</dt>
                <dd className="tabular">{formatSol(stdQuote.serviceFeeLamports)} SOL</dd>
              </div>
              <div className="is-holder">
                <dt>With holder access ({holderRate})</dt>
                <dd className="tabular">{formatSol(holderQuote.serviceFeeLamports)} SOL</dd>
              </div>
            </dl>
          </div>
        </Card>

        <Card as="article" className="benefit">
          <div className="benefit__head">
            <span className="page-icon-tile">
              <Icon name="wallet" size={22} />
            </span>
            <div>
              <h2 className="page-card-title">Saved wallet watchlists</h2>
              <p className="page-muted benefit__sub">Save wallets and rescan them in one tap.</p>
            </div>
          </div>
          <ul className="benefit__tiers">
            <li>
              <span className="benefit__tier-name">Everyone</span>
              <span className="benefit__tier-value">
                {CONFIG.freeWatchlistLimit} saved wallet{CONFIG.freeWatchlistLimit === 1 ? '' : 's'}
              </span>
            </li>
            <li className="is-holder">
              <span className="benefit__tier-name">
                <Icon name="star" size={14} /> Holders
              </span>
              <span className="benefit__tier-value">Unlimited</span>
            </li>
          </ul>
          <p className="page-muted benefit__note">
            Each saved wallet keeps its last scan — how many accounts were eligible and how much account SOL they held.
            The list stays in your browser.
          </p>
          <LinkButton href={routeHref('wallets')} variant="secondary" size="sm" className="benefit__link" iconRight={<Icon name="arrow-right" size={16} />}>
            Open saved wallets
          </LinkButton>
        </Card>
      </div>

      <Section id="how-access-works" eyebrow="How it works" title="No sign-up, no staking">
        <ol className="page-grid-3 benefits__steps">
          <li>
            <span className="benefits__n">01</span>
            <h3>Hold $MOPI</h3>
            <p>Keep at least {fmtTokens(CONFIG.holderMin)} $MOPI in the wallet you connect to mopi.</p>
          </li>
          <li>
            <span className="benefits__n">02</span>
            <h3>Connect</h3>
            <p>mopi reads that wallet’s $MOPI balance — a public, read-only check. Nothing is signed.</p>
          </li>
          <li>
            <span className="benefits__n">03</span>
            <h3>Perks apply</h3>
            <p>The {holderRate} rate shows in your cleanup preview and the watchlist limit lifts.</p>
          </li>
        </ol>
      </Section>

      <p className="benefits__disclaimer">
        <Icon name="info" size={16} />
        <span>
          $MOPI is a utility token for mopi features. Nothing here is financial advice and no returns are promised.
        </span>
      </p>
    </Page>
  )
}

/** The official $MOPI contract address, with a scam warning. Only rendered once the mint is configured. */
function ContractAddress({ mint }: { mint: string }) {
  return (
    <section className="benefits-ca" aria-labelledby="benefits-ca-title">
      <div className="benefits-ca__head">
        <h2 id="benefits-ca-title" className="benefits-ca__title">
          Official $MOPI contract address
        </h2>
        <a className="benefits-ca__solscan" href={tokenExplorerUrl(mint)} target="_blank" rel="noopener noreferrer">
          Solscan
          <Icon name="external" size={14} />
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      </div>
      <CopyAddress address={mint} tag="CA" what="$MOPI contract address" variant="full" />
      <p className="benefits-ca__note">
        <Icon name="shield" size={16} />
        <span>Always verify the CA here before buying — mopi will never DM you.</span>
      </p>
    </section>
  )
}

function HolderStatusPanel() {
  const { publicKey } = useWallet()
  const { holder } = useCleaner()
  const { open } = useWalletModal()

  if (!CONFIG.mopiMint) {
    return (
      <div className="holder-status holder-status--planned" role="status">
        <span className="holder-status__icon">
          <Icon name="sparkle" size={20} />
        </span>
        <div className="holder-status__text">
          <p className="holder-status__title">
            Holder perks are planned
          </p>
          <p>The $MOPI token isn’t live in this build. Holder perks apply once the operator configures the $MOPI mint.</p>
        </div>
      </div>
    )
  }

  if (!publicKey) {
    return (
      <div className="holder-status" role="status">
        <span className="holder-status__icon">
          <Icon name="wallet" size={20} />
        </span>
        <div className="holder-status__text">
          <p className="holder-status__title">Check your holder access</p>
          <p>Connect the wallet that holds your $MOPI. The check is read-only.</p>
        </div>
        <Button onClick={open} className="holder-status__action">
          Connect wallet
        </Button>
      </div>
    )
  }

  const short = shortAddress(publicKey.toBase58())
  if (!holder.checked) {
    return (
      <div className="holder-status" role="status" aria-live="polite">
        <span className="holder-status__icon">
          <Icon name="refresh" size={20} />
        </span>
        <div className="holder-status__text">
          <p className="holder-status__title">Checking {short}…</p>
          <p>Reading the $MOPI balance for this wallet.</p>
        </div>
      </div>
    )
  }

  if (holder.isHolder) {
    return (
      <div className="holder-status holder-status--active" role="status" aria-live="polite">
        <span className="holder-status__icon">
          <Icon name="check" size={20} />
        </span>
        <div className="holder-status__text">
          <p className="holder-status__title">
            Holder access is on <Chip tone="mint">Holder</Chip>
          </p>
          <p>
            <span className="mono">{short}</span> holds {fmtTokens(holder.balanceUi)} $MOPI. Your cleanups use the{' '}
            {formatBps(CONFIG.holderFeeBps)} rate.
          </p>
        </div>
      </div>
    )
  }

  const missing = Math.max(0, holder.minRequired - holder.balanceUi)
  const pct = holder.minRequired > 0 ? Math.min(100, (holder.balanceUi / holder.minRequired) * 100) : 0
  return (
    <div className="holder-status" role="status" aria-live="polite">
      <span className="holder-status__icon">
        <Icon name="star" size={20} />
      </span>
      <div className="holder-status__text">
        <p className="holder-status__title">Not holder access yet</p>
        <p>
          <span className="mono">{short}</span> holds {fmtTokens(holder.balanceUi)} of {fmtTokens(holder.minRequired)}{' '}
          $MOPI needed ({fmtTokens(missing)} to go).
        </p>
        <div
          className="holder-status__meter"
          role="progressbar"
          aria-label="$MOPI held toward holder access"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct)}
        >
          <span style={{ width: `${pct}%` }} />
        </div>
      </div>
    </div>
  )
}

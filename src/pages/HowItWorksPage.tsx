import { CONFIG } from '../config'
import { formatBps, formatSol } from '../lib/format'
import { routeHref } from '../lib/router'
import { CtaBand, LinkButton, Page, PageIntro, Section } from '../components/layout/Page'
import { Mascot } from '../components/mascot/Mascot'
import { Card, Chip, Icon, type IconName } from '../components/ui'
import { EXAMPLE_ACCOUNT_LAMPORTS, exampleQuote, illustrativeFeeConfig } from '../lib/examples'
import './HowItWorksPage.css'

interface Step {
  n: string
  title: string
  summary: string
  icon: IconName
  chips: string[]
  points: Array<{ title: string; body: string }>
}

const STEPS: Step[] = [
  {
    n: '01',
    title: 'scan',
    summary: 'Read public account data.',
    icon: 'search',
    chips: ['SPL Token', 'Token-2022', 'Nothing signed'],
    points: [
      {
        title: 'Public data only',
        body: 'mopi asks a Solana RPC node for every token account your address owns (getTokenAccountsByOwner), once for SPL Token and once for Token-2022.',
      },
      {
        title: 'No connection needed',
        body: 'You can scan any address. Nothing is signed, nothing is sent, and no permission is requested.',
      },
      {
        title: 'Sorted for you',
        body: 'Each account lands in one of three groups: eligible, holding tokens, or unsupported.',
      },
    ],
  },
  {
    n: '02',
    title: 'review',
    summary: 'Choose accounts and see every fee.',
    icon: 'doc',
    chips: ['0 tokens only', 'Every fee listed', 'Pick what to close'],
    points: [
      {
        title: 'What makes an account eligible',
        body: 'It holds exactly 0 tokens, your wallet owns it and can close it, it isn’t frozen, and it carries no Token-2022 extension mopi can’t handle safely.',
      },
      {
        title: 'What gets skipped, and why',
        body: 'Accounts with any balance are never touched. Frozen accounts, accounts another address controls, and ones with withheld transfer fees are listed with a plain reason.',
      },
      {
        title: 'Every fee, before you approve',
        body: 'Account SOL found, estimated network fee, service fee and what you get back — all on one card, updated as you select.',
      },
    ],
  },
  {
    n: '03',
    title: 'approve in wallet',
    summary: 'Confirm the proposed transaction in your wallet.',
    icon: 'shield',
    chips: [`Up to ${CONFIG.maxClosesPerTx} per transaction`, 'Simulated first', 'Checked after signing'],
    points: [
      {
        title: 'Only what you expect',
        body: 'Each transaction holds CloseAccount instructions, at most one service-fee transfer and the standard compute-budget settings for the network fee. Nothing else.',
      },
      {
        title: 'Batched and simulated',
        body: `Accounts are grouped up to ${CONFIG.maxClosesPerTx} per transaction. Every transaction is simulated before your wallet is asked to sign.`,
      },
      {
        title: 'Verified again after signing',
        body: 'Once your wallet signs, mopi checks the transaction is still exactly what you reviewed before sending it.',
      },
    ],
  },
]

const NEVER: Array<{ icon: IconName; text: string }> = [
  { icon: 'lock', text: 'Never moves your tokens or NFTs' },
  { icon: 'shield', text: 'Never asks for token approvals or delegations' },
  { icon: 'alert', text: 'Never asks for your seed phrase or private key' },
  { icon: 'broom', text: 'Never closes an account that holds a balance' },
]

export function HowItWorksPage() {
  const { isPlaceholder } = illustrativeFeeConfig()
  const q = exampleQuote(24)
  const total = q.reclaimLamports
  const pct = (v: number) => `${Math.max(0.6, (v / total) * 100)}%`

  return (
    <Page className="hiw">
      <PageIntro
        eyebrow="How it works"
        title="Three small steps."
        accent="You approve the cleanup."
        lede="mopi reads public data, shows you what it found and what it costs, then hands a clear transaction to your wallet. You stay in control the whole way."
        mascot="explain"
        bubble="Here’s the plan."
      >
        <LinkButton href={routeHref('clean')} iconRight={<Icon name="arrow-right" size={18} />}>
          Scan a wallet
        </LinkButton>
        <LinkButton href={routeHref('docs', 'safety')} variant="secondary">
          Safety details
        </LinkButton>
      </PageIntro>

      <ol className="hiw__steps" aria-label="The three steps">
        {STEPS.map((s) => (
          <li key={s.n}>
            <Card as="article" className="hiw-step" aria-labelledby={`step-${s.n}`}>
              <div className="hiw-step__lead">
                <span className="hiw-step__n" aria-hidden="true">
                  {s.n}
                </span>
                <div>
                  <h2 id={`step-${s.n}`} className="hiw-step__title">
                    <span className="sr-only">Step {Number(s.n)}: </span>
                    {s.title}
                  </h2>
                  <p className="hiw-step__summary">{s.summary}</p>
                </div>
                <ul className="hiw-step__chips" aria-label="Highlights">
                  {s.chips.map((c) => (
                    <li key={c}>
                      <Chip tone="outline">{c}</Chip>
                    </li>
                  ))}
                </ul>
              </div>
              <ul className="hiw-step__points">
                {s.points.map((p) => (
                  <li key={p.title}>
                    <Icon name="check" size={18} />
                    <div>
                      <h3>{p.title}</h3>
                      <p>{p.body}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          </li>
        ))}
      </ol>

      <Section
        id="where-sol-goes"
        eyebrow="Where the SOL goes"
        title="Most of it comes straight back to you"
        intro={`Example: closing 24 empty token accounts at ${formatSol(EXAMPLE_ACCOUNT_LAMPORTS)} SOL each${isPlaceholder ? `, with the standard ${formatBps(CONFIG.serviceFeeBps)} fee for illustration` : ''}.`}
      >
        <div className="hiw-flow">
          <div className="hiw-flow__node">
            <span className="hiw-flow__label">24 empty token accounts</span>
            <span className="hiw-flow__amount tabular">{formatSol(q.reclaimLamports)} SOL</span>
            <span className="hiw-flow__hint">account SOL stored in them</span>
          </div>
          <div className="hiw-flow__arrow" aria-hidden="true">
            <Icon name="arrow-right" size={22} />
          </div>
          <div className="hiw-flow__split">
            <div className="hiw-flow__node hiw-flow__node--you">
              <span className="hiw-flow__label">
                <Icon name="wallet" size={16} /> Your wallet
              </span>
              <span className="hiw-flow__amount hiw-flow__amount--money tabular">{formatSol(q.netLamports)} SOL</span>
            </div>
            <div className="hiw-flow__mini">
              <div className="hiw-flow__node hiw-flow__node--small">
                <span className="hiw-flow__label">Service fee · {formatBps(q.serviceFeeBps)}</span>
                <span className="hiw-flow__amount tabular">{formatSol(q.serviceFeeLamports)} SOL</span>
              </div>
              <div className="hiw-flow__node hiw-flow__node--small">
                <span className="hiw-flow__label">Network fee</span>
                <span className="hiw-flow__amount tabular">{formatSol(q.networkFeeLamports)} SOL</span>
              </div>
            </div>
          </div>
        </div>

        <div className="hiw-bar" role="img" aria-label={`Of ${formatSol(total)} SOL, ${formatSol(q.netLamports)} returns to your wallet, ${formatSol(q.serviceFeeLamports)} is the service fee and ${formatSol(q.networkFeeLamports)} the network fee.`}>
          <span className="hiw-bar__seg hiw-bar__seg--you" style={{ width: pct(q.netLamports) }} />
          <span className="hiw-bar__seg hiw-bar__seg--fee" style={{ width: pct(q.serviceFeeLamports) }} />
          <span className="hiw-bar__seg hiw-bar__seg--net" style={{ width: pct(q.networkFeeLamports) }} />
        </div>
        <ul className="hiw-bar__legend" aria-hidden="true">
          <li>
            <span className="hiw-dot hiw-dot--you" /> Back to your wallet
          </li>
          <li>
            <span className="hiw-dot hiw-dot--fee" /> Service fee
          </li>
          <li>
            <span className="hiw-dot hiw-dot--net" /> Network fee
          </li>
        </ul>
        <p className="hiw__fees-link">
          <a className="page-inline-link" href={routeHref('fees')}>
            See the full fee breakdown
          </a>
        </p>
      </Section>

      <Section id="never" eyebrow="Boundaries" title="What mopi never does">
        <div className="hiw-never">
          <ul className="hiw-never__list">
            {NEVER.map((n) => (
              <li key={n.text}>
                <span className="hiw-never__icon">
                  <Icon name={n.icon} size={20} />
                </span>
                {n.text}
              </li>
            ))}
          </ul>
          <div className="hiw-never__art" aria-hidden="true">
            <Mascot pose="happy" decorative width={180} />
          </div>
        </div>
      </Section>

      <CtaBand title="Ready for a tidy wallet?" copy="Start with a read-only scan. Nothing happens until you approve it in your wallet.">
        <LinkButton href={routeHref('clean')} iconRight={<Icon name="arrow-right" size={18} />}>
          Scan a wallet
        </LinkButton>
        <LinkButton href={routeHref('docs', 'supported')} variant="secondary">
          Supported accounts
        </LinkButton>
      </CtaBand>
    </Page>
  )
}

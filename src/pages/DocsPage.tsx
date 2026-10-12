import { useEffect, useState, type ReactNode } from 'react'
import { CONFIG } from '../config'
import { formatBps, formatSol } from '../lib/format'
import { routeHref } from '../lib/router'
import type { UnsupportedReason } from '../lib/types'
import { CtaBand, LinkButton, Page, PageIntro } from '../components/layout/Page'
import { Chip, Icon, cx, type IconName } from '../components/ui'
import { EXAMPLE_ACCOUNT_LAMPORTS } from '../lib/examples'
import './DocsPage.css'

const SECTIONS = [
  { id: 'supported', label: 'Supported accounts' },
  { id: 'safety', label: 'Safety & verification' },
  { id: 'self-host', label: 'Self-hosting' },
  { id: 'faq', label: 'FAQ' },
] as const

type SectionId = (typeof SECTIONS)[number]['id']

const REASONS: Record<UnsupportedReason, { label: string; meaning: string; next: string }> = {
  frozen: {
    label: 'Frozen',
    meaning: 'The token’s freeze authority has frozen this account.',
    next: 'Only the token issuer can unfreeze it. mopi leaves it as is.',
  },
  uninitialized: {
    label: 'Not initialized',
    meaning: 'The account exists but was never set up as a token account.',
    next: 'It’s in an unusual state, so mopi doesn’t touch it.',
  },
  'close-authority': {
    label: 'Someone else can close it',
    meaning: 'A different address is set as the close authority.',
    next: 'Only that address can close it and receive its account SOL.',
  },
  'withheld-fees': {
    label: 'Withheld transfer fees',
    meaning: 'A Token-2022 account still holding transfer fees for the token.',
    next: 'The fees must be harvested to the mint first; after that it can be closed.',
  },
  extension: {
    label: 'Unsupported extension',
    meaning: 'Uses a Token-2022 extension mopi hasn’t verified as safe to close.',
    next: 'mopi only closes accounts whose extensions it fully understands.',
  },
  'owner-mismatch': {
    label: 'Different owner',
    meaning: 'The RPC returned an account your wallet doesn’t own.',
    next: 'Your wallet can’t close it, so mopi skips it.',
  },
  unparsed: {
    label: 'Couldn’t read it',
    meaning: 'mopi couldn’t decode this account’s data.',
    next: 'If mopi can’t read it, it won’t touch it.',
  },
}

const SAFETY_STEPS: Array<{ icon: IconName; title: string; body: string }> = [
  {
    icon: 'search',
    title: 'Read-only scan',
    body: 'Scanning uses public RPC reads only. No wallet connection, signature or permission is involved.',
  },
  {
    icon: 'doc',
    title: 'Narrow transactions',
    body: 'Each transaction contains CloseAccount instructions for accounts you selected, at most one service-fee transfer, and compute-budget settings. The account SOL goes to your own wallet.',
  },
  {
    icon: 'shield',
    title: 'Checked before you’re asked',
    body: 'Every instruction is checked against that short allow-list before your wallet sees it. Anything unexpected stops that transaction before your wallet sees it.',
  },
  {
    icon: 'refresh',
    title: 'Simulated first',
    body: 'Each transaction is simulated on the network. One that fails simulation is never sent.',
  },
  {
    icon: 'wallet',
    title: 'Approved in your wallet',
    body: 'Your wallet shows the transaction and the fee transfer. Declining sends nothing.',
  },
  {
    icon: 'check',
    title: 'Verified again after signing',
    body: 'mopi re-checks the signed transaction. If it no longer matches what you reviewed, it isn’t sent.',
  },
]

const ENV_VARS: Array<{ name: string; def: string; body: ReactNode }> = [
  {
    name: 'VITE_SOLANA_RPC_URL',
    def: 'https://api.mainnet-beta.solana.com',
    body: 'Mainnet RPC endpoint used for scans, simulation and sending.',
  },
  {
    name: 'VITE_SOLANA_DEVNET_RPC_URL',
    def: 'https://api.devnet.solana.com',
    body: 'Devnet RPC endpoint, used when the network switch is on Devnet.',
  },
  {
    name: 'VITE_SOLANA_RPC_FALLBACKS',
    def: 'publicnode while VITE_SOLANA_RPC_URL is empty, else none',
    body: (
      <>
        Comma-separated https mainnet endpoints tried, in order, when the primary fails (network error, 15 s timeout,
        HTTP 401/402/403/404/408/410/429/5xx). <code>none</code> disables. Same cluster only.
      </>
    ),
  },
  {
    name: 'VITE_SOLANA_DEVNET_RPC_FALLBACKS',
    def: 'none',
    body: 'The same, for devnet.',
  },
  {
    name: 'VITE_FEE_WALLET',
    def: 'empty',
    body: (
      <>
        Service fee recipient. Must be an <strong>existing, funded system account</strong> (a transfer to an unfunded
        address below rent-exemption fails, so mopi blocks approval until it is funded). Empty = no service fee and no
        transfer instruction.
      </>
    ),
  },
  {
    name: 'VITE_SERVICE_FEE_BPS',
    def: '400',
    body: 'Standard service fee in basis points of returned account SOL (400 = 4%). Capped at 1000.',
  },
  {
    name: 'VITE_HOLDER_FEE_BPS',
    def: '200',
    body: 'Service fee for $MOPI holders, in basis points (200 = 2%).',
  },
  {
    name: 'VITE_MOPI_MINT',
    def: 'empty',
    body: 'The $MOPI mint. While empty, holder perks show as “planned”, no holder check runs and no contract address is shown. Once set, the CA appears with copy and Solscan buttons.',
  },
  {
    name: 'VITE_MOPI_HOLDER_MIN',
    def: '100000',
    body: 'Whole $MOPI tokens the connected wallet needs for holder access.',
  },
  {
    name: 'VITE_X_URL',
    def: 'empty',
    body: 'Official X profile (https only). Empty hides the link.',
  },
  {
    name: 'VITE_TELEGRAM_URL',
    def: 'empty',
    body: 'Official Telegram link (https only). Empty hides the link.',
  },
  {
    name: 'VITE_SITE_URL',
    def: 'empty',
    body: 'Your public origin, e.g. https://mopi.example. Adds the canonical link and the share-preview image at build time.',
  },
]

const FAQ: Array<{ q: string; a: ReactNode }> = [
  {
    q: 'What is “account SOL”?',
    a: (
      <>
        Every token account on Solana holds a small deposit of SOL so it can exist on-chain (often called rent). For a
        standard SPL token account that’s {EXAMPLE_ACCOUNT_LAMPORTS.toLocaleString('en-US')} lamports, about{' '}
        {formatSol(EXAMPLE_ACCOUNT_LAMPORTS)} SOL. Closing an empty account returns that deposit to the owner.
      </>
    ),
  },
  {
    q: 'Why can’t some accounts be closed?',
    a: (
      <>
        An account must hold 0 tokens and be closable by your wallet. Accounts with a balance are never touched, and a
        few empty ones are skipped for safety — frozen, controlled by another address, or using an extension mopi
        doesn’t handle. The <a className="page-inline-link" href={routeHref('docs', 'supported')}>skipped reasons table</a>{' '}
        explains each one.
      </>
    ),
  },
  {
    q: 'Can I get an account back later?',
    a: 'Yes. If you receive that token again, a new token account is created for it automatically (whoever sends it usually pays the deposit). Closing doesn’t block anything.',
  },
  {
    q: 'Does mopi touch my NFTs?',
    a: 'Only empty token accounts — ones that hold 0 tokens. An NFT you own sits in an account with a balance of 1, so it’s never selected, never moved and never closed.',
  },
  {
    q: 'Do I have to connect my wallet?',
    a: 'Not to scan. Paste any address and mopi reads its public data. You only connect when you want to close accounts, and then you approve each transaction in your wallet.',
  },
  {
    q: 'What does mopi charge?',
    a: (
      <>
        {CONFIG.feeWallet
          ? `A ${formatBps(CONFIG.serviceFeeBps)} service fee on the account SOL returned, plus the Solana network fee.`
          : 'This deployment charges no service fee — only the Solana network fee.'}{' '}
        <a className="page-inline-link" href={routeHref('fees')}>
          Fee details
        </a>
      </>
    ),
  },
]

function useActiveSection(): SectionId {
  const [active, setActive] = useState<SectionId>('supported')
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return
    const els = SECTIONS.map((s) => document.getElementById(s.id)).filter((e): e is HTMLElement => Boolean(e))
    const visible = new Map<string, boolean>()
    const obs = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => visible.set(e.target.id, e.isIntersecting))
        const first = SECTIONS.find((s) => visible.get(s.id))
        if (first) setActive(first.id)
      },
      { rootMargin: '-90px 0px -55% 0px' },
    )
    els.forEach((el) => obs.observe(el))
    return () => obs.disconnect()
  }, [])
  return active
}

export function DocsPage() {
  const active = useActiveSection()

  return (
    <Page className="docs">
      <PageIntro
        eyebrow="Docs"
        title="How mopi decides,"
        accent="written down."
        lede="What gets closed, what gets skipped, how each transaction is checked, and how to run your own copy."
        mascot="explain"
        bubble="The fine print, kindly."
      />

      <div className="docs__layout">
        <nav className="docs-toc" aria-label="On this page">
          <p className="docs-toc__title">On this page</p>
          <ul>
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <a
                  href={routeHref('docs', s.id)}
                  className={cx('docs-toc__link', active === s.id && 'is-active')}
                  aria-current={active === s.id ? 'location' : undefined}
                >
                  {s.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="docs__content">
          {/* ---------- supported ---------- */}
          <section id="supported" className="docs-section" aria-labelledby="supported-title">
            <h2 id="supported-title" className="docs-section__title">
              Supported accounts
            </h2>
            <p className="docs-section__lede">
              mopi closes token accounts that <strong>hold 0 tokens</strong> and are <strong>owned by your wallet</strong>,
              under either token program:
            </p>
            <div className="docs-programs">
              <div className="docs-program">
                <Chip tone="mint">SPL Token</Chip>
                <code>TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA</code>
                <p>The original token program. Most tokens and NFTs live here.</p>
              </div>
              <div className="docs-program">
                <Chip tone="mint">Token-2022</Chip>
                <code>TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb</code>
                <p>The newer program with extensions. Accounts are closed when their extensions are known to be safe.</p>
              </div>
            </div>

            <h3 className="docs-h3">Accounts mopi skips</h3>
            <p className="docs-p">
              Accounts with <strong>any token balance</strong> are never selected or touched. Empty accounts can also be
              skipped — each shows one of these reasons in the scan results:
            </p>
            <div className="docs-table-wrap">
              <table className="docs-table">
                <thead>
                  <tr>
                    <th scope="col">Reason</th>
                    <th scope="col">What it means</th>
                    <th scope="col">What happens</th>
                  </tr>
                </thead>
                <tbody>
                  {(Object.keys(REASONS) as UnsupportedReason[]).map((key) => (
                    <tr key={key}>
                      <th scope="row">
                        <Chip tone="rose">{REASONS[key].label}</Chip>
                      </th>
                      <td>{REASONS[key].meaning}</td>
                      <td className="docs-table__next">{REASONS[key].next}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* ---------- safety ---------- */}
          <section id="safety" className="docs-section" aria-labelledby="safety-title">
            <h2 id="safety-title" className="docs-section__title">
              Safety &amp; verification
            </h2>
            <p className="docs-section__lede">
              Every cleanup passes the same checks, in this order. Nothing leaves your wallet without your approval.
            </p>
            <ol className="docs-steps">
              {SAFETY_STEPS.map((s, i) => (
                <li key={s.title}>
                  <span className="docs-steps__n" aria-hidden="true">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <div>
                    <h3 className="docs-steps__title">
                      <Icon name={s.icon} size={16} />
                      {s.title}
                    </h3>
                    <p>{s.body}</p>
                  </div>
                </li>
              ))}
            </ol>
            <p className="page-note docs-open">
              <Icon name="info" size={18} />
              <span>
                <strong>Readable source.</strong> The scanner, fee math and transaction checks run in your browser as
                plain client-side code you can inspect — see{' '}
                <a className="page-inline-link" href={routeHref('docs', 'self-host')}>
                  Self-hosting
                </a>
                . mopi never asks for a seed phrase, private key, token approval or delegation.
              </span>
            </p>
          </section>

          {/* ---------- self-host ---------- */}
          <section id="self-host" className="docs-section" aria-labelledby="self-host-title">
            <h2 id="self-host-title" className="docs-section__title">
              Self-hosting
            </h2>
            <p className="docs-section__lede">
              mopi is a static site. Build it once and serve the <code>dist/</code> folder from any static host — routes
              use the URL hash, so no server rewrites are needed.
            </p>
            <pre className="docs-code" aria-label="Build commands">
              <code>
                {`npm install
cp .env.example .env.local   # then edit the values
npm run build                # outputs dist/`}
              </code>
            </pre>

            <h3 className="docs-h3">Environment variables</h3>
            <p className="docs-p">All values ship in the client bundle, so none of them are secret.</p>
            <dl className="docs-env">
              {ENV_VARS.map((v) => (
                <div key={v.name} className="docs-env__row">
                  <dt>
                    <code>{v.name}</code>
                    <span className="docs-env__def">
                      default: <span className="mono">{v.def}</span>
                    </span>
                  </dt>
                  <dd>{v.body}</dd>
                </div>
              ))}
            </dl>
            <p className="page-note docs-warn">
              <Icon name="alert" size={18} />
              <span>
                The public Solana RPC endpoints are heavily rate limited. For real use, point{' '}
                <code>VITE_SOLANA_RPC_URL</code> at your own RPC provider (HTTPS with CORS; no websocket needed).
              </span>
            </p>
          </section>

          {/* ---------- faq ---------- */}
          <section id="faq" className="docs-section" aria-labelledby="faq-title">
            <h2 id="faq-title" className="docs-section__title">
              FAQ
            </h2>
            <div className="docs-faq">
              {FAQ.map((f, i) => (
                <details key={f.q} className="docs-faq__item" open={i === 0}>
                  <summary>
                    <span>{f.q}</span>
                    <Icon name="chevron-down" size={18} className="docs-faq__chev" />
                  </summary>
                  <div className="docs-faq__a">{f.a}</div>
                </details>
              ))}
            </div>
          </section>

          <CtaBand mascot="happy" title="Seen enough? Try it." copy="Scan any wallet address — it’s read-only and free.">
            <LinkButton href={routeHref('clean')} iconRight={<Icon name="arrow-right" size={18} />}>
              Scan a wallet
            </LinkButton>
          </CtaBand>
        </div>
      </div>
    </Page>
  )
}

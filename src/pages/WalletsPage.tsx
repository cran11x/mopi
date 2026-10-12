import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { CLUSTER_LABELS, CONFIG } from '../config'
import { formatSol, shortAddress } from '../lib/format'
import { navigate, routeHref } from '../lib/router'
import type { SavedWallet } from '../lib/types'
import { useCleaner } from '../state/cleaner'
import { WATCHLIST_LABEL_MAX, useWatchlist } from '../state/watchlist'
import { LinkButton, Page, PageIntro } from '../components/layout/Page'
import { Mascot } from '../components/mascot/Mascot'
import { Button, Card, Chip, Icon } from '../components/ui'
import './WalletsPage.css'

function timeAgo(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function WalletsPage() {
  const { wallets, canAdd, limit } = useWatchlist()
  const { holder } = useCleaner()
  const [announce, setAnnounce] = useState('')

  return (
    <Page className="wallets">
      <PageIntro
        eyebrow="Saved wallets"
        title="Your wallets,"
        accent="one tap from tidy."
        lede="Save the wallets you keep an eye on and rescan any of them in one tap. Each one remembers its last scan."
        mascot="head"
        bubble="I’ll remember these."
      >
        <Chip tone="outline">
          {wallets.length} of {limit === null ? 'unlimited' : limit} saved
        </Chip>
        {holder.isHolder && (
          <Chip tone="mint">
            <Icon name="star" size={14} /> Holder: unlimited
          </Chip>
        )}
      </PageIntro>

      <div className="wallets__layout">
        <section className="wallets__list-col" aria-labelledby="saved-title">
          <h2 id="saved-title" className="wallets__h2">
            Saved
          </h2>
          {wallets.length === 0 ? (
            <Card tone="soft" className="wallets-empty">
              <Mascot pose="explain" width={92} decorative />
              <div>
                <p className="wallets-empty__title">No saved wallets yet</p>
                <p className="page-muted">
                  Add a wallet address to keep it here. Scanning stays read-only — saving doesn’t connect anything.
                </p>
              </div>
            </Card>
          ) : (
            <ul className="wallets-list">
              {wallets.map((w) => (
                <WalletRow key={w.id} wallet={w} onAnnounce={setAnnounce} />
              ))}
            </ul>
          )}
          <p className="wallets__storage">
            <Icon name="lock" size={16} />
            <span>Your list is stored only in this browser. Nothing is uploaded, and clearing site data removes it.</span>
          </p>
        </section>

        <aside className="wallets__side" aria-label="Add a wallet">
          {canAdd ? <AddWalletForm onAnnounce={setAnnounce} /> : <LockedCard limit={limit ?? 0} />}
        </aside>
      </div>

      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
    </Page>
  )
}

function AddWalletForm({ onAnnounce }: { onAnnounce: (msg: string) => void }) {
  const { add, wallets } = useWatchlist()
  const { publicKey } = useWallet()
  const [label, setLabel] = useState('')
  const [address, setAddress] = useState('')
  const [error, setError] = useState<string | null>(null)
  const id = useId()
  const addressRef = useRef<HTMLInputElement>(null)

  const connected = publicKey?.toBase58() ?? null
  const connectedSaved = connected ? wallets.some((w) => w.address === connected) : true

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const err = add(label, address)
    if (err) {
      setError(err)
      addressRef.current?.focus()
      return
    }
    onAnnounce(`Saved ${label.trim() || 'wallet'} ${shortAddress(address.trim())}.`)
    setLabel('')
    setAddress('')
    setError(null)
  }

  return (
    <Card className="wallets-form-card">
      <h2 className="wallets__h2 wallets__h2--card">Add a wallet</h2>
      <form className="wallets-form" onSubmit={submit} noValidate>
        <div className="wallets-field">
          <label htmlFor={`${id}-label`}>
            Label <span className="wallets-field__opt">optional</span>
          </label>
          <input
            id={`${id}-label`}
            type="text"
            value={label}
            maxLength={WATCHLIST_LABEL_MAX}
            placeholder="e.g. Main wallet"
            autoComplete="off"
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
        <div className="wallets-field">
          <label htmlFor={`${id}-address`}>Wallet address</label>
          <input
            ref={addressRef}
            id={`${id}-address`}
            type="text"
            className="mono"
            value={address}
            placeholder="Paste a Solana address"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-error` : undefined}
            onChange={(e) => {
              setAddress(e.target.value)
              if (error) setError(null)
            }}
          />
          {error && (
            <p id={`${id}-error`} className="wallets-field__error" role="alert">
              <Icon name="alert" size={14} />
              {error}
            </p>
          )}
        </div>
        <Button type="submit" block iconLeft="plus">
          Save wallet
        </Button>
        {connected && !connectedSaved && (
          <Button
            variant="ghost"
            size="sm"
            block
            iconLeft="wallet"
            onClick={() => {
              setAddress(connected)
              setError(null)
              addressRef.current?.focus()
            }}
          >
            Use connected wallet ({shortAddress(connected)})
          </Button>
        )}
      </form>
    </Card>
  )
}

function LockedCard({ limit }: { limit: number }) {
  return (
    <Card tone="mint" className="wallets-locked">
      <span className="wallets-locked__icon">
        <Icon name="lock" size={22} />
      </span>
      <h2 className="wallets__h2 wallets__h2--card">Saved wallet limit reached</h2>
      <p>
        Without holder access you can save {limit} wallet{limit === 1 ? '' : 's'}. $MOPI holder access unlocks unlimited
        watchlists.
        {!CONFIG.mopiMint && (
          <>
            {' '}
            <Chip tone="cream" className="wallets-locked__chip">
              Planned
            </Chip>
          </>
        )}
      </p>
      <p className="page-muted wallets-locked__hint">Remove a saved wallet to add a different one.</p>
      <LinkButton href={routeHref('benefits')} variant="primary" size="sm" iconRight={<Icon name="arrow-right" size={16} />}>
        See holder benefits
      </LinkButton>
    </Card>
  )
}

function WalletRow({ wallet, onAnnounce }: { wallet: SavedWallet; onAnnounce: (msg: string) => void }) {
  const { remove, rename } = useWatchlist()
  const { runScan } = useCleaner()
  const [confirming, setConfirming] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(wallet.label)
  const editRef = useRef<HTMLInputElement>(null)
  const confirmRef = useRef<HTMLDivElement>(null)
  const id = useId()

  useEffect(() => {
    if (editing) editRef.current?.select()
  }, [editing])
  useEffect(() => {
    if (confirming) confirmRef.current?.querySelector<HTMLButtonElement>('[data-cancel]')?.focus()
  }, [confirming])

  const last = wallet.lastScan

  const saveLabel = () => {
    if (draft.trim()) rename(wallet.id, draft)
    else setDraft(wallet.label)
    setEditing(false)
  }

  return (
    <li className="wallet-row">
      <span className="wallet-row__avatar" aria-hidden="true">
        {(wallet.label.trim()[0] ?? 'W').toUpperCase()}
      </span>

      <div className="wallet-row__main">
        {editing ? (
          <form
            className="wallet-row__rename"
            onSubmit={(e) => {
              e.preventDefault()
              saveLabel()
            }}
          >
            <label htmlFor={`${id}-rename`} className="sr-only">
              Label for {shortAddress(wallet.address)}
            </label>
            <input
              ref={editRef}
              id={`${id}-rename`}
              value={draft}
              maxLength={WATCHLIST_LABEL_MAX}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={saveLabel}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setDraft(wallet.label)
                  setEditing(false)
                }
              }}
            />
          </form>
        ) : (
          <p className="wallet-row__label">
            <span>{wallet.label}</span>
            <button
              type="button"
              className="wallet-row__edit"
              aria-label={`Rename ${wallet.label}`}
              onClick={() => {
                setDraft(wallet.label)
                setEditing(true)
              }}
            >
              <Icon name="doc" size={14} />
            </button>
          </p>
        )}
        <p className="wallet-row__addr mono" title={wallet.address}>
          {shortAddress(wallet.address)}
        </p>
        <p className="wallet-row__last">
          {last ? (
            <>
              <strong>{last.eligible} eligible</strong>
              <span aria-hidden="true"> · </span>
              <span className="sr-only">, </span>
              <span className="tabular">{formatSol(last.reclaimLamports)} SOL</span>
              <span aria-hidden="true"> · </span>
              <span className="sr-only">, scanned </span>
              <time dateTime={new Date(last.at).toISOString()}>{timeAgo(last.at)}</time>
              {last.cluster !== 'mainnet-beta' && (
                <Chip tone="cream" className="wallet-row__net">
                  {CLUSTER_LABELS[last.cluster]}
                </Chip>
              )}
            </>
          ) : (
            <span className="wallet-row__never">Not scanned yet</span>
          )}
        </p>
      </div>

      <div className="wallet-row__actions">
        {confirming ? (
          <div ref={confirmRef} className="wallet-row__confirm" role="group" aria-label={`Remove ${wallet.label}?`}>
            <span className="wallet-row__confirm-q">Remove?</span>
            <Button
              size="sm"
              variant="secondary"
              className="wallet-row__danger"
              onClick={() => {
                remove(wallet.id)
                onAnnounce(`Removed ${wallet.label}.`)
              }}
            >
              Remove
            </Button>
            <Button data-cancel size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <>
            <Button
              size="sm"
              iconLeft="search"
              onClick={() => {
                void runScan(wallet.address)
                navigate('clean')
              }}
              aria-label={`Scan ${wallet.label}`}
            >
              Scan
            </Button>
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              iconLeft="trash"
              aria-label={`Remove ${wallet.label}`}
              onClick={() => setConfirming(true)}
            />
          </>
        )}
      </div>
    </li>
  )
}

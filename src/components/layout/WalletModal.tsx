import { useEffect, useRef, useState } from 'react'
import { useWallet, type Wallet } from '@solana/wallet-adapter-react'
import { WalletReadyState, type WalletError, type WalletName } from '@solana/wallet-adapter-base'
import { useWalletModal } from '../../state/walletModal'
import { Mascot } from '../mascot/Mascot'
import { Button, Chip, Icon, Modal, cx } from '../ui'
import './WalletModal.css'

const INSTALL_LINKS = [
  { name: 'Phantom', href: 'https://phantom.com' },
  { name: 'Solflare', href: 'https://solflare.com' },
  { name: 'Backpack', href: 'https://backpack.app' },
]

/** After a successful connect the "Connect wallet" opener is gone; hand focus to the visible account button. */
const accountTrigger = () =>
  Array.from(document.querySelectorAll<HTMLElement>('.acct-btn, .hicon.is-connected')).find(
    (el) => el.getClientRects().length > 0,
  )

const isReady = (w: Wallet) =>
  w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable

function friendlyError(err: unknown, walletName: string): string {
  const e = err as Partial<WalletError> & { error?: { message?: string } }
  const outer = e?.message?.trim() ?? ''
  const inner = e?.error?.message?.trim() ?? ''
  const msg = !inner || outer.includes(inner) ? outer : !outer || inner.includes(outer) ? inner : `${outer} ${inner}`
  if (/reject|declin|cancel|denied/i.test(msg)) return `You closed the request in ${walletName}. Nothing was connected.`
  if (e?.name === 'WalletNotReadyError') return `${walletName} isn’t available in this browser.`
  if (/locked|unlock/i.test(msg)) return `Unlock ${walletName} and try again.`
  return msg ? `${walletName} couldn’t connect: ${msg}` : `${walletName} couldn’t connect. Try again.`
}

/**
 * mopi's own wallet picker. Wallet Standard wallets register themselves.
 *
 * wallet-adapter-react 0.15.39 with `autoConnect`: `select(name)` stores the
 * name, and the provider's auto-connect effect calls `adapter.connect()`
 * once that adapter is ready (it tracks that the user picked it). If the same
 * wallet is already selected but disconnected, `select` is a no-op, so we
 * call `connect()` ourselves. On failure the provider clears the selection,
 * so choosing the wallet again is a clean retry.
 */
export function WalletModal() {
  const { visible, close } = useWalletModal()
  const { wallets, wallet, select, connect, connected, connecting } = useWallet()
  const [pending, setPending] = useState<WalletName | null>(null)
  const [error, setError] = useState<{ name: WalletName; message: string } | null>(null)
  const [stalled, setStalled] = useState(false)
  const sawConnecting = useRef(false)
  const failedMessage = useRef<string | null>(null)
  const unlisten = useRef<(() => void) | null>(null)

  const detected = wallets.filter(isReady)
  const others = wallets.filter((w) => !isReady(w) && w.readyState !== WalletReadyState.Unsupported)

  const stopListening = () => {
    unlisten.current?.()
    unlisten.current = null
  }

  // Reset when the dialog opens/closes.
  useEffect(() => {
    if (!visible) {
      setPending(null)
      setError(null)
      stopListening()
    }
  }, [visible])

  useEffect(() => stopListening, [])

  // Offer a way out if the wallet never answers.
  useEffect(() => {
    setStalled(false)
    if (!pending) return
    const t = window.setTimeout(() => setStalled(true), 8000)
    return () => window.clearTimeout(t)
  }, [pending])

  // Track the connection attempt for the wallet the user picked.
  useEffect(() => {
    if (!pending) return
    if (connected && wallet?.adapter.name === pending) {
      stopListening()
      setPending(null)
      close()
      return
    }
    if (connecting) {
      sawConnecting.current = true
      return
    }
    if (sawConnecting.current && !connected) {
      // The attempt ended without a connection.
      sawConnecting.current = false
      stopListening()
      setError({ name: pending, message: failedMessage.current ?? friendlyError(null, pending) })
      setPending(null)
    }
  }, [pending, connected, connecting, wallet, close])

  const choose = (w: Wallet) => {
    const name = w.adapter.name
    setError(null)
    failedMessage.current = null
    sawConnecting.current = false
    stopListening()

    const onError = (err: WalletError) => {
      failedMessage.current = friendlyError(err, name)
    }
    w.adapter.on('error', onError)
    unlisten.current = () => w.adapter.off('error', onError)
    setPending(name)

    if (wallet?.adapter.name === name) {
      if (wallet.adapter.connected) {
        stopListening()
        setPending(null)
        close()
        return
      }
      connect().catch((err: unknown) => {
        stopListening()
        setError({ name, message: friendlyError(err, name) })
        setPending(null)
      })
    } else {
      select(name)
    }
  }

  const busy = pending !== null

  return (
    <Modal open={visible} onClose={close} title="Connect a wallet" returnFocus={accountTrigger}>
      <div className="wmodal">
        <p className="wmodal__lede">
          Connecting lets mopi scan your wallet and prepare cleanups. You approve every transaction in your wallet.
        </p>

        {detected.length > 0 ? (
          <ul className="wmodal__list" aria-label="Detected wallets">
            {detected.map((w) => {
              const name = w.adapter.name
              const isPending = pending === name
              const hasError = error?.name === name
              return (
                <li key={name}>
                  <button
                    type="button"
                    className={cx('wmodal__wallet', isPending && 'is-pending', hasError && 'has-error')}
                    onClick={() => choose(w)}
                    disabled={busy && !isPending}
                    aria-busy={isPending || undefined}
                    aria-describedby={hasError ? 'wmodal-error' : undefined}
                  >
                    <WalletIcon wallet={w} />
                    <span className="wmodal__name">{name}</span>
                    {isPending ? (
                      <span className="wmodal__status">
                        <span className="wmodal__spinner" aria-hidden="true" />
                        Approve in {name}…
                      </span>
                    ) : (
                      <Chip tone="mint" className="wmodal__badge">
                        Detected
                      </Chip>
                    )}
                    <Icon name="arrow-right" size={18} className="wmodal__arrow" />
                  </button>
                </li>
              )
            })}
            {others.map((w) => (
              <li key={w.adapter.name}>
                <a className="wmodal__wallet" href={w.adapter.url} target="_blank" rel="noopener noreferrer">
                  <WalletIcon wallet={w} />
                  <span className="wmodal__name">{w.adapter.name}</span>
                  <span className="wmodal__status">Install</span>
                  <Icon name="external" size={16} className="wmodal__arrow" />
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <div className="wmodal__empty">
            <Mascot pose="explain" width={80} decorative className="wmodal__empty-art" />
            <div>
              <h3 className="wmodal__empty-title">No wallet found in this browser</h3>
              <p className="wmodal__empty-copy">
                Install a Solana wallet extension, then come back and refresh. You can still scan any address without
                connecting.
              </p>
              <ul className="wmodal__install">
                {INSTALL_LINKS.map((l) => (
                  <li key={l.name}>
                    <a href={l.href} target="_blank" rel="noopener noreferrer" className="wmodal__install-link">
                      Get {l.name}
                      <Icon name="external" size={14} />
                      <span className="sr-only"> (opens in a new tab)</span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        <div className="wmodal__live" aria-live="polite">
          {error && (
            <p id="wmodal-error" className="wmodal__error" role="alert">
              <Icon name="alert" size={16} />
              <span>
                {error.message} <span className="wmodal__retry">Choose a wallet to try again.</span>
              </span>
            </p>
          )}
        </div>

        <p className="wmodal__safe">
          <Icon name="shield" size={18} />
          <span>mopi never asks for your seed phrase. Every cleanup is approved in your wallet.</span>
        </p>

        {busy && stalled && (
          <Button variant="ghost" size="sm" className="wmodal__cancel" onClick={() => {
              stopListening()
              sawConnecting.current = false
              setPending(null)
            }}>
            Waiting too long? Pick again
          </Button>
        )}
      </div>
    </Modal>
  )
}

function WalletIcon({ wallet }: { wallet: Wallet }) {
  const [broken, setBroken] = useState(false)
  if (!wallet.adapter.icon || broken) {
    return (
      <span className="wmodal__icon wmodal__icon--blank" aria-hidden="true">
        <Icon name="wallet" size={18} />
      </span>
    )
  }
  return <img className="wmodal__icon" src={wallet.adapter.icon} alt="" width={32} height={32} onError={() => setBroken(true)} />
}

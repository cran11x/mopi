import { useEffect, useState } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { shortAddress } from '../../lib/format'
import { navigate } from '../../lib/router'
import { useCleaner } from '../../state/cleaner'
import { useWalletModal } from '../../state/walletModal'
import { Button, Chip, Icon, cx } from '../ui'
import { useDropdown } from './useDropdown'
import './menus.css'

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** Connect / account button. `full` = desktop header, `icon` = square mobile button. */
export function ConnectButton({ variant = 'full' }: { variant?: 'full' | 'icon' }) {
  const { publicKey, wallet, connecting, disconnect } = useWallet()
  const { open: openModal } = useWalletModal()
  const { holder, runScan } = useCleaner()
  const dd = useDropdown()
  const [copied, setCopied] = useState(false)
  const menuId = `account-menu-${variant}`

  useEffect(() => {
    if (!copied) return
    const t = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(t)
  }, [copied])

  if (!publicKey) {
    if (variant === 'icon') {
      return (
        <button
          type="button"
          className="hicon"
          aria-label={connecting ? 'Connecting wallet…' : 'Connect wallet'}
          onClick={openModal}
        >
          <Icon name="wallet" size={20} />
        </button>
      )
    }
    return (
      <Button className="connect-btn" onClick={openModal} disabled={connecting}>
        {connecting ? 'Connecting…' : 'Connect wallet'}
      </Button>
    )
  }

  const address = publicKey.toBase58()
  const short = shortAddress(address)

  return (
    <div className="hmenu" ref={dd.rootRef}>
      <button
        ref={dd.triggerRef}
        type="button"
        className={cx(variant === 'full' ? 'acct-btn' : 'hicon is-connected')}
        aria-haspopup="menu"
        aria-expanded={dd.open}
        aria-controls={dd.open ? menuId : undefined}
        aria-label={`Wallet ${short}${holder.isHolder ? ', $MOPI holder' : ''}. Account menu`}
        onClick={() => dd.setOpen(!dd.open)}
        onKeyDown={dd.onTriggerKeyDown}
      >
        {wallet?.adapter.icon && variant === 'full' ? (
          <img src={wallet.adapter.icon} alt="" width={18} height={18} className="acct-btn__icon" />
        ) : (
          <Icon name="wallet" size={variant === 'full' ? 18 : 20} />
        )}
        {variant === 'full' && <span className="mono acct-btn__addr">{short}</span>}
        {variant === 'full' && holder.isHolder && (
          <Chip tone="mint" className="acct-btn__holder">
            Holder
          </Chip>
        )}
        {variant === 'full' && <Icon name="chevron-down" size={14} className="netpill__chev" />}
        {variant === 'icon' && <span className="hicon__dot hicon__dot--on" aria-hidden="true" />}
      </button>

      {dd.open && (
        <div ref={dd.menuRef} id={menuId} className="hmenu__panel" role="menu" aria-label="Wallet" onKeyDown={dd.onMenuKeyDown}>
          <div className="hmenu__account" aria-hidden="true">
            <span className="hmenu__hint">{wallet?.adapter.name ?? 'Wallet'} connected</span>
            <span className="mono hmenu__addr">{shortAddress(address, 6, 6)}</span>
            {holder.isHolder && (
              <Chip tone="mint" className="hmenu__holder">
                <Icon name="star" size={12} /> $MOPI holder
              </Chip>
            )}
          </div>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="hmenu__item"
            onClick={async () => {
              if (await copyText(address)) setCopied(true)
            }}
          >
            <Icon name={copied ? 'check' : 'copy'} size={18} />
            <span className="hmenu__label">{copied ? 'Copied' : 'Copy address'}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="hmenu__item"
            onClick={() => {
              dd.close()
              navigate('clean')
              void runScan(address)
            }}
          >
            <Icon name="search" size={18} />
            <span className="hmenu__label">Scan this wallet</span>
          </button>
          <div className="hmenu__sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="hmenu__item hmenu__item--quiet"
            onClick={() => {
              dd.close(true)
              void disconnect().catch(() => {})
            }}
          >
            <Icon name="logout" size={18} />
            <span className="hmenu__label">Disconnect</span>
          </button>
          <span className="sr-only" aria-live="polite">
            {copied ? 'Address copied' : ''}
          </span>
        </div>
      )}
    </div>
  )
}

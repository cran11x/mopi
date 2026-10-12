import { CLUSTER_LABELS } from '../../config'
import type { Cluster } from '../../lib/types'
import { useCluster } from '../../state/cluster'
import { Icon, SolanaMark, cx } from '../ui'
import { useState } from 'react'
import { useDropdown } from './useDropdown'
import { RpcSettings } from './RpcSettings'
import './menus.css'

const CLUSTERS: Array<{ key: Cluster; hint: string }> = [
  { key: 'mainnet-beta', hint: 'Real wallets, real SOL' },
  { key: 'devnet', hint: 'Test network, free SOL' },
]

/** Network picker. `pill` = desktop header, `icon` = square mobile button. */
export function NetworkSelect({ variant = 'pill' }: { variant?: 'pill' | 'icon' }) {
  const { cluster, setCluster, customRpc } = useCluster()
  const dd = useDropdown()
  const [rpcOpen, setRpcOpen] = useState(false)
  const isDevnet = cluster === 'devnet'
  const menuId = `network-menu-${variant}`

  return (
    <div className="hmenu" ref={dd.rootRef}>
      <button
        ref={dd.triggerRef}
        type="button"
        className={cx(variant === 'pill' ? 'netpill' : 'hicon', isDevnet && 'is-devnet')}
        aria-haspopup="menu"
        aria-expanded={dd.open}
        aria-controls={dd.open ? menuId : undefined}
        aria-label={`Network: Solana ${CLUSTER_LABELS[cluster]}. Change network`}
        onClick={() => dd.setOpen(!dd.open)}
        onKeyDown={dd.onTriggerKeyDown}
      >
        <SolanaMark size={variant === 'pill' ? 16 : 20} />
        {variant === 'pill' && <span className="netpill__label">Solana</span>}
        {variant === 'pill' && isDevnet && <span className="netpill__dev">Devnet</span>}
        {variant === 'pill' && <Icon name="chevron-down" size={14} className="netpill__chev" />}
        {variant === 'icon' && isDevnet && <span className="hicon__dot" aria-hidden="true" />}
      </button>

      {dd.open && (
        <div
          ref={dd.menuRef}
          id={menuId}
          className="hmenu__panel"
          role="menu"
          aria-label="Solana network"
          onKeyDown={dd.onMenuKeyDown}
        >
          <p className="hmenu__heading" aria-hidden="true">
            Network
          </p>
          {CLUSTERS.map(({ key, hint }) => {
            const active = key === cluster
            return (
              <button
                key={key}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                tabIndex={-1}
                className="hmenu__item"
                onClick={() => {
                  // The provider tree is not remounted on a switch; close(true) refocuses the trigger.
                  dd.close(true)
                  if (!active) setCluster(key)
                }}
              >
                <SolanaMark size={18} />
                <span className="hmenu__text">
                  <span className="hmenu__label">{CLUSTER_LABELS[key]}</span>
                  <span className="hmenu__hint">{hint}</span>
                </span>
                <Icon name="check" size={16} className={cx('hmenu__check', active && 'is-on')} />
              </button>
            )
          })}
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="hmenu__item"
            onClick={() => {
              dd.close(false)
              setRpcOpen(true)
            }}
          >
            <Icon name="refresh" size={18} />
            <span className="hmenu__text">
              <span className="hmenu__label">Custom RPC…</span>
              <span className="hmenu__hint">{customRpc ? new URL(customRpc).host : 'Use your own endpoint'}</span>
            </span>
          </button>
        </div>
      )}
      <RpcSettings open={rpcOpen} onClose={() => setRpcOpen(false)} />
    </div>
  )
}

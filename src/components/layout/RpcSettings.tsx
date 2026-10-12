import { useEffect, useId, useState } from 'react'
import { CLUSTER_LABELS, RPC_URLS } from '../../config'
import { useCluster } from '../../state/cluster'
import { Button, Modal } from '../ui'
import './RpcSettings.css'

/** Lets a viewer point mopi at their own RPC (stored only in this browser). */
export function RpcSettings({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { cluster, customRpc, setCustomRpc } = useCluster()
  const [value, setValue] = useState(customRpc ?? '')
  const [error, setError] = useState<string | null>(null)
  const inputId = useId()
  const hintId = useId()

  useEffect(() => {
    if (open) {
      setValue(customRpc ?? '')
      setError(null)
    }
  }, [open, customRpc])

  const save = () => {
    const err = setCustomRpc(value)
    if (err) setError(err)
    else onClose()
  }

  return (
    <Modal open={open} onClose={onClose} title="RPC endpoint">
      <form
        className="rpcset"
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <p className="rpcset__lede">
          mopi reads your wallet through a Solana RPC. The free public endpoint often refuses websites (403). A free key
          from a provider such as Helius or QuickNode fixes that.
        </p>
        <label className="rpcset__label" htmlFor={inputId}>
          Custom {CLUSTER_LABELS[cluster]} RPC URL
        </label>
        <input
          id={inputId}
          className="rpcset__input mono"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://mainnet.helius-rpc.com/?api-key=…"
          value={value}
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={hintId}
          onChange={(e) => {
            setValue(e.target.value)
            setError(null)
          }}
        />
        <p id={hintId} className={error ? 'rpcset__error' : 'rpcset__hint'} role={error ? 'alert' : undefined}>
          {error ?? `Saved only in this browser. Leave empty to use the default (${new URL(RPC_URLS[cluster]).host}).`}
        </p>
        <div className="rpcset__actions">
          {customRpc && (
            <Button
              variant="ghost"
              onClick={() => {
                setCustomRpc(null)
                onClose()
              }}
            >
              Use default
            </Button>
          )}
          <Button type="submit" variant="primary">
            Save
          </Button>
        </div>
      </form>
    </Modal>
  )
}

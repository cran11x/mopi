import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { useCleaner } from '../../state/cleaner'
import { shortAddress } from '../../lib/format'
import { Icon, cx } from '../ui'
import './ScanForm.css'

/** Long, whitespace-free values are shown shortened while the field is not focused. */
function looksLikeAddress(value: string): boolean {
  return value.length > 20 && !/\s/.test(value)
}

export function ScanForm({ className }: { className?: string }) {
  const { addressInput, setAddressInput, scanStatus, scanError, runScan, loadDemo } = useCleaner()
  const scanning = scanStatus === 'scanning'
  const inputId = useId()
  const errorId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [focused, setFocused] = useState(false)
  const [clipNote, setClipNote] = useState<string | null>(null)
  const noteTimer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(noteTimer.current), [])

  const flash = (msg: string) => {
    setClipNote(msg)
    window.clearTimeout(noteTimer.current)
    noteTimer.current = window.setTimeout(() => setClipNote(null), 2400)
  }

  const value = addressInput
  const showShort = !focused && looksLikeAddress(value)
  const isEmpty = value.trim() === ''

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (scanning) return
    void runScan(value.trim())
  }

  const onClipboard = async () => {
    if (isEmpty) {
      try {
        if (!navigator.clipboard?.readText) throw new Error('unavailable')
        const text = (await navigator.clipboard.readText()).trim()
        if (!text) {
          flash('Clipboard is empty.')
          return
        }
        setAddressInput(text)
        flash('Address pasted.')
      } catch {
        inputRef.current?.focus()
        flash('Clipboard access was blocked — paste with Ctrl+V / ⌘V.')
      }
      return
    }
    try {
      if (!navigator.clipboard?.writeText) throw new Error('unavailable')
      await navigator.clipboard.writeText(value.trim())
      flash('Address copied.')
    } catch {
      inputRef.current?.focus()
      inputRef.current?.select()
      flash('Couldn’t copy — the address is selected, press Ctrl+C / ⌘C.')
    }
  }

  const copied = clipNote === 'Address copied.' || clipNote === 'Address pasted.'

  return (
    <div className={cx('scan-form', className)}>
      <h2 id="scan-heading" className="scan-form__title">
        Let’s see what’s empty.
      </h2>

      <form className="scan-form__row" onSubmit={onSubmit} role="search" aria-label="Scan a wallet">
        <div className={cx('scan-form__field', scanError && 'scan-form__field--error')}>
          <span className="scan-form__lead" aria-hidden="true">
            <Icon name="search" size={18} />
          </span>
          <label htmlFor={inputId} className="sr-only">
            Solana wallet address
          </label>
          <input
            ref={inputRef}
            id={inputId}
            className={cx('scan-form__input', showShort && 'scan-form__input--masked')}
            type="text"
            inputMode="text"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="Paste a Solana wallet address"
            value={value}
            title={showShort ? value : undefined}
            aria-invalid={scanError ? true : undefined}
            aria-describedby={scanError ? errorId : undefined}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onChange={(e) => setAddressInput(e.target.value)}
          />
          {/* Visual-only short form ("GmaD...AEGB") while unfocused; the input keeps the full value. */}
          {showShort && (
            <span className="scan-form__short" aria-hidden="true">
              {shortAddress(value)}
            </span>
          )}
          <button
            type="button"
            className="scan-form__clip"
            onClick={onClipboard}
            aria-label={isEmpty ? 'Paste address from clipboard' : 'Copy address'}
            title={isEmpty ? 'Paste' : 'Copy address'}
          >
            <Icon name={copied ? 'check' : isEmpty ? 'paste' : 'copy'} size={18} />
          </button>
        </div>

        <button type="submit" className="btn btn--primary scan-form__submit" disabled={scanning} aria-busy={scanning || undefined}>
          {scanning ? (
            <>
              <span className="scan-form__spinner" aria-hidden="true" />
              Scanning…
            </>
          ) : (
            <>
              Scan wallet
              <Icon name="arrow-right" size={18} />
            </>
          )}
        </button>
      </form>

      <div className="scan-form__meta">
        <button type="button" className="link link--underline scan-form__demo" onClick={loadDemo}>
          Try demo wallet
        </button>
        <span className="scan-form__sep" aria-hidden="true" />
        <span className="scan-form__muted">A scan is read-only.</span>
        <span className="scan-form__note" role="status" aria-live="polite">
          {clipNote}
        </span>
      </div>

      {scanError && (
        <p id={errorId} className="scan-form__error" role="alert">
          <Icon name="alert" size={16} />
          {scanError}
        </p>
      )}
    </div>
  )
}

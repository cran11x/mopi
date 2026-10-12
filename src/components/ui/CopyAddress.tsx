import { useEffect, useRef, useState } from 'react'
import { shortAddress } from '../../lib/format'
import { Icon } from './Icon'
import './CopyAddress.css'

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

/** Clipboard API first, then the legacy execCommand path (older browsers, non-secure contexts). */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-1000px'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}

export interface CopyAddressProps {
  address: string
  /** Short tag before the address, e.g. "CA". */
  tag?: string
  /** What the address is, for screen readers: "Copy {what}". Default "address". */
  what?: string
  /** Optional explorer link (opens in a new tab). */
  href?: string
  /** Link text for screen readers. Default "View on Solscan". */
  hrefLabel?: string
  /** `compact` = shortened inline chip; `full` = the whole address, wrapping on narrow screens. */
  variant?: 'compact' | 'full'
  className?: string
}

/**
 * An address in mono with a copy button and an optional explorer link.
 * If the clipboard is unavailable the full address is revealed and selected so
 * it can be copied by hand.
 */
export function CopyAddress({
  address,
  tag,
  what = 'address',
  href,
  hrefLabel = 'View on Solscan',
  variant = 'compact',
  className,
}: CopyAddressProps) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
  const textRef = useRef<HTMLSpanElement>(null)
  const showFull = variant === 'full' || status === 'failed'

  useEffect(() => {
    if (status !== 'copied') return
    const t = window.setTimeout(() => setStatus('idle'), 1800)
    return () => window.clearTimeout(t)
  }, [status])

  // Manual fallback: select the (now fully shown) address.
  useEffect(() => {
    if (status !== 'failed' || !textRef.current) return
    const sel = window.getSelection()
    if (!sel) return
    const range = document.createRange()
    range.selectNodeContents(textRef.current)
    sel.removeAllRanges()
    sel.addRange(range)
  }, [status])

  const onCopy = async () => {
    setStatus((await writeClipboard(address)) ? 'copied' : 'failed')
  }

  return (
    <span className={cx('copyaddr', `copyaddr--${variant}`, showFull && 'is-full', className)}>
      {tag && (
        <span className="copyaddr__tag" aria-hidden="true">
          {tag}
        </span>
      )}
      {tag && <span className="sr-only">{what}: </span>}
      <span ref={textRef} className="copyaddr__text mono" title={showFull ? undefined : address} translate="no">
        {showFull ? address : shortAddress(address)}
      </span>
      <button
        type="button"
        className={cx('copyaddr__btn', status === 'copied' && 'is-copied')}
        aria-label={status === 'copied' ? `Copied ${what}` : `Copy ${what}`}
        title={status === 'copied' ? 'Copied' : 'Copy'}
        onClick={() => void onCopy()}
      >
        <Icon name={status === 'copied' ? 'check' : 'copy'} size={variant === 'full' ? 18 : 15} />
        {variant === 'full' && <span className="copyaddr__btn-label">{status === 'copied' ? 'Copied' : 'Copy'}</span>}
      </button>
      {href && (
        <a className="copyaddr__link" href={href} target="_blank" rel="noopener noreferrer" title={hrefLabel}>
          <Icon name="external" size={variant === 'full' ? 17 : 14} />
          <span className="sr-only">{hrefLabel} (opens in a new tab)</span>
        </a>
      )}
      <span className="sr-only" aria-live="polite">
        {status === 'copied' ? 'Copied' : status === 'failed' ? 'Copy failed. The address is selected — copy it manually.' : ''}
      </span>
    </span>
  )
}

import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react'
import { createPortal } from 'react-dom'
import { Icon, type IconName } from './Icon'
import './ui.css'

export { Icon, SolanaMark } from './Icon'
export type { IconName } from './Icon'

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}
export { cx }

/* ---------- Button ---------- */

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** React 19: refs are plain props on function components. */
  ref?: Ref<HTMLButtonElement>
  variant?: 'primary' | 'secondary' | 'mint' | 'ghost'
  size?: 'sm' | 'md' | 'lg'
  block?: boolean
  iconLeft?: IconName
  iconRight?: IconName
  iconOnly?: boolean
}

export function Button({
  variant = 'primary',
  size = 'md',
  block,
  iconLeft,
  iconRight,
  iconOnly,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  const iconSize = size === 'sm' ? 16 : 18
  return (
    <button
      type={type}
      className={cx(
        'btn',
        `btn--${variant}`,
        size !== 'md' && `btn--${size}`,
        block && 'btn--block',
        iconOnly && 'btn--icon',
        className,
      )}
      {...rest}
    >
      {iconLeft && <Icon name={iconLeft} size={iconSize} />}
      {children}
      {iconRight && <Icon name={iconRight} size={iconSize} />}
    </button>
  )
}

/* ---------- Chip ---------- */

export function Chip({
  tone = 'mint',
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLSpanElement> & { tone?: 'mint' | 'cream' | 'rose' | 'neutral' | 'outline' }) {
  return (
    <span className={cx('chip', `chip--${tone}`, className)} {...rest}>
      {children}
    </span>
  )
}

/* ---------- Card ---------- */

export function Card({
  pad = true,
  tone,
  className,
  children,
  as: Tag = 'div',
  ...rest
}: HTMLAttributes<HTMLElement> & { pad?: boolean; tone?: 'soft' | 'mint'; as?: 'div' | 'section' | 'article' | 'aside' }) {
  return (
    <Tag className={cx('card', pad && 'card--pad', tone && `card--${tone}`, className)} {...rest}>
      {children}
    </Tag>
  )
}

/* ---------- Checkbox ---------- */

export function Checkbox({
  checked,
  indeterminate = false,
  onChange,
  label,
  disabled,
}: {
  checked: boolean
  indeterminate?: boolean
  onChange: (checked: boolean) => void
  /** Accessible label (visually hidden). */
  label: string
  disabled?: boolean
}) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate
  }, [indeterminate])
  return (
    <span className="checkbox">
      <input
        ref={ref}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="checkbox__box" aria-hidden="true">
        {indeterminate ? (
          <svg width="12" height="12" viewBox="0 0 12 12">
            <path d="M2.5 6h7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 12 12">
            <path d="m2.2 6.3 2.4 2.4 5.2-5.3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
    </span>
  )
}

/* ---------- Tabs ---------- */

export interface TabItem<K extends string> {
  key: K
  label: ReactNode
}

/** Segmented tabs. Pair each tab with a panel: id={`${idBase}-panel-${key}`}, aria-labelledby={`${idBase}-tab-${key}`}. */
export function Tabs<K extends string>({
  items,
  value,
  onChange,
  idBase,
  label,
  className,
}: {
  items: TabItem<K>[]
  value: K
  onChange: (key: K) => void
  idBase: string
  label: string
  className?: string
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    const next = items[(index + (e.key === 'ArrowRight' ? 1 : items.length - 1)) % items.length]
    onChange(next.key)
    document.getElementById(`${idBase}-tab-${next.key}`)?.focus()
  }
  return (
    <div className={cx('tabs', className)} role="tablist" aria-label={label}>
      {items.map((item, i) => (
        <button
          key={item.key}
          id={`${idBase}-tab-${item.key}`}
          type="button"
          role="tab"
          className="tab"
          aria-selected={item.key === value}
          aria-controls={`${idBase}-panel-${item.key}`}
          tabIndex={item.key === value ? 0 : -1}
          onClick={() => onChange(item.key)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

/* ---------- Modal ---------- */

/**
 * Open dialogs, bottom to top. Only the topmost one reacts to Escape / Tab,
 * so one Escape closes one dialog (e.g. the wallet picker over the review).
 */
const modalStack: object[] = []
let overflowBeforeModals = ''

const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

/** Can `el` take focus right now (still in the page, enabled, rendered)? */
function canFocus(el: Element | null | undefined): el is HTMLElement {
  if (!(el instanceof HTMLElement) || !el.isConnected || el === document.body) return false
  if ((el as HTMLButtonElement).disabled) return false
  return el.getClientRects().length > 0
}

export function Modal({
  open,
  onClose,
  title,
  children,
  wide,
  dismissible = true,
  returnFocus,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  children: ReactNode
  wide?: boolean
  /** When false, Escape / backdrop clicks are ignored (e.g. while signing). */
  dismissible?: boolean
  /**
   * Where focus goes on close when the element that opened the dialog is gone
   * or disabled (e.g. "Connect wallet" replaced by the account button).
   * Falls back to the main landmark.
   */
  returnFocus?: () => HTMLElement | null | undefined
}) {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const tokenRef = useRef<object>({})
  // Latest props, read by the long-lived effect below without re-running it.
  const onCloseRef = useRef(onClose)
  const dismissibleRef = useRef(dismissible)
  const returnFocusRef = useRef(returnFocus)
  onCloseRef.current = onClose
  dismissibleRef.current = dismissible
  returnFocusRef.current = returnFocus

  // Runs once per open → close: remembers the opener, locks scroll, traps focus,
  // and gives focus back on close. Phase changes inside the dialog do not re-run it.
  useEffect(() => {
    if (!open) return
    const token = tokenRef.current
    const opener = document.activeElement
    if (modalStack.length === 0) {
      overflowBeforeModals = document.body.style.overflow
      document.body.style.overflow = 'hidden'
    }
    modalStack.push(token)
    const isTop = () => modalStack[modalStack.length - 1] === token
    const dialog = dialogRef.current
    const focusables = () => Array.from(dialog?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
    ;(focusables()[0] ?? dialog)?.focus()

    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!isTop() || e.defaultPrevented) return
      if (e.key === 'Escape') {
        if (!dismissibleRef.current) return
        e.preventDefault()
        onCloseRef.current()
      } else if (e.key === 'Tab') {
        const els = focusables()
        if (els.length === 0) {
          e.preventDefault()
          dialog?.focus()
          return
        }
        const first = els[0]
        const last = els[els.length - 1]
        const inside = dialog?.contains(document.activeElement)
        if (e.shiftKey && (document.activeElement === first || !inside)) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      const i = modalStack.indexOf(token)
      if (i >= 0) modalStack.splice(i, 1)
      if (modalStack.length === 0) document.body.style.overflow = overflowBeforeModals
      // A dialog still open underneath keeps (or regains) focus; otherwise the opener does.
      const target = canFocus(opener)
        ? opener
        : (() => {
            const fallback = returnFocusRef.current?.()
            return canFocus(fallback) ? fallback : document.getElementById('content')
          })()
      target?.focus({ preventScroll: !canFocus(opener) })
    }
  }, [open])

  // The content can change while open (review → progress → done). If the
  // focused control disappeared with it, keep focus inside the dialog.
  useEffect(() => {
    if (!open) return
    const dialog = dialogRef.current
    if (!dialog || modalStack[modalStack.length - 1] !== tokenRef.current) return
    if (!dialog.contains(document.activeElement)) dialog.focus({ preventScroll: true })
  })

  if (!open) return null
  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && dismissible) onClose()
      }}
    >
      <div
        ref={dialogRef}
        className={cx('modal', wide && 'modal--wide')}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="modal__header">
          <h2 id={titleId} className="modal__title">
            {title}
          </h2>
          {dismissible && (
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              iconLeft="close"
              aria-label="Close"
              className="modal__close"
              onClick={onClose}
            />
          )}
        </div>
        <div className="modal__body">{children}</div>
      </div>
    </div>,
    document.body,
  )
}

/* ---------- Tooltip ---------- */

/** Small (i) button that reveals `content` on hover/focus/tap. */
export function InfoTip({ content, label = 'More info' }: { content: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <span className="tip" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        className="tip__trigger"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          // WCAG 1.4.13: the tip can be dismissed without moving focus; a surrounding dialog stays open.
          if (e.key === 'Escape' && open) {
            e.preventDefault()
            e.stopPropagation()
            setOpen(false)
          }
        }}
      >
        <Icon name="info" size={16} />
      </button>
      {open && (
        <span role="tooltip" id={id} className="tip__bubble">
          {content}
        </span>
      )}
    </span>
  )
}

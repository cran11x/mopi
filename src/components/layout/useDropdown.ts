import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'

const ITEM_SELECTOR = '[role="menuitem"]:not([aria-disabled="true"]), [role="menuitemradio"], [role="option"]'

/**
 * Disclosure state for a header menu: click-outside and Escape close it,
 * focus moves into the menu on open (the checked item first) and returns to
 * the trigger on Escape. Arrow keys / Home / End move between items.
 */
export function useDropdown<T extends HTMLElement = HTMLButtonElement>() {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<T>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const items = () => Array.from(menuRef.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? [])

  const close = useCallback((returnFocus = false) => {
    setOpen(false)
    if (returnFocus) triggerRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!open) return
    const els = items()
    const checked = els.find((el) => el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true')
    ;(checked ?? els[0])?.focus()

    const onPointer = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close(true)
      }
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, close])

  const onMenuKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const els = items()
    if (els.length === 0) return
    const i = els.indexOf(document.activeElement as HTMLElement)
    let next = -1
    if (e.key === 'ArrowDown') next = (i + 1) % els.length
    else if (e.key === 'ArrowUp') next = (i - 1 + els.length) % els.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = els.length - 1
    else if (e.key === 'Tab') {
      setOpen(false)
      return
    }
    if (next >= 0) {
      e.preventDefault()
      els[next].focus()
    }
  }

  const onTriggerKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'ArrowDown' && !open) {
      e.preventDefault()
      setOpen(true)
    }
  }

  return { open, setOpen, close, rootRef, triggerRef, menuRef, onMenuKeyDown, onTriggerKeyDown }
}

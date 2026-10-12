import { LAMPORTS_PER_SOL } from '../config'

/** "GmaDr7…AEGB" style shortening used everywhere an address is displayed. */
export function shortAddress(address: string, head = 4, tail = 4): string {
  if (address.length <= head + tail + 3) return address
  return `${address.slice(0, head)}...${address.slice(-tail)}`
}

/**
 * Formats lamports as SOL with a fixed number of decimals (default 4), using
 * integer math so 0.0460 never renders as 0.045999.
 * Non-zero amounts too small for `decimals` get extra precision (up to 9)
 * instead of rounding to 0 — a fee is never displayed as "0.0000".
 */
export function formatSol(
  lamports: number,
  opts: { decimals?: number; sign?: 'auto' | 'always-minus' | 'always-plus'; unit?: boolean } = {},
): string {
  const { decimals = 4, sign = 'auto', unit = false } = opts
  const negative = lamports < 0
  const abs = Math.abs(Math.round(lamports))

  let places = decimals
  if (abs > 0) {
    while (places < 9 && abs < 10 ** (9 - places)) places++
    // keep two significant digits for tiny values
    if (places > decimals) places = Math.min(9, places + 1)
  }

  const factor = 10 ** (9 - places)
  const rounded = Math.round(abs / factor)
  const whole = Math.floor(rounded / 10 ** places)
  const frac = rounded % 10 ** places
  let text = places > 0 ? `${whole}.${String(frac).padStart(places, '0')}` : String(whole)
  if (places > decimals) text = text.replace(/0+$/, '')

  let prefix = ''
  if (sign === 'always-minus' && abs > 0) prefix = '−'
  else if (sign === 'always-plus' && abs > 0) prefix = '+'
  else if (negative && abs > 0) prefix = '−'

  return `${prefix}${text}${unit ? ' SOL' : ''}`
}

export function lamportsToSol(lamports: number): number {
  return lamports / LAMPORTS_PER_SOL
}

export function formatBps(bps: number): string {
  const pct = bps / 100
  return `${Number.isInteger(pct) ? pct : pct.toFixed(2).replace(/0+$/, '')}%`
}

/** Two-digit ordinal used for account labels ("Account 01"). */
export function ordinal2(n: number): string {
  return String(n).padStart(2, '0')
}

export function formatTokenAmount(uiAmount: string): string {
  const n = Number(uiAmount)
  if (!Number.isFinite(n)) return uiAmount
  if (n === 0) return '0'
  return n.toLocaleString('en-US', { maximumFractionDigits: 6 })
}

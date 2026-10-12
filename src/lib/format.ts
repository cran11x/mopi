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
  if (places > decimals) text = text.replace(/0+$/, '').replace(/\.$/, '')

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

const TOKEN_FRACTION_DIGITS = 6

/**
 * Token balance for display: grouped integer part, at most 6 decimals.
 * Works on the decimal string (no float rounding past 2^53), and a tiny
 * non-zero balance shows as "<0.000001", never as "0".
 */
export function formatTokenAmount(uiAmount: string): string {
  const t = uiAmount.trim()
  const m = /^(\d+)(?:\.(\d*))?$/.exec(t)
  if (!m) {
    // e.g. exponent notation; fall back to Number.
    const n = Number(t)
    if (!Number.isFinite(n)) return uiAmount
    if (n === 0) return '0'
    if (Math.abs(n) < 10 ** -TOKEN_FRACTION_DIGITS) return `<0.${'0'.repeat(TOKEN_FRACTION_DIGITS - 1)}1`
    return n.toLocaleString('en-US', { maximumFractionDigits: TOKEN_FRACTION_DIGITS })
  }
  const int = m[1].replace(/^0+(?=\d)/, '')
  const fullFraction = m[2] ?? ''
  const fraction = fullFraction.slice(0, TOKEN_FRACTION_DIGITS).replace(/0+$/, '')
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  if (int === '0' && !fraction) {
    return /[1-9]/.test(fullFraction) ? `<0.${'0'.repeat(TOKEN_FRACTION_DIGITS - 1)}1` : '0'
  }
  return fraction ? `${grouped}.${fraction}` : grouped
}

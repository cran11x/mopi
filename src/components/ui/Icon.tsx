import type { ReactNode, SVGProps } from 'react'

// Stroke icon set (24px grid, 1.75 stroke) drawn for mopi. Add new glyphs here
// rather than pulling in an icon library.

export type IconName =
  | 'search'
  | 'shield'
  | 'doc'
  | 'copy'
  | 'paste'
  | 'arrow-right'
  | 'info'
  | 'bulb'
  | 'wallet'
  | 'menu'
  | 'close'
  | 'star'
  | 'check'
  | 'chevron-down'
  | 'external'
  | 'broom'
  | 'lock'
  | 'trash'
  | 'plus'
  | 'refresh'
  | 'alert'
  | 'sparkle'
  | 'logout'

const PATHS: Record<IconName, ReactNode> = {
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.5 15.5 5 5" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.2 7.5 9.5 4.4-1.3 7.5-4.9 7.5-9.5V6L12 3Z" />
      <path d="m8.8 12.2 2.3 2.3 4.3-4.6" />
    </>
  ),
  doc: (
    <>
      <path d="M7 3h7l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
      <path d="M14 3v4h4M9 11h6M9 14.5h6M9 18h4" />
    </>
  ),
  copy: (
    <>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
      <path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" />
    </>
  ),
  paste: (
    <>
      <rect x="5" y="5" width="14" height="16" rx="2" />
      <path d="M9 5V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1M9 11h6M9 15h4" />
    </>
  ),
  'arrow-right': <path d="M5 12h13m-5-5 5 5-5 5" />,
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.5M12 7.6v.2" />
    </>
  ),
  bulb: (
    <>
      <path d="M9 17.5h6M10 20.5h4" />
      <path d="M12 3.5a5.8 5.8 0 0 0-3.4 10.5c.6.5 1 1.2 1 2V17h4.8v-1c0-.8.4-1.5 1-2A5.8 5.8 0 0 0 12 3.5Z" />
    </>
  ),
  wallet: (
    <>
      <path d="M4.5 7.5A2.5 2.5 0 0 1 7 5h10.5v3" />
      <rect x="4.5" y="8" width="15" height="11" rx="2.5" />
      <path d="M15.5 13.5h1.5" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  star: <path d="m12 3.8 2.5 5.1 5.6.8-4 3.9 1 5.6-5.1-2.6-5 2.6.9-5.6-4-3.9 5.6-.8L12 3.8Z" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  'chevron-down': <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />,
  external: (
    <>
      <path d="M14 4.5h5.5V10M19.5 4.5 11 13" />
      <path d="M17.5 13.5V18a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18V8A1.5 1.5 0 0 1 6 6.5h4.5" />
    </>
  ),
  broom: (
    <>
      <path d="m19.5 3.5-7 7" />
      <path d="M12.8 9.7 9.2 8.4 4 13.6c1.7 3.1 3.3 4.7 6.4 6.4l5.2-5.2-1.3-3.6" />
      <path d="m6.5 16.5 2-2M8.9 18.6l1.6-1.6" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="2" />
      <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
    </>
  ),
  trash: (
    <>
      <path d="M4.5 7h15M10 4h4M6.5 7l.9 12a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4l.9-12" />
      <path d="M10 11v6M14 11v6" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  refresh: (
    <>
      <path d="M19.5 12a7.5 7.5 0 0 1-13.2 4.9M4.5 12a7.5 7.5 0 0 1 13.2-4.9" />
      <path d="M18 3.5v4h-4M6 20.5v-4h4" />
    </>
  ),
  alert: (
    <>
      <path d="M10.3 4.3 2.9 17.5A2 2 0 0 0 4.6 20.5h14.8a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9.5v4.5M12 17v.2" />
    </>
  ),
  sparkle: <path d="M12 3.5c.6 4.4 2.1 5.9 6.5 6.5-4.4.6-5.9 2.1-6.5 6.5-.6-4.4-2.1-5.9-6.5-6.5 4.4-.6 5.9-2.1 6.5-6.5Z" />,
  logout: (
    <>
      <path d="M14 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2H14" />
      <path d="M10.5 12h10m-3.5-3.5L20.5 12 17 15.5" />
    </>
  ),
}

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName
  size?: number
  strokeWidth?: number
  /** Accessible label. Omit for decorative icons (aria-hidden). */
  label?: string
}

export function Icon({ name, size = 20, strokeWidth = 1.75, label, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      {...rest}
    >
      {PATHS[name]}
    </svg>
  )
}

/** Solana's three-bar mark in its gradient, for the network pill. */
export function SolanaMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="mopi-sol-grad" x1="3" y1="20" x2="21" y2="4" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#9945FF" />
          <stop offset="1" stopColor="#14F195" />
        </linearGradient>
      </defs>
      <g fill="url(#mopi-sol-grad)">
        <path d="M6.2 16.2a.8.8 0 0 1 .56-.23H21l-3.2 3.2a.8.8 0 0 1-.56.23H3l3.2-3.2Z" />
        <path d="M6.2 4.83A.8.8 0 0 1 6.76 4.6H21l-3.2 3.2a.8.8 0 0 1-.56.23H3l3.2-3.2Z" />
        <path d="M17.8 10.5a.8.8 0 0 0-.56-.23H3l3.2 3.2a.8.8 0 0 0 .56.23H21l-3.2-3.2Z" />
      </g>
    </svg>
  )
}

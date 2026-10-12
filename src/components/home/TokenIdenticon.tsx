import type { ReactNode } from 'react'

// Tiny deterministic token mark: shape + mint shade derived from a hash of the
// mint address, so the same token always looks the same across scans.

const SHADES = ['#95c9a9', '#a6d0b7', '#8bbfa0', '#b3dac2', '#9fc4ae', '#86b89a']

const SHAPES: Array<(c: string) => ReactNode> = [
  // hexagon
  (c) => <path d="M10 1.5 17.4 5.75v8.5L10 18.5 2.6 14.25v-8.5L10 1.5Z" fill={c} />,
  // square
  (c) => <rect x="3" y="3" width="14" height="14" rx="1.5" fill={c} />,
  // rounded square
  (c) => <rect x="2.75" y="2.75" width="14.5" height="14.5" rx="5" fill={c} />,
  // folded tag (square with a sheared top edge)
  (c) => <path d="M3.5 2.5 16.5 5v12.5h-13V2.5Z" fill={c} />,
]

function hash(input: string): number {
  // FNV-1a
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  // final avalanche so low bits (used for % below) are well mixed
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  return h >>> 0
}

export function TokenIdenticon({ seed, size = 22 }: { seed: string; size?: number }) {
  const h = hash(seed)
  const shape = SHAPES[h % SHAPES.length]
  const shade = SHADES[(h >>> 8) % SHADES.length]
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" focusable="false" className="token-identicon">
      {shape(shade)}
    </svg>
  )
}

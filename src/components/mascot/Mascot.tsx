import heroUrl from '../../assets/mascot/hero.svg'
import headUrl from '../../assets/mascot/head.svg'
import explainUrl from '../../assets/mascot/explain.svg'
import happyUrl from '../../assets/mascot/happy.svg'
import './mascot.css'

// The mascot art lives in static SVG files (src/assets/mascot) and is rendered
// with <img>, so repeated instances never clash on gradient/filter ids.

export type MascotPose = 'hero' | 'head' | 'explain' | 'happy'

const ART: Record<MascotPose, { src: string; w: number; h: number; alt: string }> = {
  hero: { src: heroUrl, w: 640, h: 520, alt: 'mopi, a fluffy mint cleaner, sweeping empty token accounts into a pile' },
  head: { src: headUrl, w: 120, h: 120, alt: 'mopi' },
  explain: { src: explainUrl, w: 260, h: 260, alt: 'mopi explaining' },
  happy: { src: happyUrl, w: 260, h: 260, alt: 'mopi celebrating' },
}

export const MASCOT_ASPECT: Record<MascotPose, number> = {
  hero: 640 / 520,
  head: 1,
  explain: 1,
  happy: 1,
}

export function Mascot({
  pose,
  width,
  className,
  decorative = false,
  priority = false,
}: {
  pose: MascotPose
  /** Rendered width in px (height follows the art's aspect ratio). Omit to fill the container. */
  width?: number
  className?: string
  /** Hide from assistive tech when the mascot is purely decorative. */
  decorative?: boolean
  /** Eager-load (above the fold). */
  priority?: boolean
}) {
  const art = ART[pose]
  return (
    <img
      src={art.src}
      width={width ?? art.w}
      height={width ? Math.round((width * art.h) / art.w) : art.h}
      alt={decorative ? '' : art.alt}
      aria-hidden={decorative || undefined}
      className={['mascot', `mascot--${pose}`, className].filter(Boolean).join(' ')}
      loading={priority ? 'eager' : 'lazy'}
      // The hero scene is the largest above-the-fold image (also preloaded in index.html).
      fetchPriority={priority && pose === 'hero' ? 'high' : undefined}
      decoding="async"
      draggable={false}
    />
  )
}

/** Logo lockup: mascot head + "mopi" wordmark. */
export function Logo({ size = 'md' }: { size?: 'sm' | 'md' }) {
  const px = size === 'sm' ? 34 : 42
  return (
    <span className={`logo logo--${size}`}>
      <Mascot pose="head" width={px} decorative priority />
      <span className="logo__word">mopi</span>
    </span>
  )
}

import type { ReactNode } from 'react'
import { Mascot, type MascotPose } from '../mascot/Mascot'
import { cx } from '../ui'
import './page.css'

/** Wrapper for secondary pages: consistent top/bottom rhythm. */
export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('page container', className)}>{children}</div>
}

/** Eyebrow + big two-tone headline + lede, with an optional mascot cameo. */
export function PageIntro({
  eyebrow,
  title,
  accent,
  lede,
  mascot,
  bubble,
  children,
}: {
  eyebrow: string
  title: ReactNode
  /** Second headline line, in forest green. */
  accent?: ReactNode
  lede?: ReactNode
  mascot?: MascotPose
  /** Small speech bubble next to the mascot. */
  bubble?: ReactNode
  children?: ReactNode
}) {
  return (
    <header className={cx('page-intro', mascot && 'page-intro--art')}>
      <div className="page-intro__text">
        <p className="eyebrow page-intro__eyebrow">{eyebrow}</p>
        <h1 className="page-intro__title">
          <span>{title}</span>
          {accent && <span className="page-intro__accent">{accent}</span>}
        </h1>
        {lede && <p className="page-intro__lede">{lede}</p>}
        {children && <div className="page-intro__extra">{children}</div>}
      </div>
      {mascot && (
        <div className="page-intro__art" aria-hidden="true">
          {bubble && <span className="page-intro__bubble">{bubble}</span>}
          <Mascot pose={mascot} decorative priority />
        </div>
      )}
    </header>
  )
}

export function Section({
  id,
  eyebrow,
  title,
  intro,
  children,
  className,
}: {
  id?: string
  eyebrow?: string
  title: ReactNode
  intro?: ReactNode
  children: ReactNode
  className?: string
}) {
  const headingId = id ? `${id}-title` : undefined
  return (
    <section id={id} className={cx('page-section', className)} aria-labelledby={headingId}>
      <div className="page-section__head">
        {eyebrow && <p className="eyebrow page-section__eyebrow">{eyebrow}</p>}
        <h2 id={headingId} className="page-section__title">
          {title}
        </h2>
        {intro && <p className="page-section__intro">{intro}</p>}
      </div>
      {children}
    </section>
  )
}

/** Mint call-to-action band used at the bottom of secondary pages. */
export function CtaBand({
  title,
  copy,
  children,
  mascot = 'happy',
}: {
  title: ReactNode
  copy?: ReactNode
  children: ReactNode
  mascot?: MascotPose
}) {
  return (
    <aside className="cta-band" aria-label="Next step">
      <Mascot pose={mascot} width={88} decorative className="cta-band__art" />
      <div className="cta-band__text">
        <p className="cta-band__title">{title}</p>
        {copy && <p className="cta-band__copy">{copy}</p>}
      </div>
      <div className="cta-band__actions">{children}</div>
    </aside>
  )
}

/** Anchor styled like a Button (keeps real links as links). */
export function LinkButton({
  href,
  children,
  variant = 'primary',
  size = 'md',
  iconRight,
  external,
  className,
  onClick,
}: {
  href: string
  children: ReactNode
  variant?: 'primary' | 'secondary' | 'mint' | 'ghost'
  size?: 'sm' | 'md' | 'lg'
  iconRight?: ReactNode
  external?: boolean
  className?: string
  onClick?: () => void
}) {
  return (
    <a
      href={href}
      className={cx('btn', `btn--${variant}`, size !== 'md' && `btn--${size}`, className)}
      onClick={onClick}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
    >
      {children}
      {iconRight}
    </a>
  )
}

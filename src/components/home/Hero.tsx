import { Icon, type IconName } from '../ui'
import { Mascot } from '../mascot/Mascot'
import './Hero.css'

const FEATURES: Array<{ icon: IconName; label: string }> = [
  { icon: 'search', label: 'Public address scan' },
  { icon: 'shield', label: 'Wallet-approved' },
  { icon: 'doc', label: 'Fees shown first' },
]

export function Hero() {
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="hero__text">
        <p className="eyebrow hero__eyebrow">A tiny cleaner for your Solana wallet</p>
        <h1 id="hero-title" className="hero__title">
          <span className="hero__line">Clean up.</span>{' '}
          <span className="hero__line hero__line--green">Get your SOL back.</span>
        </h1>
        <p className="hero__sub">Find empty token accounts. Review the fees. Return their account SOL to your wallet.</p>
        <ul className="hero__features" aria-label="How mopi works">
          {FEATURES.map((f) => (
            <li key={f.label} className="hero__feature">
              <Icon name={f.icon} size={20} />
              {f.label}
            </li>
          ))}
        </ul>
      </div>

      <HeroScene />
    </section>
  )
}

/** Mascot art with HTML overlays positioned in % of the 640×520 art box. */
function HeroScene() {
  return (
    <div className="hero-scene">
      <div className="hero-scene__float">
        <Mascot pose="hero" priority className="hero-scene__art" />
      </div>
      <p className="hero-scene__bubble">
        Found a <br />
        little SOL.
      </p>
      <span className="hero-scene__tag hero-scene__tag--tokens" aria-hidden="true">
        0 tokens
      </span>
      <span className="hero-scene__tag hero-scene__tag--empty" aria-hidden="true">
        empty account
      </span>
    </div>
  )
}

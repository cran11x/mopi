import { Hero } from '../components/home/Hero'
import { StepsStrip } from '../components/home/StepsStrip'
import { ScanForm } from '../components/home/ScanForm'
import { ScanSummary } from '../components/home/ScanSummary'
import { AccountsPanel } from '../components/home/AccountsPanel'
import { PreviewCard } from '../components/home/PreviewCard'
import { ExplainsCard } from '../components/home/ExplainsCard'
import { HowStrip } from '../components/home/HowStrip'
import { HolderBanner } from '../components/home/HolderBanner'
import { ReviewModal } from '../components/review/ReviewModal'
import './HomePage.css'

/**
 * The "Clean wallet" page. Rendered inside App's layout (which owns <main>,
 * the header, footer and mobile nav), so this returns a plain wrapper.
 *
 * The scan panel is split into three grid items (form / summary / accounts)
 * so the mobile layout can slot the cleanup preview between the stat tiles
 * and the account list purely with grid-template-areas.
 */
export function HomePage() {
  return (
    <div className="home">
      <div className="container">
        <Hero />
      </div>

      <div className="container home__stack">
        <StepsStrip className="home__steps" />

        <section className="home__main" aria-labelledby="scan-heading">
          <div className="home__panel" aria-hidden="true" />
          <ScanForm className="home__form" />
          <ScanSummary className="home__summary" />
          <AccountsPanel className="home__accounts" />
          <div className="home__side">
            <PreviewCard className="home__preview" />
            <ExplainsCard className="home__explains" />
          </div>
        </section>

        <HowStrip className="home__how" />
        <HolderBanner className="home__holder" />
      </div>

      <ReviewModal />
    </div>
  )
}

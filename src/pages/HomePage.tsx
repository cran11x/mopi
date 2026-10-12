import { Suspense, lazy } from 'react'
import { Hero } from '../components/home/Hero'
import { StepsStrip } from '../components/home/StepsStrip'
import { ScanForm } from '../components/home/ScanForm'
import { ScanSummary } from '../components/home/ScanSummary'
import { AccountsPanel } from '../components/home/AccountsPanel'
import { PreviewCard } from '../components/home/PreviewCard'
import { ExplainsCard } from '../components/home/ExplainsCard'
import { HowStrip } from '../components/home/HowStrip'
import { HolderBanner } from '../components/home/HolderBanner'
import { useCleaner } from '../state/cleaner'
import { loadReviewModal } from '../components/review/loadReviewModal'
import './HomePage.css'

const ReviewModal = lazy(() => loadReviewModal().then((m) => ({ default: m.ReviewModal })))

/**
 * The "Clean wallet" page. Rendered inside App's layout (which owns <main>,
 * the header, footer and mobile nav), so this returns a plain wrapper.
 *
 * The scan panel is split into three grid items (form / summary / accounts)
 * so the mobile layout can slot the cleanup preview between the stat tiles
 * and the account list purely with grid-template-areas.
 *
 * Reading/focus order deliberately stays form → results → account list →
 * preview (select first, then review) on every width. On phones the preview
 * is drawn above the list, so focus moves from the list back up to it: a known
 * deviation from the visual order. It keeps the select-then-review sequence and
 * avoids rendering the preview twice.
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

      <ReviewModalSlot />
    </div>
  )
}

/**
 * The review dialog loads on first use (prefetched when "Review" is hovered or
 * focused). Kept in its own component so only this slot, not the whole page,
 * re-renders when the cleaner state changes.
 */
function ReviewModalSlot() {
  const { cleanup } = useCleaner()
  if (cleanup.phase === 'idle') return null
  return (
    <Suspense fallback={null}>
      <ReviewModal />
    </Suspense>
  )
}

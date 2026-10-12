import { AppProviders } from './state/AppProviders'
import { useRoute } from './lib/router'
import { HomePage } from './pages/HomePage'
import { HowItWorksPage } from './pages/HowItWorksPage'
import { FeesPage } from './pages/FeesPage'
import { DocsPage } from './pages/DocsPage'
import { BenefitsPage } from './pages/BenefitsPage'
import { WalletsPage } from './pages/WalletsPage'

function Routes() {
  const { route } = useRoute()
  switch (route) {
    case 'how-it-works':
      return <HowItWorksPage />
    case 'fees':
      return <FeesPage />
    case 'docs':
      return <DocsPage />
    case 'benefits':
      return <BenefitsPage />
    case 'wallets':
      return <WalletsPage />
    default:
      return <HomePage />
  }
}

export function App() {
  return (
    <AppProviders>
      <Routes />
    </AppProviders>
  )
}

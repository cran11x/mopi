import { useEffect } from 'react'
import { useCleaner } from '../../state/cleaner'
import { recordScan, useWatchlist } from '../../state/watchlist'

/** Keeps saved wallets' "last scan" summaries in step with real (non-demo) scans. */
export function WatchlistSync() {
  const { scan } = useCleaner()
  const { wallets } = useWatchlist()
  const isSaved = Boolean(scan && wallets.some((w) => w.address === scan.owner))

  useEffect(() => {
    if (!scan || scan.isDemo || !isSaved) return
    recordScan(scan.owner, {
      at: scan.scannedAt,
      cluster: scan.cluster,
      eligible: scan.eligible.length,
      reclaimLamports: scan.eligible.reduce((sum, a) => sum + a.lamports, 0),
    })
  }, [scan, isSaved])

  return null
}

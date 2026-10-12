import { memo, useEffect, useState, type MouseEvent } from 'react'
import { useCleaner } from '../../state/cleaner'
import { explorerAccountUrl } from '../../config'
import { formatSol, formatTokenAmount, ordinal2, shortAddress } from '../../lib/format'
import type { ScanResult, TokenAccountInfo } from '../../lib/types'
import { Checkbox, Chip, Icon, Tabs, cx } from '../ui'
import { Mascot } from '../mascot/Mascot'
import { TokenIdenticon } from './TokenIdenticon'
import './AccountsPanel.css'

type TabKey = 'eligible' | 'skipped'
const PREVIEW_ROWS = 4
const ID_BASE = 'accounts'

export function AccountsPanel({ className }: { className?: string }) {
  const { scan, scanStatus, scanError } = useCleaner()
  const [tab, setTab] = useState<TabKey>('eligible')
  const [expanded, setExpanded] = useState(false)
  const scanning = scanStatus === 'scanning'

  // A new scan collapses the list and returns to the eligible tab.
  const scanKey = scan ? `${scan.owner}:${scan.scannedAt}` : ''
  useEffect(() => {
    setExpanded(false)
    setTab('eligible')
  }, [scanKey])

  const eligibleCount = scan?.eligible.length ?? 0
  const skippedCount = scan ? scan.withTokens.length + scan.unsupported.length : 0
  const showCounts = Boolean(scan) && !scanning

  return (
    <div className={cx('accounts', className)}>
      <Tabs<TabKey>
        className="accounts__tabs"
        idBase={ID_BASE}
        label="Scan results"
        value={tab}
        onChange={(k) => {
          setTab(k)
          setExpanded(false)
        }}
        items={[
          { key: 'eligible', label: showCounts ? `Eligible (${eligibleCount})` : 'Eligible' },
          { key: 'skipped', label: showCounts ? `Skipped (${skippedCount})` : 'Skipped' },
        ]}
      />

      <div
        className="accounts__panel"
        role="tabpanel"
        id={`${ID_BASE}-panel-${tab}`}
        aria-labelledby={`${ID_BASE}-tab-${tab}`}
        aria-busy={scanning || undefined}
      >
        <p className="sr-only" aria-live="polite">
          {scanning ? 'Scanning wallet…' : scan ? `Scan complete. ${eligibleCount} eligible, ${skippedCount} skipped.` : ''}
        </p>
        {scanning ? (
          <SkeletonTable />
        ) : !scan ? (
          <Prompt hasError={Boolean(scanError)} />
        ) : tab === 'eligible' ? (
          scan.eligible.length === 0 ? (
            <TidyState />
          ) : (
            <EligibleTable scan={scan} expanded={expanded} onToggleExpanded={() => setExpanded((v) => !v)} />
          )
        ) : (
          <SkippedTable scan={scan} expanded={expanded} onToggleExpanded={() => setExpanded((v) => !v)} />
        )}
      </div>

      <p className="accounts__note">
        <Icon name="info" size={18} />
        Accounts with tokens are skipped.
      </p>
    </div>
  )
}

/* ---------- Eligible ---------- */

function EligibleTable({
  scan,
  expanded,
  onToggleExpanded,
}: {
  scan: ScanResult
  expanded: boolean
  onToggleExpanded: () => void
}) {
  const { selected, toggleAccount, setAllSelected } = useCleaner()
  const rows = expanded ? scan.eligible : scan.eligible.slice(0, PREVIEW_ROWS)
  const selectedCount = scan.eligible.reduce((n, a) => n + (selected.has(a.address) ? 1 : 0), 0)
  const all = selectedCount === scan.eligible.length && selectedCount > 0
  const some = selectedCount > 0 && !all

  return (
    <>
      {/* Phone only: the table header (and its select-all box) is hidden at ≤720px,
          so offer the same bulk action as a compact control above the rows. */}
      <div className="acct-bulk">
        <span className="acct-bulk__count tabular">
          {selectedCount} of {scan.eligible.length} selected
        </span>
        <button type="button" className="link acct-bulk__btn" onClick={() => setAllSelected(!all)}>
          {all ? 'Clear all' : 'Select all'}
        </button>
      </div>
      <div className="acct-table" role="table" aria-label="Eligible accounts" aria-rowcount={scan.eligible.length + 1}>
        <div role="rowgroup">
          <div role="row" className="acct-row acct-row--head" aria-rowindex={1}>
            <div role="columnheader" className="acct-row__check">
              <Checkbox
                checked={all}
                indeterminate={some}
                onChange={() => setAllSelected(!all)}
                label={all ? 'Deselect all eligible accounts' : 'Select all eligible accounts'}
              />
            </div>
            <div role="columnheader" className="acct-row__account">
              Account
            </div>
            <div role="columnheader" className="acct-row__bal">
              Token balance
            </div>
            <div role="columnheader" className="acct-row__sol">
              Account SOL
            </div>
            <div role="columnheader" className="acct-row__status">
              Status
            </div>
          </div>
        </div>
        <div role="rowgroup">
          {rows.map((a, i) => (
            <EligibleRow
              key={a.address}
              account={a}
              index={i}
              isOn={selected.has(a.address)}
              isDemo={scan.isDemo}
              cluster={scan.cluster}
              onToggle={toggleAccount}
            />
          ))}
        </div>
      </div>
      <TableFooter
        shown={rows.length}
        total={scan.eligible.length}
        noun="eligible accounts"
        expanded={expanded}
        onToggle={onToggleExpanded}
      />
    </>
  )
}

/**
 * Memoized so a keystroke in the scan field or a toggle on one row does not
 * re-render the other rows (`onToggle` is the stable `toggleAccount`).
 */
const EligibleRow = memo(function EligibleRow({
  account: a,
  index: i,
  isOn,
  isDemo,
  cluster,
  onToggle,
}: {
  account: TokenAccountInfo
  index: number
  isOn: boolean
  isDemo: boolean
  cluster: ScanResult['cluster']
  onToggle: (address: string) => void
}) {
  const name = `Account ${ordinal2(i + 1)}`
  const onRowClick = (e: MouseEvent<HTMLDivElement>) => {
    // Let links, the checkbox itself and text selection behave normally.
    const target = e.target as HTMLElement
    if (target.closest('a, input, button, label')) return
    if (window.getSelection()?.toString()) return
    onToggle(a.address)
  }
  return (
    <div
      role="row"
      aria-rowindex={i + 2}
      aria-selected={isOn}
      className={cx('acct-row', !isOn && 'acct-row--off')}
      onClick={onRowClick}
    >
      <div role="cell" className="acct-row__check">
        <Checkbox checked={isOn} onChange={() => onToggle(a.address)} label={`Select ${name}`} />
      </div>
      <div role="cell" className="acct-row__account">
        <AccountName account={a} name={name} isDemo={isDemo} cluster={cluster} />
      </div>
      <div role="cell" className="acct-row__bal tabular">
        {formatTokenAmount(a.uiAmount)}
        <span className="acct-row__unit"> tokens</span>
      </div>
      <div role="cell" className="acct-row__sol tabular">
        {formatSol(a.lamports, { decimals: 3 })} SOL
      </div>
      <div role="cell" className="acct-row__status">
        <Chip tone="mint" className="acct-chip">
          Eligible
        </Chip>
      </div>
    </div>
  )
})

/* ---------- Skipped ---------- */

function SkippedTable({
  scan,
  expanded,
  onToggleExpanded,
}: {
  scan: ScanResult
  expanded: boolean
  onToggleExpanded: () => void
}) {
  const skipped = [...scan.withTokens, ...scan.unsupported]
  if (skipped.length === 0) {
    return (
      <div className="accounts__empty accounts__empty--small">
        <p className="accounts__empty-title">Nothing skipped.</p>
        <p className="accounts__empty-text">Every token account in this wallet is empty and supported.</p>
      </div>
    )
  }
  const rows = expanded ? skipped : skipped.slice(0, PREVIEW_ROWS)
  const offset = scan.eligible.length

  return (
    <>
      <div className="acct-table acct-table--skipped" role="table" aria-label="Skipped accounts" aria-rowcount={skipped.length + 1}>
        <div role="rowgroup">
          <div role="row" className="acct-row acct-row--head" aria-rowindex={1}>
            <div role="columnheader" className="acct-row__check">
              <span className="sr-only">Selectable</span>
            </div>
            <div role="columnheader" className="acct-row__account">
              Account
            </div>
            <div role="columnheader" className="acct-row__bal">
              Token balance
            </div>
            <div role="columnheader" className="acct-row__sol">
              Account SOL
            </div>
            <div role="columnheader" className="acct-row__status">
              Status
            </div>
          </div>
        </div>
        <div role="rowgroup">
          {rows.map((a, i) => {
            const name = `Account ${ordinal2(offset + i + 1)}`
            const hasTokens = a.status === 'has-tokens'
            return (
              <div key={a.address} role="row" aria-rowindex={i + 2} className="acct-row acct-row--skipped">
                <div role="cell" className="acct-row__check">
                  <span className="acct-row__lock" title="Not selectable">
                    <Icon name={hasTokens ? 'lock' : 'alert'} size={15} />
                    <span className="sr-only">Not selectable</span>
                  </span>
                </div>
                <div role="cell" className="acct-row__account">
                  <AccountName account={a} name={name} isDemo={scan.isDemo} cluster={scan.cluster} />
                </div>
                <div role="cell" className="acct-row__bal tabular">
                  {formatTokenAmount(a.uiAmount)}
                  <span className="acct-row__unit"> tokens</span>
                </div>
                <div role="cell" className="acct-row__sol tabular">
                  {formatSol(a.lamports, { decimals: 3 })} SOL
                </div>
                <div role="cell" className="acct-row__status">
                  <Chip tone={hasTokens ? 'neutral' : 'rose'} className="acct-chip">
                    {hasTokens ? 'Has tokens' : 'Unsupported'}
                  </Chip>
                  {a.reasonText && <span className="sr-only">{a.reasonText}</span>}
                </div>
                {a.reasonText && (
                  <p className="acct-row__reason" aria-hidden="true">
                    {a.reasonText}
                  </p>
                )}
              </div>
            )
          })}
        </div>
      </div>
      <TableFooter shown={rows.length} total={skipped.length} noun="skipped accounts" expanded={expanded} onToggle={onToggleExpanded} />
    </>
  )
}

/* ---------- Pieces ---------- */

function AccountName({
  account,
  name,
  isDemo,
  cluster,
}: {
  account: TokenAccountInfo
  name: string
  isDemo: boolean
  cluster: ScanResult['cluster']
}) {
  const short = shortAddress(account.address)
  return (
    <span className="acct-name">
      <TokenIdenticon seed={account.mint} />
      <span className="acct-name__text">
        <span className="acct-name__label">{name}</span>
        {isDemo ? (
          <span className="acct-name__addr mono" title={account.address}>
            {short}
          </span>
        ) : (
          <a
            className="acct-name__addr acct-name__addr--link mono"
            href={explorerAccountUrl(account.address, cluster)}
            target="_blank"
            rel="noreferrer noopener"
            title={`${account.address} — open in explorer`}
          >
            {short}
            <span className="sr-only"> (opens explorer in a new tab)</span>
          </a>
        )}
      </span>
    </span>
  )
}

function TableFooter({
  shown,
  total,
  noun,
  expanded,
  onToggle,
}: {
  shown: number
  total: number
  noun: string
  expanded: boolean
  onToggle: () => void
}) {
  return (
    <div className="accounts__foot">
      <span className="accounts__count">
        Showing {shown} of {total} {noun}
      </span>
      {total > PREVIEW_ROWS && (
        <button type="button" className="link accounts__more" onClick={onToggle} aria-expanded={expanded}>
          {expanded ? 'Show less' : 'View all'}
          <Icon name="arrow-right" size={14} className={cx('accounts__more-icon', expanded && 'is-up')} />
        </button>
      )}
    </div>
  )
}

function SkeletonTable() {
  return (
    <div className="acct-table acct-table--loading" aria-hidden="true">
      <div className="acct-row acct-row--head">
        <div className="acct-row__check">
          <span className="acct-skel acct-skel--box" />
        </div>
        <div className="acct-row__account">Account</div>
        <div className="acct-row__bal">Token balance</div>
        <div className="acct-row__sol">Account SOL</div>
        <div className="acct-row__status">Status</div>
      </div>
      {Array.from({ length: PREVIEW_ROWS }, (_, i) => (
        <div key={i} className="acct-row">
          <div className="acct-row__check">
            <span className="acct-skel acct-skel--box" />
          </div>
          <div className="acct-row__account">
            <span className="acct-name">
              <span className="acct-skel acct-skel--icon" />
              <span className="acct-name__text">
                <span className="acct-skel" style={{ width: 72 }} />
                <span className="acct-skel acct-skel--thin" style={{ width: 88 }} />
              </span>
            </span>
          </div>
          <div className="acct-row__bal">
            <span className="acct-skel" style={{ width: 20 }} />
          </div>
          <div className="acct-row__sol">
            <span className="acct-skel" style={{ width: 70 }} />
          </div>
          <div className="acct-row__status">
            <span className="acct-skel acct-skel--pill" />
          </div>
        </div>
      ))}
    </div>
  )
}

function TidyState() {
  return (
    <div className="accounts__empty">
      <Mascot pose="happy" width={128} decorative />
      <div>
        <p className="accounts__empty-title">Nothing to clean — this wallet is already tidy.</p>
        <p className="accounts__empty-text">
          mopi found no empty token accounts it can close. Accounts that hold tokens are never touched.
        </p>
      </div>
    </div>
  )
}

function Prompt({ hasError }: { hasError: boolean }) {
  return (
    <div className="accounts__empty accounts__empty--small">
      <span className="accounts__prompt-icon" aria-hidden="true">
        <Icon name="search" size={22} />
      </span>
      <div>
        <p className="accounts__empty-title">{hasError ? 'Check the address and scan again.' : 'No wallet scanned yet.'}</p>
        <p className="accounts__empty-text">
          Paste a public Solana address above, or try the demo wallet. Scanning only reads public data.
        </p>
      </div>
    </div>
  )
}

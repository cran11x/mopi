import { describe, expect, it } from 'vitest'
import { addWallet, normalizeAddress, parseStored } from './watchlist'

const A = 'GmaDr7kQ2vNw8XpLs4TfHc9ZyB3uMe6RjWnK5aYqAEGB'
const B = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'

describe('watchlist helpers', () => {
  it('validates addresses', () => {
    expect(normalizeAddress(`  ${A} `)).toBe(A)
    expect(normalizeAddress('1')).toBeNull()
    expect(normalizeAddress('not an address')).toBeNull()
    expect(normalizeAddress(`${A}0`)).toBeNull()
  })

  it('adds, dedupes and enforces the limit', () => {
    const first = addWallet([], ' Main ', A, 1, 1)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.wallets[0]).toMatchObject({ label: 'Main', address: A, addedAt: 1 })

    const dupe = addWallet(first.wallets, 'Again', A, null)
    expect(dupe).toEqual({ ok: false, error: 'This wallet is already on your list.' })

    const limited = addWallet(first.wallets, 'Second', B, 1)
    expect(limited.ok).toBe(false)

    const unlimited = addWallet(first.wallets, '', B, null)
    expect(unlimited.ok && unlimited.wallets[1].label).toBe('Wallet 2')
  })

  it('rejects bad input with a message', () => {
    expect(addWallet([], 'x', '', null)).toEqual({ ok: false, error: 'Paste a wallet address to save.' })
    expect(addWallet([], 'x', 'abc', null).ok).toBe(false)
  })

  it('parses stored data defensively', () => {
    expect(parseStored(null)).toEqual([])
    expect(parseStored('{oops')).toEqual([])
    expect(parseStored(JSON.stringify({ a: 1 }))).toEqual([])
    const good = { id: '1', label: 'Main', address: A, addedAt: 1 }
    const parsed = parseStored(JSON.stringify([good, { ...good, id: '2' }, { id: 3 }, { ...good, id: '4', address: 'bad' }]))
    expect(parsed).toEqual([good])
  })
})

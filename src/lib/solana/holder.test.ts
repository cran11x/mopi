import type { Connection, PublicKey } from '@solana/web3.js'
import { describe, expect, it, vi } from 'vitest'
import { CONFIG } from '../../config'
import { checkHolderStatus, getHolderStatus, sumWholeTokens } from './holder'
import { parsedData, randomAddress, randomKey } from '../../test/solanaFixtures'

const ownerKey = randomKey()
const owner = ownerKey.toBase58()
const mint = randomAddress()

const acct = (amount: string, decimals = 6, over: { mint?: string; owner?: string } = {}) => ({
  pubkey: randomKey(),
  account: { data: parsedData(owner, { mint: over.mint ?? mint, owner: over.owner ?? owner, amount, decimals }) },
})

function conn(value: unknown[]) {
  const fn = vi.fn(async (_o: PublicKey, _f: { mint: PublicKey }, _c?: string) => ({ context: { slot: 1 }, value }))
  return { connection: { getParsedTokenAccountsByOwner: fn } as unknown as Connection, fn }
}

describe('holder status', () => {
  it('no mint configured → no RPC, planned perks', async () => {
    const { connection, fn } = conn([])
    const s = await checkHolderStatus(connection, ownerKey, { mint: null, minRequired: 100_000 })
    expect(s).toEqual({ mintConfigured: false, checked: false, isHolder: false, balanceUi: 0, minRequired: 100_000 })
    expect(fn).not.toHaveBeenCalled()
  })

  it('getHolderStatus uses CONFIG (no RPC while CONFIG.mopiMint is unset)', async () => {
    const { connection, fn } = conn([])
    const s = await getHolderStatus(connection, ownerKey)
    expect(s.minRequired).toBe(CONFIG.holderMin)
    if (!CONFIG.mopiMint) {
      expect(s.mintConfigured).toBe(false)
      expect(fn).not.toHaveBeenCalled()
    }
  })

  it('filters by mint and sums across accounts with BigInt, flooring to whole tokens', async () => {
    const { connection, fn } = conn([acct('60000000000'), acct('39999999999')]) // 60000 + 39999.999999
    const s = await checkHolderStatus(connection, ownerKey, { mint, minRequired: 100_000 })
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn.mock.calls[0][1].mint.toBase58()).toBe(mint)
    expect(fn.mock.calls[0][2]).toBe('confirmed')
    expect(s).toEqual({ mintConfigured: true, checked: true, isHolder: false, balanceUi: 99_999, minRequired: 100_000 })
  })

  it('exactly the minimum is a holder', async () => {
    const { connection } = conn([acct('60000000000'), acct('40000000000')])
    const s = await checkHolderStatus(connection, ownerKey, { mint, minRequired: 100_000 })
    expect(s.isHolder).toBe(true)
    expect(s.balanceUi).toBe(100_000)
  })

  it('ignores other mints / owners and malformed entries', async () => {
    const { connection } = conn([
      acct('500000000000'),
      acct('999999999999999', 6, { mint: randomAddress() }),
      acct('999999999999999', 6, { owner: randomAddress() }),
      { pubkey: randomKey(), account: { data: new Uint8Array(10) } },
      null,
    ])
    const s = await checkHolderStatus(connection, ownerKey, { mint, minRequired: 100_000 })
    expect(s.balanceUi).toBe(500_000)
    expect(s.isHolder).toBe(true)
  })

  it('no accounts → 0', async () => {
    const { connection } = conn([])
    const s = await checkHolderStatus(connection, ownerKey, { mint, minRequired: 1 })
    expect(s).toMatchObject({ checked: true, isHolder: false, balanceUi: 0 })
  })

  it('handles u64 amounts beyond Number precision', () => {
    const big = '18446744073709551615' // u64 max, 0 decimals
    expect(sumWholeTokens([acct(big, 0), acct('1', 0)], mint, owner)).toBe(18446744073709551616n)
  })

  it('propagates RPC errors (state layer handles them)', async () => {
    const connection = {
      getParsedTokenAccountsByOwner: vi.fn(async () => {
        throw new Error('boom')
      }),
    } as unknown as Connection
    await expect(checkHolderStatus(connection, ownerKey, { mint, minRequired: 1 })).rejects.toThrow('boom')
  })
})

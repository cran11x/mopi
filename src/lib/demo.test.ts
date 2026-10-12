import { describe, expect, it } from 'vitest'
import {
  DEMO_OWNER,
  TOKEN_ACCOUNT_RENT_LAMPORTS,
  createDemoScan,
  demoFeeConfig,
  isDemoAddress,
  isExampleServiceFee,
} from './demo'
import { buildQuote } from './solana/fees'
import { testFeeConfig } from '../test/solanaFixtures'

describe('demo scan', () => {
  it('has 24 eligible, 6 with tokens, 1 unsupported', () => {
    const s = createDemoScan('mainnet-beta', 0)
    expect(s.eligible).toHaveLength(24)
    expect(s.withTokens).toHaveLength(6)
    expect(s.unsupported).toHaveLength(1)
    expect(s.accounts).toHaveLength(31)
    expect(s.accounts).toEqual([...s.eligible, ...s.withTokens, ...s.unsupported])
    expect(s.isDemo).toBe(true)
    expect(s.owner).toBe(DEMO_OWNER)
    expect(s.eligible.every((a) => a.status === 'eligible' && a.amountRaw === '0')).toBe(true)
    expect(s.withTokens.every((a) => a.status === 'has-tokens' && a.amountRaw !== '0' && a.reasonText)).toBe(true)
    expect(s.unsupported[0]).toMatchObject({ status: 'unsupported', reason: 'withheld-fees', program: 'token-2022' })
  })

  it('is deterministic', () => {
    const a = createDemoScan('devnet', 123)
    const b = createDemoScan('devnet', 123)
    expect(a).toEqual(b)
    expect(createDemoScan('mainnet-beta', 1).accounts.map((x) => x.address)).toEqual(a.accounts.map((x) => x.address))
  })

  it('addresses are unique, 44 chars, and the first rows match the concept art', () => {
    const s = createDemoScan()
    const addrs = s.accounts.map((a) => a.address)
    expect(new Set(addrs).size).toBe(addrs.length)
    expect(addrs.every((a) => a.length === 44)).toBe(true)
    expect(s.eligible[0].address.startsWith('5Qx3')).toBe(true)
    expect(s.eligible[0].address.endsWith('7K9m')).toBe(true)
  })

  it('demo quote reclaims 24 × rent', () => {
    const s = createDemoScan()
    const q = buildQuote(s.eligible, demoFeeConfig(testFeeConfig({ feeWallet: null }), false))
    expect(q.reclaimLamports).toBe(24 * TOKEN_ACCOUNT_RENT_LAMPORTS)
    expect(q.batches).toHaveLength(2)
    expect(q.serviceFeeLamports).toBeGreaterThan(0)
  })

  it('marks the demo fee as an example only when this deployment has no fee wallet', () => {
    const none = demoFeeConfig(testFeeConfig({ feeWallet: null }), false)
    expect(isExampleServiceFee(none)).toBe(true)
    const real = demoFeeConfig(testFeeConfig({ feeWallet: '11111111111111111111111111111111' }), false)
    expect(isExampleServiceFee(real)).toBe(false)
    expect(isExampleServiceFee(testFeeConfig({ feeWallet: null }))).toBe(false)
  })

  it('isDemoAddress', () => {
    expect(isDemoAddress(DEMO_OWNER)).toBe(true)
    expect(isDemoAddress(' GmaD...AEGB ')).toBe(true)
    expect(isDemoAddress('GmaD…AEGB')).toBe(true)
    expect(isDemoAddress('11111111111111111111111111111111')).toBe(false)
  })
})

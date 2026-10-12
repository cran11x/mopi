import { describe, expect, it } from 'vitest'
import {
  MAX_TOKEN_2022_ACCOUNT_SPACE,
  buildQuote,
  computeUnitLimitFor,
  defaultFeeConfig,
  feeBasisFor,
  maxRentDepositFor,
  networkFeeFor,
  rentExemptMinimum,
  serviceFeeFor,
} from './fees'
import { CONFIG } from '../../config'
import { RENT, T22, eligibleAccount, randomAddress, testFeeConfig } from '../../test/solanaFixtures'

const OWNER = randomAddress()
const many = (n: number, lamports = RENT) => Array.from({ length: n }, () => eligibleAccount(OWNER, { lamports }))

describe('buildQuote', () => {
  it('totals equal the sum of the batches', () => {
    const accounts = [...many(25), ...many(18, 2_157_600)]
    const fee = testFeeConfig()
    const q = buildQuote(accounts, fee)
    expect(q.accountCount).toBe(43)
    expect(q.batches).toHaveLength(3)
    const sum = (k: 'reclaimLamports' | 'serviceFeeLamports' | 'networkFeeLamports') =>
      q.batches.reduce((s, b) => s + b[k], 0)
    expect(q.reclaimLamports).toBe(sum('reclaimLamports'))
    expect(q.serviceFeeLamports).toBe(sum('serviceFeeLamports'))
    expect(q.networkFeeLamports).toBe(sum('networkFeeLamports'))
    expect(q.reclaimLamports).toBe(25 * RENT + 18 * 2_157_600)
    expect(q.netLamports).toBe(q.reclaimLamports - q.serviceFeeLamports - q.networkFeeLamports)
    expect(q.batches.flatMap((b) => b.accounts)).toEqual(accounts)
    q.batches.forEach((b, i) => {
      expect(b.index).toBe(i)
      expect(b.reclaimLamports).toBe(b.accounts.reduce((s, a) => s + a.lamports, 0))
      expect(b.computeUnitLimit).toBe(fee.computeUnitsBase + b.accounts.length * fee.computeUnitsPerClose)
    })
  })

  it('splits at maxClosesPerTx', () => {
    expect(buildQuote(many(20), testFeeConfig()).batches.map((b) => b.accounts.length)).toEqual([20])
    expect(buildQuote(many(21), testFeeConfig()).batches.map((b) => b.accounts.length)).toEqual([20, 1])
    expect(buildQuote(many(7), testFeeConfig({ maxClosesPerTx: 3 })).batches.map((b) => b.accounts.length)).toEqual([3, 3, 1])
    // Defensive: nonsense batch size still makes progress.
    expect(buildQuote(many(2), testFeeConfig({ maxClosesPerTx: 0 })).batches).toHaveLength(2)
  })

  it('floors the service fee per batch', () => {
    const fee = testFeeConfig({ serviceFeeBps: 400 })
    const q = buildQuote(many(1, 2_039_281), fee)
    // 2_039_281 * 0.04 = 81_571.24 → 81_571
    expect(q.batches[0].serviceFeeLamports).toBe(81_571)
    expect(serviceFeeFor(24, fee)).toBe(0)
    expect(serviceFeeFor(25, fee)).toBe(1)
  })

  it('charges no service fee (and reports 0 bps) without a fee wallet', () => {
    const q = buildQuote(many(5), testFeeConfig({ feeWallet: null, serviceFeeBps: 400 }))
    expect(q.serviceFeeLamports).toBe(0)
    expect(q.serviceFeeBps).toBe(0)
    expect(q.batches.every((b) => b.serviceFeeLamports === 0)).toBe(true)
  })

  it('applies the holder rate', () => {
    const accounts = many(10)
    const standard = buildQuote(accounts, testFeeConfig({ serviceFeeBps: 400 }))
    const holder = buildQuote(accounts, testFeeConfig({ serviceFeeBps: 200 }), { isHolderRate: true })
    expect(holder.isHolderRate).toBe(true)
    expect(standard.isHolderRate).toBe(false)
    expect(holder.serviceFeeBps).toBe(200)
    expect(holder.serviceFeeLamports).toBe(Math.floor((10 * RENT * 200) / 10_000))
    expect(holder.serviceFeeLamports).toBeLessThan(standard.serviceFeeLamports)
  })

  it('ignores accounts that are not eligible', () => {
    const accounts = [
      ...many(2),
      eligibleAccount(OWNER, { status: 'has-tokens', amountRaw: '5' }),
      eligibleAccount(OWNER, { status: 'unsupported', reason: 'frozen' }),
    ]
    const q = buildQuote(accounts, testFeeConfig())
    expect(q.accountCount).toBe(2)
  })

  it('empty selection → empty quote', () => {
    const q = buildQuote([], testFeeConfig())
    expect(q).toMatchObject({ accountCount: 0, reclaimLamports: 0, networkFeeLamports: 0, serviceFeeLamports: 0, netLamports: 0, batches: [] })
  })

  it('net is never negative', () => {
    const q = buildQuote(many(1, 1_000), testFeeConfig())
    expect(q.netLamports).toBe(0)
  })

  it('network fee = base + ceil(CU * price / 1e6), price disabled at 0', () => {
    const fee = testFeeConfig({ priorityFeeMicroLamports: 20_000 })
    const cu = computeUnitLimitFor(20, fee)
    expect(cu).toBe(122_000)
    expect(networkFeeFor(cu, fee)).toBe(5_000 + 2_440)
    expect(networkFeeFor(1, testFeeConfig({ priorityFeeMicroLamports: 1 }))).toBe(5_001)
    expect(networkFeeFor(cu, testFeeConfig({ priorityFeeMicroLamports: 0 }))).toBe(5_000)
  })
})

describe('fee basis', () => {
  it('rent-exempt minimum matches the cluster rent for token accounts', () => {
    expect(rentExemptMinimum(165)).toBe(RENT)
    expect(rentExemptMinimum(182)).toBe(2_157_600)
    expect(rentExemptMinimum(0)).toBe(890_880)
    expect(MAX_TOKEN_2022_ACCOUNT_SPACE).toBe(205)
    expect(maxRentDepositFor({ program: 'spl-token' })).toBe(RENT)
    expect(maxRentDepositFor({ program: 'token-2022' })).toBe(rentExemptMinimum(205))
  })

  it('each account counts at most its plausible rent deposit', () => {
    const spl = eligibleAccount(OWNER, { lamports: 1_000_000_000 })
    const t22 = eligibleAccount(OWNER, { program: 'token-2022', programId: T22, lamports: 1_000_000_000 })
    const honest = eligibleAccount(OWNER, { program: 'token-2022', programId: T22, lamports: 2_157_600 })
    expect(feeBasisFor([spl, t22, honest])).toBe(RENT + rentExemptMinimum(205) + 2_157_600)
    expect(feeBasisFor([eligibleAccount(OWNER, { lamports: 0 })])).toBe(0)
  })

  it('the quote shows the full reclaim but charges the fee on the capped basis', () => {
    const fee = testFeeConfig({ serviceFeeBps: 400 })
    const q = buildQuote([eligibleAccount(OWNER, { lamports: RENT + 1_000_000 }), eligibleAccount(OWNER)], fee)
    expect(q.reclaimLamports).toBe(2 * RENT + 1_000_000)
    expect(q.serviceFeeLamports).toBe(serviceFeeFor(2 * RENT, fee))
  })

  it('a repeated address is quoted once', () => {
    const a = eligibleAccount(OWNER)
    const q = buildQuote([a, { ...a }, eligibleAccount(OWNER)], testFeeConfig())
    expect(q.accountCount).toBe(2)
    expect(q.batches[0].accounts.map((x) => x.address)[0]).toBe(a.address)
    expect(q.reclaimLamports).toBe(2 * RENT)
  })
})

describe('defaultFeeConfig', () => {
  it('mirrors CONFIG and zeroes the fee without a fee wallet', () => {
    const f = defaultFeeConfig(false)
    expect(f.feeWallet).toBe(CONFIG.feeWallet)
    expect(f.maxClosesPerTx).toBe(CONFIG.maxClosesPerTx)
    if (!CONFIG.feeWallet) expect(f.serviceFeeBps).toBe(0)
    else {
      expect(f.serviceFeeBps).toBe(CONFIG.serviceFeeBps)
      expect(defaultFeeConfig(true).serviceFeeBps).toBe(CONFIG.holderFeeBps)
    }
  })
})

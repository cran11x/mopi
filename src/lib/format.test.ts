import { describe, expect, it } from 'vitest'
import { formatBps, formatSol, formatTokenAmount, lamportsToSol, ordinal2, shortAddress } from './format'

describe('formatSol', () => {
  it('zero', () => {
    expect(formatSol(0)).toBe('0.0000')
    expect(formatSol(0, { unit: true })).toBe('0.0000 SOL')
    expect(formatSol(0, { sign: 'always-minus' })).toBe('0.0000')
    expect(formatSol(0, { sign: 'always-plus' })).toBe('0.0000')
  })

  it('0.046 renders exactly', () => {
    expect(formatSol(46_000_000)).toBe('0.0460')
    expect(formatSol(46_000_000, { decimals: 3 })).toBe('0.046')
  })

  it('tiny non-zero fees never render as 0.0000', () => {
    expect(formatSol(5_000)).toBe('0.000005')
    expect(formatSol(7_440)).toBe('0.0000074')
    expect(formatSol(1)).toBe('0.000000001')
    expect(formatSol(49_999)).toBe('0.00005')
    for (const l of [1, 9, 10, 99, 100, 999, 1_000, 5_001, 49_999, 50_000, 99_999]) {
      expect(formatSol(l)).not.toMatch(/^0\.0+$/)
    }
  })

  it('rounding near a boundary', () => {
    expect(formatSol(99_999)).toBe('0.0001')
    expect(formatSol(149_999)).toBe('0.0001')
    expect(formatSol(150_000)).toBe('0.0002')
  })

  it('decimals: 0 edge case never leaves a trailing dot', () => {
    expect(formatSol(999_999_999, { decimals: 0 })).toBe('1')
    expect(formatSol(1_500_000_000, { decimals: 0 })).toBe('2')
    expect(formatSol(5_000, { decimals: 0 })).toBe('0.000005')
  })

  it('larger amounts', () => {
    expect(formatSol(2_039_280)).toBe('0.0020')
    expect(formatSol(48_942_720)).toBe('0.0489')
    expect(formatSol(1_234_567_890_123, { decimals: 2, unit: true })).toBe('1234.57 SOL')
  })

  it('negatives and signs', () => {
    expect(formatSol(-46_000_000)).toBe('−0.0460')
    expect(formatSol(-5_000)).toBe('−0.000005')
    expect(formatSol(46_000_000, { sign: 'always-minus' })).toBe('−0.0460')
    expect(formatSol(46_000_000, { sign: 'always-plus' })).toBe('+0.0460')
    expect(formatSol(-0.4)).toBe('0.0000')
  })

  it('fractional lamports are rounded to integers first', () => {
    expect(formatSol(4_999.6)).toBe('0.000005')
  })
})

describe('other formatters', () => {
  it('shortAddress', () => {
    expect(shortAddress('GmaDr7kQ2vNw8XpLs4TfHc9ZyB3uMe6RjWnK5aYqAEGB')).toBe('GmaD...AEGB')
    expect(shortAddress('short')).toBe('short')
  })
  it('formatBps', () => {
    expect(formatBps(400)).toBe('4%')
    expect(formatBps(250)).toBe('2.5%')
    expect(formatBps(5)).toBe('0.05%')
    expect(formatBps(0)).toBe('0%')
  })
  it('ordinal2 / lamportsToSol / formatTokenAmount', () => {
    expect(ordinal2(1)).toBe('01')
    expect(ordinal2(24)).toBe('24')
    expect(lamportsToSol(1_000_000_000)).toBe(1)
    expect(formatTokenAmount('0')).toBe('0')
    expect(formatTokenAmount('88000')).toBe('88,000')
    expect(formatTokenAmount('abc')).toBe('abc')
  })
})

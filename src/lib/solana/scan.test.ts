import { PublicKey, type Connection } from '@solana/web3.js'
import { describe, expect, it, vi } from 'vitest'
import { scanWallet } from './scan'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from './programs'
import { RENT, SPL, T22, parsedData, randomAddress, randomKey } from '../../test/solanaFixtures'

type Entry = { pubkey: PublicKey; account: { lamports: number; owner: PublicKey; data: unknown; executable: boolean; rentEpoch: number } }

function entry(owner: string, over: Parameters<typeof parsedData>[1], lamports: number, program: 'spl-token' | 'spl-token-2022' = 'spl-token', pubkey = randomKey()): Entry {
  return {
    pubkey,
    account: {
      lamports,
      owner: program === 'spl-token' ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID,
      data: parsedData(owner, over, program),
      executable: false,
      rentEpoch: 0,
    },
  }
}

function mockConnection(spl: Entry[] | Error | Promise<never>, t22: Entry[] | Error | Promise<never>) {
  const fn = vi.fn(async (_owner: PublicKey, filter: { programId: PublicKey }, _commitment?: string) => {
    const r = filter.programId.equals(TOKEN_PROGRAM_ID) ? spl : t22
    if (r instanceof Error) throw r
    return { context: { slot: 1 }, value: await r }
  })
  return { connection: { getParsedTokenAccountsByOwner: fn } as unknown as Connection, fn }
}

describe('scanWallet', () => {
  const ownerKey = randomKey()
  const owner = ownerKey.toBase58()

  it('queries both token programs in parallel with commitment confirmed', async () => {
    const { connection, fn } = mockConnection([], [])
    await scanWallet(connection, ownerKey, { cluster: 'devnet' })
    expect(fn).toHaveBeenCalledTimes(2)
    const programs = fn.mock.calls.map((c) => c[1].programId.toBase58()).sort()
    expect(programs).toEqual([SPL, T22].sort())
    for (const call of fn.mock.calls) {
      expect(call[0].equals(ownerKey)).toBe(true)
      expect(call[2]).toBe('confirmed')
    }
  })

  it('groups, sorts and maps accounts', async () => {
    const small = entry(owner, {}, RENT, 'spl-token', new PublicKey('11111111111111111111111111111112'))
    const big = entry(owner, { extensions: [{ extension: 'immutableOwner' }] }, 2_157_600, 'spl-token-2022')
    // Same lamports as `small`: tie broken by address.
    const tieKey = new PublicKey('11111111111111111111111111111113')
    const tie = entry(owner, {}, RENT, 'spl-token', tieKey)
    const held = entry(owner, { amount: '5', uiAmountString: '0.000005' }, RENT)
    const frozen = entry(owner, { state: 'frozen' }, RENT)
    const withheld = entry(owner, { extensions: [{ extension: 'transferFeeAmount', state: { withheldAmount: 3 } }] }, 2_157_600, 'spl-token-2022')

    const { connection } = mockConnection([tie, held, small, frozen], [withheld, big])
    const before = Date.now()
    const res = await scanWallet(connection, ownerKey, { cluster: 'mainnet-beta' })

    expect(res.owner).toBe(owner)
    expect(res.cluster).toBe('mainnet-beta')
    expect(res.isDemo).toBe(false)
    expect(res.scannedAt).toBeGreaterThanOrEqual(before)

    expect(res.eligible.map((a) => a.address)).toEqual([
      big.pubkey.toBase58(),
      small.pubkey.toBase58(),
      tie.pubkey.toBase58(),
    ])
    expect(res.withTokens.map((a) => a.address)).toEqual([held.pubkey.toBase58()])
    expect(res.unsupported.map((a) => a.address).sort()).toEqual([frozen.pubkey.toBase58(), withheld.pubkey.toBase58()].sort())
    expect(res.accounts).toEqual([...res.eligible, ...res.withTokens, ...res.unsupported])

    const bigInfo = res.eligible[0]
    expect(bigInfo.programId).toBe(T22)
    expect(bigInfo.program).toBe('token-2022')
    expect(bigInfo.lamports).toBe(2_157_600)
    expect(bigInfo.owner).toBe(owner)
  })

  it('treats accounts with a foreign owner as unsupported', async () => {
    const { connection } = mockConnection([entry(randomAddress(), {}, RENT)], [])
    const res = await scanWallet(connection, ownerKey, { cluster: 'devnet' })
    expect(res.eligible).toHaveLength(0)
    expect(res.unsupported[0].reason).toBe('owner-mismatch')
  })

  it('de-duplicates an address returned twice', async () => {
    const e = entry(owner, {}, RENT)
    const { connection } = mockConnection([e, e], [])
    const res = await scanWallet(connection, ownerKey, { cluster: 'devnet' })
    expect(res.eligible).toHaveLength(1)
  })

  it('handles unparsed data without failing the scan', async () => {
    const e = entry(owner, {}, RENT)
    e.account.data = new Uint8Array(165)
    const { connection } = mockConnection([e], [])
    const res = await scanWallet(connection, ownerKey, { cluster: 'devnet' })
    expect(res.unsupported[0].reason).toBe('unparsed')
  })

  it('fails the whole scan if one program query fails (no partial data)', async () => {
    const { connection } = mockConnection([entry(owner, {}, RENT)], new Error('429 Too Many Requests'))
    await expect(scanWallet(connection, ownerKey, { cluster: 'devnet' })).rejects.toThrow(
      /Token-2022.*429 Too Many Requests/,
    )
  })

  it('fails when the SPL Token query fails', async () => {
    const { connection } = mockConnection(new Error('fetch failed'), [])
    await expect(scanWallet(connection, ownerKey, { cluster: 'devnet' })).rejects.toThrow(/SPL Token.*fetch failed/)
  })

  it('throws AbortError when already aborted, without RPC', async () => {
    const { connection, fn } = mockConnection([], [])
    const ac = new AbortController()
    ac.abort()
    await expect(scanWallet(connection, ownerKey, { cluster: 'devnet', signal: ac.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(fn).not.toHaveBeenCalled()
  })

  it('throws AbortError when aborted while the RPC is in flight', async () => {
    let release!: (v: Entry[]) => void
    const pending = new Promise<Entry[]>((r) => (release = r))
    const { connection } = mockConnection(pending as Promise<never>, [])
    const ac = new AbortController()
    const p = scanWallet(connection, ownerKey, { cluster: 'devnet', signal: ac.signal })
    ac.abort()
    release([entry(owner, {}, RENT)])
    const err = await p.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DOMException)
    expect((err as DOMException).name).toBe('AbortError')
  })

  it('throws AbortError when aborted right after the RPC resolves', async () => {
    const ac = new AbortController()
    const fn = vi.fn(async () => {
      queueMicrotask(() => ac.abort())
      return { context: { slot: 1 }, value: [] }
    })
    const connection = { getParsedTokenAccountsByOwner: fn } as unknown as Connection
    await expect(scanWallet(connection, ownerKey, { cluster: 'devnet', signal: ac.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
  })
})

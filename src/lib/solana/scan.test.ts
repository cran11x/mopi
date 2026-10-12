// @vitest-environment node
// (real web3.js Connection tests below need Node's fetch Response and Uint8Array realm.)
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { describe, expect, it, vi } from 'vitest'
import { scanWallet } from './scan'
import { checkHolderStatus } from './holder'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from './programs'
import { RENT, SPL, T22, parsedData, randomAddress, randomKey } from '../../test/solanaFixtures'

const addr = () => Keypair.generate().publicKey.toBase58()

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

  it('returns the SPL Token results with a warning when only the Token-2022 query is refused (403)', async () => {
    const forbidden = new Error('403 : {"jsonrpc":"2.0","error":{"code": 403, "message":"Access forbidden"}}')
    const { connection } = mockConnection([entry(owner, {}, RENT)], forbidden)
    const res = await scanWallet(connection, ownerKey, { cluster: 'devnet' })
    expect(res.eligible).toHaveLength(1)
    expect(res.warnings).toHaveLength(1)
    expect(res.warnings?.[0]).toMatch(/Token-2022 accounts couldn’t be read — the RPC endpoint refused the request \(403\)/)
  })

  it('returns the Token-2022 results with a warning when only the SPL Token query fails', async () => {
    const { connection } = mockConnection(new Error('fetch failed'), [])
    const res = await scanWallet(connection, ownerKey, { cluster: 'devnet' })
    expect(res.accounts).toHaveLength(0)
    expect(res.warnings?.[0]).toMatch(/SPL Token accounts couldn’t be read — the RPC endpoint did not answer/)
  })

  it('fails the scan when both program queries fail', async () => {
    const { connection } = mockConnection(new Error('fetch failed'), new Error('429 Too Many Requests'))
    await expect(scanWallet(connection, ownerKey, { cluster: 'devnet' })).rejects.toThrow(/SPL Token.*fetch failed/)
  })

  it('a complete scan carries no warnings', async () => {
    const { connection } = mockConnection([entry(owner, {}, RENT)], [])
    const res = await scanWallet(connection, ownerKey, { cluster: 'devnet' })
    expect(res.warnings).toBeUndefined()
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

// ── Real web3.js Connection (stubbed fetch) with byte-for-byte realistic jsonParsed responses ──
// Proves web3.js's superstruct validation accepts the shapes Agave's solana-account-decoder emits
// and that toRaw/classify map the real field names/types (owner as PublicKey, withheldAmount as a
// JSON number, rentEpoch u64::MAX, native rentExemptReserve…).

type RpcCall = { method: string; params: unknown[] }

function connectionWith(handler: (call: RpcCall) => unknown, calls: RpcCall[] = []): Connection {
  const fetchStub = async (_url: unknown, init?: { body?: unknown }) => {
    const req = JSON.parse(String(init?.body)) as { id: string; method: string; params: unknown[] }
    calls.push({ method: req.method, params: req.params })
    const result = handler({ method: req.method, params: req.params })
    // Write u64::MAX rentEpoch literally, as the real RPC does.
    const body = JSON.stringify({ jsonrpc: '2.0', id: req.id, result }).replace(/"__U64MAX__"/g, '18446744073709551615')
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  return new Connection('http://127.0.0.1:8899', { commitment: 'confirmed', fetch: fetchStub as unknown as typeof fetch })
}

function keyedAccount(pubkey: string, programOwner: string, lamports: number, data: unknown, space: number) {
  return {
    pubkey,
    account: { data, executable: false, lamports, owner: programOwner, rentEpoch: '__U64MAX__', space },
  }
}

function tokenInfo(owner: string, extra: Record<string, unknown> = {}) {
  return {
    isNative: false,
    mint: addr(),
    owner,
    state: 'initialized',
    tokenAmount: { amount: '0', decimals: 6, uiAmount: 0.0, uiAmountString: '0' },
    ...extra,
  }
}

describe('scanWallet against real web3.js response parsing', () => {
  const owner = Keypair.generate().publicKey
  const ownerB58 = owner.toBase58()

  const splEmpty = addr()
  const splNative = addr()
  const splFull = addr()
  const splDelegated = addr()
  const t22Safe = addr()
  const t22Withheld = addr()
  const t22Confidential = addr()

  const splAccounts = [
    keyedAccount(splEmpty, SPL, 2_039_280, { program: 'spl-token', parsed: { type: 'account', info: tokenInfo(ownerB58) }, space: 165 }, 165),
    keyedAccount(
      splNative,
      SPL,
      2_039_280,
      {
        program: 'spl-token',
        parsed: {
          type: 'account',
          info: {
            isNative: true,
            mint: 'So11111111111111111111111111111111111111112',
            owner: ownerB58,
            rentExemptReserve: { amount: '2039280', decimals: 9, uiAmount: 0.00203928, uiAmountString: '0.00203928' },
            state: 'initialized',
            tokenAmount: { amount: '0', decimals: 9, uiAmount: 0.0, uiAmountString: '0' },
          },
        },
        space: 165,
      },
      165,
    ),
    keyedAccount(
      splFull,
      SPL,
      2_039_280,
      {
        program: 'spl-token',
        parsed: {
          type: 'account',
          info: tokenInfo(ownerB58, { tokenAmount: { amount: '1500000', decimals: 6, uiAmount: 1.5, uiAmountString: '1.5' } }),
        },
        space: 165,
      },
      165,
    ),
    // A delegate does not block CloseAccount (only amount / close authority do).
    keyedAccount(
      splDelegated,
      SPL,
      2_039_280,
      {
        program: 'spl-token',
        parsed: {
          type: 'account',
          info: tokenInfo(ownerB58, {
            delegate: addr(),
            delegatedAmount: { amount: '5', decimals: 6, uiAmount: 0.000005, uiAmountString: '0.000005' },
          }),
        },
        space: 165,
      },
      165,
    ),
  ]

  const t22Accounts = [
    keyedAccount(
      t22Safe,
      T22,
      2_157_600,
      {
        program: 'spl-token-2022',
        parsed: {
          type: 'account',
          info: tokenInfo(ownerB58, {
            extensions: [
              { extension: 'immutableOwner' },
              { extension: 'transferFeeAmount', state: { withheldAmount: 0 } },
              { extension: 'memoTransfer', state: { requireIncomingTransferMemos: true } },
              { extension: 'cpiGuard', state: { lockCpi: true } },
              { extension: 'transferHookAccount', state: { transferring: false } },
            ],
          }),
        },
        space: 182,
      },
      182,
    ),
    keyedAccount(
      t22Withheld,
      T22,
      2_157_600,
      {
        program: 'spl-token-2022',
        parsed: {
          type: 'account',
          info: tokenInfo(ownerB58, {
            extensions: [{ extension: 'immutableOwner' }, { extension: 'transferFeeAmount', state: { withheldAmount: 42 } }],
          }),
        },
        space: 182,
      },
      182,
    ),
    keyedAccount(
      t22Confidential,
      T22,
      3_000_000,
      {
        program: 'spl-token-2022',
        parsed: {
          type: 'account',
          info: tokenInfo(ownerB58, {
            extensions: [{ extension: 'immutableOwner' }, { extension: 'confidentialTransferAccount', state: { approved: true } }],
          }),
        },
        space: 465,
      },
      465,
    ),
  ]

  it('sends the right requests and classifies realistic responses', async () => {
    const calls: RpcCall[] = []
    const conn = connectionWith(({ params }) => {
      const filter = params[1] as { programId: string }
      return { context: { slot: 1, apiVersion: '2.2.0' }, value: filter.programId === SPL ? splAccounts : t22Accounts }
    }, calls)

    const res = await scanWallet(conn, owner, { cluster: 'mainnet-beta' })

    expect(calls.map((c) => c.method)).toEqual(['getTokenAccountsByOwner', 'getTokenAccountsByOwner'])
    const programIds = calls.map((c) => (c.params[1] as { programId: string }).programId).sort()
    expect(programIds).toEqual([SPL, T22].sort())
    for (const c of calls) {
      expect(c.params[0]).toBe(ownerB58)
      expect(c.params[2]).toMatchObject({ encoding: 'jsonParsed', commitment: 'confirmed' })
    }

    const by = new Map(res.accounts.map((a) => [a.address, a]))
    expect(by.get(splEmpty)).toMatchObject({ status: 'eligible', program: 'spl-token', programId: SPL, lamports: 2_039_280 })
    expect(by.get(splNative)).toMatchObject({ status: 'eligible', isNative: true })
    expect(by.get(splFull)).toMatchObject({ status: 'has-tokens', uiAmount: '1.5' })
    expect(by.get(splDelegated)).toMatchObject({ status: 'eligible' })
    expect(by.get(t22Safe)).toMatchObject({ status: 'eligible', program: 'token-2022', programId: T22 })
    expect(by.get(t22Withheld)).toMatchObject({ status: 'unsupported', reason: 'withheld-fees' })
    expect(by.get(t22Confidential)).toMatchObject({ status: 'unsupported', reason: 'extension' })
    expect(res.eligible[0].address).toBe(t22Safe) // most account SOL first
  })

  it('known gap: a base64 fallback entry is rejected by web3.js itself, failing that program query (partial scan)', async () => {
    // Agave's get_parsed_token_accounts filters out entries that fail to parse (e.g. token
    // accounts whose mint was closed → no decimals → binary fallback), so a real Agave RPC never
    // sends this; classify's Buffer branch is therefore unreachable through scanWallet, and those
    // accounts are silently invisible. If a non-Agave provider did send it, the scan would fail.
    const conn = connectionWith(({ params }) => {
      const filter = params[1] as { programId: string }
      const value = filter.programId === SPL ? [] : [keyedAccount(addr(), T22, 2_074_080, ['AAAA', 'base64'], 3)]
      return { context: { slot: 1 }, value }
    })
    const res = await scanWallet(conn, owner, { cluster: 'mainnet-beta' })
    expect(res.accounts).toHaveLength(0)
    expect(res.warnings?.[0]).toMatch(/^Token-2022 accounts couldn’t be read/)
  })

  it('surfaces a real web3.js RPC error message (429) with the program label', async () => {
    const fetchStub = async () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: '1', error: { code: 429, message: 'Too many requests for a specific RPC call' } }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      })
    const conn = new Connection('http://127.0.0.1:8899', {
      commitment: 'confirmed',
      fetch: fetchStub as unknown as typeof fetch,
      disableRetryOnRateLimit: true,
    })
    await expect(scanWallet(conn, owner, { cluster: 'mainnet-beta' })).rejects.toThrow(/Could not read (SPL Token|Token-2022) accounts: .*429/)
  })
})

describe('holder balance against real web3.js parsing', () => {
  it('uses the mint filter (RPC resolves the mint’s program, so Token-2022 mints are covered) and sums raw amounts', async () => {
    const owner = Keypair.generate().publicKey
    const ownerB58 = owner.toBase58()
    const mint = addr()
    const calls: RpcCall[] = []
    const acct = (amount: string) =>
      keyedAccount(
        addr(),
        T22,
        2_157_600,
        {
          program: 'spl-token-2022',
          parsed: {
            type: 'account',
            info: {
              extensions: [{ extension: 'immutableOwner' }],
              isNative: false,
              mint,
              owner: ownerB58,
              state: 'initialized',
              tokenAmount: { amount, decimals: 6, uiAmount: Number(amount) / 1e6, uiAmountString: String(Number(amount) / 1e6) },
            },
          },
          space: 170,
        },
        170,
      )
    const conn = connectionWith(() => ({ context: { slot: 1 }, value: [acct('60000500000'), acct('39999600000')] }), calls)
    const status = await checkHolderStatus(conn, owner, { mint, minRequired: 100_000 })
    expect(calls[0].params[1]).toEqual({ mint })
    // 60,000.5 + 39,999.6 = 100,000.1 → floored 100,000 → holder.
    expect(status).toMatchObject({ checked: true, isHolder: true, balanceUi: 100_000 })
  })
})

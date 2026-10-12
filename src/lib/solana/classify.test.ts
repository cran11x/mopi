import { Buffer } from 'buffer'
import { describe, expect, it } from 'vitest'
import { classifyTokenAccount, rawToUiAmount, type RawParsedTokenAccount } from './classify'
import { RENT, SPL, T22, randomAddress, rawAccount } from '../../test/solanaFixtures'

const OWNER = randomAddress()

describe('classifyTokenAccount', () => {
  it('marks an empty, initialized SPL Token account eligible and fills every field', () => {
    const mint = randomAddress()
    const raw = rawAccount(OWNER, { mint, decimals: 9 }, { lamports: RENT })
    const info = classifyTokenAccount(raw, OWNER)
    expect(info).toEqual({
      address: raw.pubkey,
      mint,
      owner: OWNER,
      program: 'spl-token',
      programId: SPL,
      lamports: RENT,
      amountRaw: '0',
      decimals: 9,
      uiAmount: '0',
      isNative: false,
      state: 'initialized',
      closeAuthority: null,
      extensions: [],
      status: 'eligible',
    })
    expect(info.reason).toBeUndefined()
    expect(info.reasonText).toBeUndefined()
  })

  it('marks an empty Token-2022 account eligible with program kind token-2022', () => {
    const raw = rawAccount(OWNER, { extensions: [{ extension: 'immutableOwner' }] }, { program: 'spl-token-2022' })
    const info = classifyTokenAccount(raw, OWNER)
    expect(info.status).toBe('eligible')
    expect(info.program).toBe('token-2022')
    expect(info.programId).toBe(T22)
    expect(info.extensions).toEqual(['immutableOwner'])
  })

  describe('rule 1: malformed input → unsupported/unparsed (never throws)', () => {
    const cases: Array<[string, unknown]> = [
      ['null data', null],
      ['undefined data', undefined],
      ['Buffer data', Buffer.alloc(165)],
      ['Uint8Array data', new Uint8Array(165)],
      ['base64 tuple', ['AAAA', 'base64']],
      ['string data', 'garbage'],
      ['number data', 42],
      ['missing parsed', { program: 'spl-token' }],
      ['parsed type mint', { program: 'spl-token', parsed: { type: 'mint', info: {} } }],
      ['parsed info missing', { program: 'spl-token', parsed: { type: 'account' } }],
      ['unknown program', { program: 'spl-memo', parsed: { type: 'account', info: {} } }],
    ]
    for (const [name, data] of cases) {
      it(name, () => {
        const raw: RawParsedTokenAccount = { pubkey: randomAddress(), lamports: RENT, programId: SPL, data }
        const info = classifyTokenAccount(raw, OWNER)
        expect(info.status).toBe('unsupported')
        expect(info.reason).toBe('unparsed')
        expect(info.reasonText).toMatch(/\S/)
        expect(info.lamports).toBe(RENT)
      })
    }

    it('missing / wrong-typed info fields', () => {
      const bad: Array<Parameters<typeof rawAccount>[1]> = [
        { mint: 42 },
        { owner: null },
        { state: 'weird' },
        { amount: 12 },
        { amount: '-1' },
        { amount: '1.5' },
        { decimals: '6' },
        { decimals: -1 },
        { isNative: 'yes' },
        { closeAuthority: 7 },
        { extensions: 'immutableOwner' },
      ]
      for (const over of bad) {
        const info = classifyTokenAccount(rawAccount(OWNER, over), OWNER)
        expect(info.reason, JSON.stringify(over)).toBe('unparsed')
      }
    })

    it('tokenAmount missing entirely', () => {
      const raw = rawAccount(OWNER)
      delete ((raw.data as { parsed: { info: Record<string, unknown> } }).parsed.info).tokenAmount
      expect(classifyTokenAccount(raw, OWNER).reason).toBe('unparsed')
    })

    it('unknown owning program id', () => {
      const raw = rawAccount(OWNER, {}, { programId: randomAddress() })
      expect(classifyTokenAccount(raw, OWNER).reason).toBe('unparsed')
    })

    it('data.program disagrees with the owning program id', () => {
      const raw = rawAccount(OWNER, {}, { program: 'spl-token-2022', programId: SPL })
      expect(classifyTokenAccount(raw, OWNER).reason).toBe('unparsed')
    })

    it('invalid pubkey or lamports', () => {
      expect(classifyTokenAccount(rawAccount(OWNER, {}, { pubkey: 'not-a-key' }), OWNER).reason).toBe('unparsed')
      expect(classifyTokenAccount({ ...rawAccount(OWNER), lamports: NaN }, OWNER).reason).toBe('unparsed')
      expect(classifyTokenAccount({ ...rawAccount(OWNER), lamports: -1 }, OWNER).reason).toBe('unparsed')
    })

    it('completely bogus raw objects', () => {
      expect(() => classifyTokenAccount(null as unknown as RawParsedTokenAccount, OWNER)).not.toThrow()
      expect(classifyTokenAccount(null as unknown as RawParsedTokenAccount, OWNER).reason).toBe('unparsed')
      expect(classifyTokenAccount({} as RawParsedTokenAccount, OWNER).reason).toBe('unparsed')
    })

    it('a throwing getter in data does not escape', () => {
      const data = {
        program: 'spl-token',
        get parsed() {
          throw new Error('boom')
        },
      }
      const info = classifyTokenAccount({ pubkey: randomAddress(), lamports: RENT, programId: SPL, data }, OWNER)
      expect(info.reason).toBe('unparsed')
    })
  })

  it('rule 2: owner mismatch', () => {
    const info = classifyTokenAccount(rawAccount(OWNER, { owner: randomAddress() }), OWNER)
    expect(info.status).toBe('unsupported')
    expect(info.reason).toBe('owner-mismatch')
    expect(info.reasonText).toMatch(/\S/)
  })

  it('owner mismatch wins over a balance', () => {
    const info = classifyTokenAccount(rawAccount(OWNER, { owner: randomAddress(), amount: '5' }), OWNER)
    expect(info.reason).toBe('owner-mismatch')
  })

  describe('rule 3: has tokens', () => {
    it('non-zero balance', () => {
      const info = classifyTokenAccount(rawAccount(OWNER, { amount: '1250000', uiAmountString: '1.25' }), OWNER)
      expect(info.status).toBe('has-tokens')
      expect(info.reason).toBeUndefined()
      expect(info.amountRaw).toBe('1250000')
      expect(info.uiAmount).toBe('1.25')
      expect(info.reasonText).toBe('Holds tokens — mopi never touches accounts with a balance.')
    })

    it('wrapped SOL with a balance is never unwrapped', () => {
      const info = classifyTokenAccount(rawAccount(OWNER, { isNative: true, amount: '1000', decimals: 9 }), OWNER)
      expect(info.status).toBe('has-tokens')
      expect(info.isNative).toBe(true)
    })

    it('empty wrapped SOL is eligible', () => {
      const info = classifyTokenAccount(rawAccount(OWNER, { isNative: true, amount: '0', decimals: 9 }), OWNER)
      expect(info.status).toBe('eligible')
      expect(info.isNative).toBe(true)
    })

    it('a balance wins over frozen / foreign close authority', () => {
      expect(classifyTokenAccount(rawAccount(OWNER, { amount: '1', state: 'frozen' }), OWNER).status).toBe('has-tokens')
      expect(
        classifyTokenAccount(rawAccount(OWNER, { amount: '1', closeAuthority: randomAddress() }), OWNER).status,
      ).toBe('has-tokens')
    })

    it('derives uiAmount from raw amount when uiAmountString is missing', () => {
      const info = classifyTokenAccount(rawAccount(OWNER, { amount: '1500', decimals: 3, uiAmountString: undefined }), OWNER)
      expect(info.uiAmount).toBe('1.5')
    })
  })

  describe('rule 4: state', () => {
    it('frozen', () => {
      const info = classifyTokenAccount(rawAccount(OWNER, { state: 'frozen' }), OWNER)
      expect(info.reason).toBe('frozen')
      expect(info.state).toBe('frozen')
      expect(info.reasonText).toMatch(/freeze authority/)
    })
    it('uninitialized', () => {
      const info = classifyTokenAccount(rawAccount(OWNER, { state: 'uninitialized' }), OWNER)
      expect(info.reason).toBe('uninitialized')
      expect(info.reasonText).toMatch(/\S/)
    })
  })

  describe('rule 5: close authority', () => {
    it('foreign close authority → unsupported', () => {
      const ca = randomAddress()
      const info = classifyTokenAccount(rawAccount(OWNER, { closeAuthority: ca }), OWNER)
      expect(info.reason).toBe('close-authority')
      expect(info.closeAuthority).toBe(ca)
      expect(info.reasonText).toBe('Another address controls closing this account.')
    })
    it('close authority = owner is fine', () => {
      const info = classifyTokenAccount(rawAccount(OWNER, { closeAuthority: OWNER }), OWNER)
      expect(info.status).toBe('eligible')
      expect(info.closeAuthority).toBe(OWNER)
    })
    it('a delegate does not block closing', () => {
      const info = classifyTokenAccount(rawAccount(OWNER, { delegate: randomAddress() }), OWNER)
      expect(info.status).toBe('eligible')
    })
    it('frozen is reported before a foreign close authority', () => {
      const info = classifyTokenAccount(rawAccount(OWNER, { state: 'frozen', closeAuthority: randomAddress() }), OWNER)
      expect(info.reason).toBe('frozen')
    })
  })

  describe('rule 6: Token-2022 extensions', () => {
    const t22 = (extensions: unknown) =>
      classifyTokenAccount(rawAccount(OWNER, { extensions }, { program: 'spl-token-2022' }), OWNER)

    for (const name of [
      'immutableOwner',
      'memoTransfer',
      'cpiGuard',
      'nonTransferableAccount',
      'transferHookAccount',
      'pausableAccount',
    ]) {
      it(`allowlisted: ${name}`, () => {
        const info = t22([{ extension: name, state: {} }])
        expect(info.status).toBe('eligible')
        expect(info.extensions).toEqual([name])
      })
    }

    it('transferFeeAmount with withheldAmount 0 (number) is eligible', () => {
      const info = t22([{ extension: 'immutableOwner' }, { extension: 'transferFeeAmount', state: { withheldAmount: 0 } }])
      expect(info.status).toBe('eligible')
      expect(info.extensions).toEqual(['immutableOwner', 'transferFeeAmount'])
    })

    it('transferFeeAmount with withheldAmount "0" (string) is eligible', () => {
      expect(t22([{ extension: 'transferFeeAmount', state: { withheldAmount: '0' } }]).status).toBe('eligible')
    })

    it('withheld fees > 0 (number) → withheld-fees', () => {
      const info = t22([{ extension: 'transferFeeAmount', state: { withheldAmount: 15 } }])
      expect(info.reason).toBe('withheld-fees')
      expect(info.reasonText).toBe(
        'Token-2022 account with withheld transfer fees. They must be harvested before it can close.',
      )
    })

    it('withheld fees > 0 (big string) → withheld-fees', () => {
      expect(t22([{ extension: 'transferFeeAmount', state: { withheldAmount: '18446744073709551615' } }]).reason).toBe(
        'withheld-fees',
      )
    })

    it('transferFeeAmount without a readable withheldAmount is not trusted', () => {
      for (const state of [undefined, {}, { withheldAmount: 'abc' }, { withheldAmount: -1 }, { withheldAmount: 1.5 }]) {
        const info = t22([{ extension: 'transferFeeAmount', state }])
        expect(info.status, JSON.stringify(state)).toBe('unsupported')
        expect(info.reason).toBe('extension')
      }
    })

    it('confidentialTransferAccount → extension', () => {
      const info = t22([{ extension: 'immutableOwner' }, { extension: 'confidentialTransferAccount', state: {} }])
      expect(info.reason).toBe('extension')
      expect(info.reasonText).toBe("Uses a Token-2022 extension mopi doesn't support yet (confidentialTransferAccount).")
      expect(info.reasonText).toContain('confidentialTransferAccount')
    })

    it('confidentialTransferFeeAmount → extension', () => {
      const info = t22([{ extension: 'confidentialTransferFeeAmount', state: {} }])
      expect(info.reason).toBe('extension')
      expect(info.reasonText).toContain('confidentialTransferFeeAmount')
    })

    it('unknown extension → extension', () => {
      const info = t22([{ extension: 'someFutureThing' }])
      expect(info.reason).toBe('extension')
      expect(info.reasonText).toContain('someFutureThing')
    })

    it('malformed extension entry → extension (unknown)', () => {
      for (const ext of [null, 5, { state: {} }, { extension: '' }]) {
        const info = t22([ext])
        expect(info.reason).toBe('extension')
        expect(info.extensions).toEqual(['unknown'])
      }
    })

    it('extensions on an SPL Token account are held to the same allowlist', () => {
      const info = classifyTokenAccount(rawAccount(OWNER, { extensions: [{ extension: 'confidentialTransferAccount' }] }), OWNER)
      expect(info.reason).toBe('extension')
    })

    it('close authority is reported before extension problems', () => {
      const info = classifyTokenAccount(
        rawAccount(
          OWNER,
          { closeAuthority: randomAddress(), extensions: [{ extension: 'confidentialTransferAccount' }] },
          { program: 'spl-token-2022' },
        ),
        OWNER,
      )
      expect(info.reason).toBe('close-authority')
    })
  })

  it('every non-eligible account gets a reasonText', () => {
    const variants = [
      rawAccount(OWNER, { amount: '1' }),
      rawAccount(OWNER, { state: 'frozen' }),
      rawAccount(OWNER, { state: 'uninitialized' }),
      rawAccount(OWNER, { closeAuthority: randomAddress() }),
      rawAccount(OWNER, { owner: randomAddress() }),
      { pubkey: randomAddress(), lamports: 1, programId: SPL, data: null },
    ]
    for (const raw of variants) {
      const info = classifyTokenAccount(raw, OWNER)
      expect(info.status).not.toBe('eligible')
      expect(info.reasonText && info.reasonText.length).toBeGreaterThan(10)
    }
  })
})

describe('rawToUiAmount', () => {
  it('formats raw amounts', () => {
    expect(rawToUiAmount('0', 6)).toBe('0')
    expect(rawToUiAmount('1500', 3)).toBe('1.5')
    expect(rawToUiAmount('1', 9)).toBe('0.000000001')
    expect(rawToUiAmount('42', 0)).toBe('42')
    expect(rawToUiAmount('1000000', 6)).toBe('1')
  })
})

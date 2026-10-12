import { buildSocialLinks, readHttpsUrl, tokenExplorerUrl } from './socials'

describe('readHttpsUrl', () => {
  it('accepts https URLs and normalizes them', () => {
    expect(readHttpsUrl('https://x.com/mopi')).toBe('https://x.com/mopi')
    expect(readHttpsUrl('  https://t.me/mopi  ')).toBe('https://t.me/mopi')
    expect(readHttpsUrl('HTTPS://X.COM/mopi')).toBe('https://x.com/mopi')
  })

  it('treats empty or missing values as unset', () => {
    expect(readHttpsUrl(undefined)).toBeNull()
    expect(readHttpsUrl(null)).toBeNull()
    expect(readHttpsUrl('')).toBeNull()
    expect(readHttpsUrl('   ')).toBeNull()
  })

  it('rejects non-https schemes', () => {
    expect(readHttpsUrl('http://x.com/mopi')).toBeNull()
    expect(readHttpsUrl('javascript:alert(1)')).toBeNull()
    expect(readHttpsUrl('data:text/html,hi')).toBeNull()
    expect(readHttpsUrl('ftp://x.com')).toBeNull()
    expect(readHttpsUrl('//x.com/mopi')).toBeNull()
  })

  it('rejects relative, malformed, credentialed or whitespace-laden URLs', () => {
    expect(readHttpsUrl('x.com/mopi')).toBeNull()
    expect(readHttpsUrl('/mopi')).toBeNull()
    expect(readHttpsUrl('https://')).toBeNull()
    expect(readHttpsUrl('https://user:pw@x.com/mopi')).toBeNull()
    expect(readHttpsUrl('https://x.com/mo pi')).toBeNull()
    expect(readHttpsUrl('https://x.com/\nmopi')).toBeNull()
  })
})

describe('buildSocialLinks', () => {
  it('includes only valid links, X first', () => {
    expect(buildSocialLinks({}).length).toBe(0)
    expect(buildSocialLinks({ x: 'http://x.com/mopi', telegram: '' })).toEqual([])
    const links = buildSocialLinks({ x: 'https://x.com/mopi', telegram: 'https://t.me/mopi' })
    expect(links.map((l) => [l.key, l.href, l.label])).toEqual([
      ['x', 'https://x.com/mopi', 'mopi on X'],
      ['telegram', 'https://t.me/mopi', 'mopi on Telegram'],
    ])
  })
})

describe('tokenExplorerUrl', () => {
  it('points at the Solscan token page', () => {
    expect(tokenExplorerUrl('So11111111111111111111111111111111111111112')).toBe(
      'https://solscan.io/token/So11111111111111111111111111111111111111112',
    )
  })
})

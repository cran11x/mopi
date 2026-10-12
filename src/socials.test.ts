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

describe('CA / social links (hostile values)', () => {
  it('only absolute https URLs survive', () => {
    const bad = [
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      ' javascript:alert(1)',
      'java\tscript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'http://x.com/mopi',
      '//x.com/mopi',
      '/x',
      'https:javascript:alert(1)',
      'https://user:pw@x.com/',
      'vbscript:msgbox(1)',
      'https://x.com/a b',
    ]
    for (const v of bad) expect(readHttpsUrl(v), v).toBeNull()
    expect(readHttpsUrl('https://x.com/mopi')).toBe('https://x.com/mopi')
    expect(readHttpsUrl('HTTPS://t.me/mopi')).toBe('https://t.me/mopi')
  })

  it('the Solscan link is URL-encoded, so a junk mint cannot escape the path', () => {
    expect(tokenExplorerUrl('../../evil?x=1')).toBe('https://solscan.io/token/..%2F..%2Fevil%3Fx%3D1')
  })
})


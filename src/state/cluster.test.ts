import { describe, expect, it } from 'vitest'
import { normaliseRpcUrl } from './cluster'

describe('normaliseRpcUrl', () => {
  it('accepts https endpoints (keeps query strings such as API keys)', () => {
    expect(normaliseRpcUrl(' https://mainnet.helius-rpc.com/?api-key=abc ')).toBe('https://mainnet.helius-rpc.com/?api-key=abc')
    expect(normaliseRpcUrl('https://rpc.example.com/')).toBe('https://rpc.example.com')
  })
  it('allows http only on localhost', () => {
    expect(normaliseRpcUrl('http://127.0.0.1:8899')).toBe('http://127.0.0.1:8899')
    expect(normaliseRpcUrl('http://rpc.example.com')).toBeNull()
  })
  it('rejects junk and other schemes', () => {
    expect(normaliseRpcUrl('')).toBeNull()
    expect(normaliseRpcUrl('not a url')).toBeNull()
    expect(normaliseRpcUrl('javascript:alert(1)')).toBeNull()
    expect(normaliseRpcUrl('wss://rpc.example.com')).toBeNull()
  })
})

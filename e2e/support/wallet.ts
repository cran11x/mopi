/// <reference lib="dom" />
import type { Page } from '@playwright/test'
import type { PublicKey } from '@solana/web3.js'

// A fake Wallet Standard wallet, injected before the app loads. It follows the
// registration protocol from @wallet-standard/app (both directions: it
// dispatches `wallet-standard:register-wallet` and answers
// `wallet-standard:app-ready`), so wallet-adapter-react auto-detects it exactly
// like Phantom or Solflare.
//
// Signing writes a deterministic, non-zero 64-byte dummy signature into the
// first signature slot (byte offset 1, right after the compact-u16 count of 1)
// and returns the bytes. The app never verifies signatures client-side and the
// RPC is mocked, so nothing real is ever signed.

export const FAKE_WALLET_NAME = 'Mopi Test Wallet'

const ICON =
  'data:image/svg+xml;base64,' +
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#2f6b4f"/><circle cx="16" cy="16" r="7" fill="#e9f7ef"/></svg>',
  ).toString('base64')

export interface FakeWalletInit {
  name: string
  icon: string
  address: string
  publicKey: number[]
  /** Reject every signing request like a user pressing "Cancel" in the wallet. */
  rejectSigning: boolean
}

export async function installFakeWallet(
  page: Page,
  publicKey: PublicKey,
  opts: { name?: string; rejectSigning?: boolean } = {},
): Promise<void> {
  const init: FakeWalletInit = {
    name: opts.name ?? FAKE_WALLET_NAME,
    icon: ICON,
    address: publicKey.toBase58(),
    publicKey: Array.from(publicKey.toBytes()),
    rejectSigning: opts.rejectSigning ?? false,
  }

  await page.addInitScript((o: FakeWalletInit) => {
    type Listener = (properties: Record<string, unknown>) => void
    const listeners: Record<string, Listener[]> = {}
    const accounts: unknown[] = []
    const chains = ['solana:mainnet', 'solana:devnet'] as const
    const account = Object.freeze({
      address: o.address,
      publicKey: new Uint8Array(o.publicKey),
      chains,
      features: ['solana:signTransaction'],
      label: 'Test account',
    })
    const emit = (event: string, properties: Record<string, unknown>) => {
      for (const l of listeners[event] ?? []) l(properties)
    }
    const state = { connectCalls: 0, signCalls: 0, signedCount: 0 }
    ;(window as unknown as { __fakeWallet: typeof state }).__fakeWallet = state

    /** Deterministic dummy signature derived from the message bytes (distinct per transaction). */
    const dummySignature = (message: Uint8Array): Uint8Array => {
      let h = 0x811c9dc5
      for (const b of message) h = Math.imul(h ^ b, 0x01000193) >>> 0
      const sig = new Uint8Array(64)
      for (let i = 0; i < 64; i++) {
        h = Math.imul(h ^ (i + 1), 0x01000193) >>> 0
        sig[i] = (h & 0xff) | 1 // never zero
      }
      return sig
    }

    const wallet = {
      version: '1.0.0' as const,
      name: o.name,
      icon: o.icon,
      chains,
      get accounts() {
        return accounts.slice()
      },
      features: {
        'standard:connect': {
          version: '1.0.0',
          connect: async () => {
            state.connectCalls++
            if (accounts.length === 0) {
              accounts.push(account)
              emit('change', { accounts: wallet.accounts })
            }
            return { accounts: wallet.accounts }
          },
        },
        'standard:disconnect': {
          version: '1.0.0',
          disconnect: async () => {
            accounts.length = 0
            emit('change', { accounts: wallet.accounts })
          },
        },
        'standard:events': {
          version: '1.0.0',
          on: (event: string, listener: Listener) => {
            ;(listeners[event] ??= []).push(listener)
            return () => {
              listeners[event] = (listeners[event] ?? []).filter((l) => l !== listener)
            }
          },
        },
        'solana:signTransaction': {
          version: '1.0.0',
          supportedTransactionVersions: ['legacy', 0],
          signTransaction: async (...inputs: Array<{ transaction: Uint8Array }>) => {
            state.signCalls++
            if (o.rejectSigning) throw new Error('User rejected the request.')
            return inputs.map(({ transaction }) => {
              const bytes = new Uint8Array(transaction)
              if (bytes[0] !== 1) throw new Error(`fake wallet expects exactly 1 signature slot, got ${bytes[0]}`)
              bytes.set(dummySignature(bytes.subarray(65)), 1)
              state.signedCount++
              return { signedTransaction: bytes }
            })
          },
        },
      },
    }

    const register = (api: { register: (w: unknown) => unknown }) => api.register(wallet)
    try {
      window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register }))
    } catch (err) {
      console.warn('fake wallet: register-wallet dispatch failed', err)
    }
    try {
      window.addEventListener('wallet-standard:app-ready', (event: Event) => {
        register((event as CustomEvent<{ register: (w: unknown) => unknown }>).detail)
      })
    } catch (err) {
      console.warn('fake wallet: app-ready listener failed', err)
    }
  }, init)
}

export async function walletState(page: Page): Promise<{ connectCalls: number; signCalls: number; signedCount: number }> {
  return page.evaluate(() => (window as unknown as { __fakeWallet: { connectCalls: number; signCalls: number; signedCount: number } }).__fakeWallet)
}

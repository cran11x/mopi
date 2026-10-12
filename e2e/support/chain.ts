import type { Page, Route } from '@playwright/test'
import type { Keypair } from '@solana/web3.js'
import { signWithKeypair, type LiteSvmChain } from '../../src/test/litesvm'
import { FALLBACK_RPC_ROUTE, RPC_ROUTE } from './solana'

// Bridges the browser to an in-process LiteSVM chain (src/test/litesvm): every
// JSON-RPC POST the built app sends to its RPC endpoints is answered in node by
// the chain, and the fake Wallet Standard wallet signs through a node function
// holding a real Keypair. The app under test is the unmodified production
// build; only the network and the wallet's key live in node.

/** The app's primary mainnet RPC plus the default fallback, so a failover lands on the same chain. */
export const CHAIN_RPC_ROUTES: readonly RegExp[] = [RPC_ROUTE, FALLBACK_RPC_ROUTE]

/** Name of the page function the fake wallet calls to sign (see installFakeWallet's `signer`). */
export const NODE_SIGNER = '__mopiNodeSign'

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
  'access-control-allow-headers': '*',
  'access-control-max-age': '600',
}

/** Routes the app's RPC endpoints to `chain`. */
export async function routeRpcToChain(page: Page, chain: LiteSvmChain): Promise<void> {
  const handle = async (route: Route) => {
    const request = route.request()
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS })
      return
    }
    let body: unknown
    try {
      body = request.postDataJSON()
    } catch {
      await route.fulfill({ status: 400, headers: CORS, body: 'bad json' })
      return
    }
    await route.fulfill({
      status: 200,
      headers: { ...CORS, 'content-type': 'application/json' },
      body: JSON.stringify(chain.handleJsonRpc(body)),
    })
  }
  for (const pattern of CHAIN_RPC_ROUTES) await page.route(pattern, handle)
}

/** Exposes NODE_SIGNER: wire bytes in, the same transaction signed by `keypair` out (ed25519, in node). */
export async function exposeKeypairSigner(page: Page, keypair: Keypair): Promise<{ signed: Uint8Array[] }> {
  const log = { signed: [] as Uint8Array[] }
  await page.exposeFunction(NODE_SIGNER, (bytes: number[]) => {
    const signed = signWithKeypair(keypair, Uint8Array.from(bytes))
    log.signed.push(signed)
    return Array.from(signed)
  })
  return log
}

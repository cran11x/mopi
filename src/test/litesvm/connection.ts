import { Connection } from '@solana/web3.js'
import type { LiteSvmChain } from './chain'

// A real web3.js Connection whose HTTP transport is the in-process chain.
// Using the genuine Connection (rather than a hand-written stand-in) means
// web3.js' own request encoding and response validation (superstruct schemas
// for jsonParsed accounts, simulation results, statuses, SendTransactionError
// on preflight failures…) run exactly as they do against mainnet.

/** Endpoint URL the harness Connection pretends to talk to. Never resolved. */
export const LITESVM_RPC_URL = 'http://litesvm.invalid'

type FetchFn = (input: unknown, init?: { body?: unknown }) => Promise<Response>

/** A fetch() that answers JSON-RPC POST bodies from `chain`. */
export function createLiteSvmFetch(chain: LiteSvmChain): FetchFn {
  return async (_input, init) => {
    let body: unknown
    try {
      body = JSON.parse(String(init?.body ?? ''))
    } catch {
      return new Response('bad json', { status: 400 })
    }
    const payload = chain.handleJsonRpc(body)
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
  }
}

/** A Connection (commitment 'confirmed', like the app's) backed by `chain`. */
export function createLiteSvmConnection(chain: LiteSvmChain): Connection {
  return new Connection(LITESVM_RPC_URL, {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
    fetch: createLiteSvmFetch(chain) as unknown as typeof fetch,
  })
}

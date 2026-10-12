import type { Page, Route, WebSocketRoute } from '@playwright/test'
import { RPC_ROUTE, WS_ROUTE } from './solana'

// JSON-RPC mock for the Solana endpoint. The container (and CI) never talks to
// a real RPC: every test that triggers RPC traffic installs this first.

export interface RpcCall {
  method: string
  params: unknown[]
}

export class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message)
  }
}

/** Returns the JSON-RPC `result` for a call, or throws RpcError for a JSON-RPC error. */
export type RpcHandler = (params: unknown[], call: RpcCall) => unknown | Promise<unknown>

export interface RpcMockOptions {
  /** Handlers by method name. Unknown methods answer with JSON-RPC -32601. */
  handlers: Record<string, RpcHandler>
  /** Answer every POST with this HTTP status instead (e.g. 429). */
  httpStatus?: number
}

export interface RpcMock {
  /** Every JSON-RPC call received, in order (batched calls are flattened). */
  calls: RpcCall[]
  callsTo(method: string): RpcCall[]
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
  'access-control-allow-headers': '*',
  'access-control-max-age': '600',
}

export const context = (slot = 300_000_000) => ({ apiVersion: '2.2.0', slot })

/** Installs the HTTP JSON-RPC mock on `page`. Handles single and batched (array) requests. */
export async function mockRpc(page: Page, options: RpcMockOptions): Promise<RpcMock> {
  const calls: RpcCall[] = []

  const answer = async (req: { id?: unknown; method?: unknown; params?: unknown }) => {
    const method = typeof req.method === 'string' ? req.method : ''
    const params = Array.isArray(req.params) ? req.params : []
    const call = { method, params }
    calls.push(call)
    const handler = options.handlers[method]
    if (!handler) {
      return { jsonrpc: '2.0', id: req.id ?? null, error: { code: -32601, message: `Method not found: ${method}` } }
    }
    try {
      const result = await handler(params, call)
      return { jsonrpc: '2.0', id: req.id ?? null, result }
    } catch (err) {
      if (err instanceof RpcError) {
        return { jsonrpc: '2.0', id: req.id ?? null, error: { code: err.code, message: err.message } }
      }
      throw err
    }
  }

  await page.route(RPC_ROUTE, async (route: Route) => {
    const request = route.request()
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS })
      return
    }
    if (options.httpStatus) {
      await route.fulfill({
        status: options.httpStatus,
        headers: { ...CORS, 'content-type': 'text/plain' },
        body: options.httpStatus === 429 ? 'Too many requests for a specific RPC call' : 'error',
      })
      return
    }
    let body: unknown
    try {
      body = request.postDataJSON()
    } catch {
      await route.fulfill({ status: 400, headers: CORS, body: 'bad json' })
      return
    }
    const payload = Array.isArray(body)
      ? await Promise.all(body.map((b) => answer(b as Record<string, unknown>)))
      : await answer((body ?? {}) as Record<string, unknown>)
    await route.fulfill({
      status: 200,
      headers: { ...CORS, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  })

  return {
    calls,
    callsTo: (method) => calls.filter((c) => c.method === method),
  }
}

export interface WsMock {
  /** Signatures the app subscribed to (signatureSubscribe), in order. */
  signatureSubscriptions: string[]
}

/**
 * Mocks the RPC websocket used by Connection.confirmTransaction: answers
 * signatureSubscribe with an id, then pushes a successful signatureNotification.
 */
export async function mockRpcWebSocket(page: Page): Promise<WsMock> {
  const mock: WsMock = { signatureSubscriptions: [] }
  let nextId = 1
  await page.routeWebSocket(WS_ROUTE, (ws: WebSocketRoute) => {
    ws.onMessage((message) => {
      let req: { id?: unknown; method?: unknown; params?: unknown[] }
      try {
        req = JSON.parse(typeof message === 'string' ? message : message.toString('utf8'))
      } catch {
        return
      }
      // Notifications (e.g. web3.js' keep-alive "ping") carry no id and get no answer.
      if (req.id === undefined || req.id === null) return
      const method = String(req.method ?? '')
      if (method === 'signatureSubscribe') {
        const subscription = nextId++
        mock.signatureSubscriptions.push(String(req.params?.[0] ?? ''))
        ws.send(JSON.stringify({ jsonrpc: '2.0', result: subscription, id: req.id }))
        setTimeout(() => {
          ws.send(
            JSON.stringify({
              jsonrpc: '2.0',
              method: 'signatureNotification',
              params: { result: { context: { slot: 300_000_010 }, value: { err: null } }, subscription },
            }),
          )
        }, 50)
      } else if (method.endsWith('Unsubscribe')) {
        ws.send(JSON.stringify({ jsonrpc: '2.0', result: true, id: req.id }))
      } else if (method.endsWith('Subscribe')) {
        ws.send(JSON.stringify({ jsonrpc: '2.0', result: nextId++, id: req.id }))
      } else {
        ws.send(JSON.stringify({ jsonrpc: '2.0', error: { code: -32601, message: 'Method not found' }, id: req.id }))
      }
    })
  })
  return mock
}

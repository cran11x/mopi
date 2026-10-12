import type { Connection, PublicKey } from '@solana/web3.js'
import type { Cluster, ScanResult, TokenAccountInfo } from '../types'
import { classifyTokenAccount, type RawParsedTokenAccount } from './classify'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from './programs'
import { isRpcForbidden } from './rpcErrors'

export { isRpcForbidden }

export function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError')
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

/** Resolves/rejects with `promise`, or rejects with AbortError as soon as `signal` aborts. */
export function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) {
    promise.catch(() => {})
    return Promise.reject(abortError())
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e) => {
        signal.removeEventListener('abort', onAbort)
        reject(e)
      },
    )
  })
}

function toBase58(key: unknown): string {
  if (typeof key === 'string') return key
  if (key && typeof (key as PublicKey).toBase58 === 'function') return (key as PublicKey).toBase58()
  return ''
}

type ParsedEntry = Awaited<ReturnType<Connection['getParsedTokenAccountsByOwner']>>['value'][number]

function toRaw(entry: ParsedEntry): RawParsedTokenAccount {
  const account = (entry?.account ?? {}) as Partial<ParsedEntry['account']>
  return {
    pubkey: toBase58(entry?.pubkey),
    lamports: typeof account.lamports === 'number' ? account.lamports : NaN,
    programId: toBase58(account.owner),
    data: account.data,
  }
}

async function fetchProgram(
  connection: Connection,
  owner: PublicKey,
  programId: PublicKey,
  label: string,
): Promise<RawParsedTokenAccount[]> {
  try {
    const res = await connection.getParsedTokenAccountsByOwner(owner, { programId }, 'confirmed')
    if (!res || !Array.isArray(res.value)) throw new Error('unexpected RPC response')
    return res.value.map(toRaw)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`Could not read ${label} accounts: ${detail}`, { cause: err })
  }
}

/** Eligible ordering: most account SOL first, then address for a stable order. */
export function compareEligible(a: TokenAccountInfo, b: TokenAccountInfo): number {
  if (b.lamports !== a.lamports) return b.lamports - a.lamports
  return a.address < b.address ? -1 : a.address > b.address ? 1 : 0
}

/** Groups classified accounts into a ScanResult (pure). */
export function buildScanResult(
  classified: TokenAccountInfo[],
  meta: { owner: string; cluster: Cluster; scannedAt?: number; isDemo?: boolean },
): ScanResult {
  const eligible = classified.filter((a) => a.status === 'eligible').sort(compareEligible)
  const withTokens = classified.filter((a) => a.status === 'has-tokens')
  const unsupported = classified.filter((a) => a.status === 'unsupported')
  return {
    owner: meta.owner,
    cluster: meta.cluster,
    scannedAt: meta.scannedAt ?? Date.now(),
    isDemo: meta.isDemo ?? false,
    accounts: [...eligible, ...withTokens, ...unsupported],
    eligible,
    withTokens,
    unsupported,
  }
}

/**
 * Reads every token account owned by `owner` under both the SPL Token and
 * Token-2022 programs (jsonParsed), classifies them, and returns them sorted
 * eligible → has-tokens → unsupported. Read-only; never signs anything.
 *
 * Known gap: Agave's jsonParsed getTokenAccountsByOwner silently drops token
 * accounts it cannot parse — notably Token-2022 accounts whose mint was closed
 * (MintCloseAuthority, only possible at supply 0, so they are all empty and
 * closable). Those accounts never appear here and their rent stays where it
 * is. Finding them needs a second base64 query and a raw-layout decoder.
 */
export async function scanWallet(
  connection: Connection,
  owner: PublicKey,
  opts: { cluster: Cluster; signal?: AbortSignal },
): Promise<ScanResult> {
  const { cluster, signal } = opts
  throwIfAborted(signal)
  const ownerB58 = owner.toBase58()

  // Settled, not all-or-nothing: some RPCs (notably the free public endpoint)
  // refuse the Token-2022 index query while answering the SPL Token one. A
  // partial scan is still correct for what it shows — mopi only ever closes
  // accounts it has read — so it is returned with a warning instead of failing.
  const [splRes, t22Res] = await withAbort(
    Promise.allSettled([
      fetchProgram(connection, owner, TOKEN_PROGRAM_ID, 'SPL Token'),
      fetchProgram(connection, owner, TOKEN_2022_PROGRAM_ID, 'Token-2022'),
    ]),
    signal,
  )
  throwIfAborted(signal)
  if (splRes.status === 'rejected' && t22Res.status === 'rejected') throw splRes.reason
  const warnings: string[] = []
  if (splRes.status === 'rejected') warnings.push(partialWarning('SPL Token', splRes.reason))
  if (t22Res.status === 'rejected') warnings.push(partialWarning('Token-2022', t22Res.reason))
  const spl = splRes.status === 'fulfilled' ? splRes.value : []
  const t22 = t22Res.status === 'fulfilled' ? t22Res.value : []

  // Defensive de-dupe: a duplicated address would otherwise produce a duplicate close.
  const seen = new Set<string>()
  const classified: TokenAccountInfo[] = []
  for (const raw of [...spl, ...t22]) {
    if (raw.pubkey && seen.has(raw.pubkey)) continue
    if (raw.pubkey) seen.add(raw.pubkey)
    classified.push(classifyTokenAccount(raw, ownerB58))
  }

  const result = buildScanResult(classified, { owner: ownerB58, cluster })
  return warnings.length > 0 ? { ...result, warnings } : result
}

function partialWarning(label: string, err: unknown): string {
  const why = isRpcForbidden(err)
    ? 'the RPC endpoint refused the request (403)'
    : 'the RPC endpoint did not answer'
  return `${label} accounts couldn’t be read — ${why}. Results show the other program only. Set your own RPC in the network menu for a full scan.`
}

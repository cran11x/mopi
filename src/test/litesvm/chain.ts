import './v8-workaround'
import { Buffer } from 'buffer'
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
  type AccountInfo,
  type TransactionInstruction,
} from '@solana/web3.js'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { FailedTransactionMetadata, LiteSVM } from 'litesvm'
import { isLoadError, transactionErrorJson, transactionErrorText, type TransactionErrorJson } from './errors'
import { parseTokenAccount } from './parsed'

// An in-process Solana "cluster": LiteSVM (the real SVM with the real SPL
// Token, Token-2022, ATA and System programs) plus the few things a validator
// node adds on top that mopi relies on — block height and blockhash lifetimes,
// a transaction history with fees and balances, an index of accounts for
// getTokenAccountsByOwner, and the JSON-RPC methods the app calls, answered in
// the exact wire shapes Agave uses. `rpc()` is the single entry point used by
// both the vitest Connection (connection.ts) and the Playwright route bridge.
//
// Deliberate simplifications:
//  - One transaction = one slot = one block (slot and block height advance
//    together, by one per landed transaction).
//  - Only the latest blockhash is valid (LiteSVM's rule). `expireBlockhash()`
//    therefore also advances block height past every issued blockhash's
//    lastValidBlockHeight, so the two notions of "expired" never disagree.
//  - Every landed transaction is immediately 'confirmed' (or 'processed' for
//    the first `processedPolls` status lookups, to exercise polling).

/** A blockhash is valid for this many blocks after the block it was issued at. */
export const BLOCKHASH_LIFETIME = 150
export const RPC_API_VERSION = '2.2.0'
/** Agave reports rentEpoch u64::MAX for rent-exempt accounts. */
const RENT_EPOCH_MAX = 18446744073709551615

/** A JSON-RPC level error (`{ error: { code, message, data } }`). */
export class RpcFailure extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown,
  ) {
    super(message)
    this.name = 'RpcFailure'
  }
}

export interface RpcCall {
  method: string
  params: unknown[]
}

/** One transaction that was executed (landed), successful or not. */
export interface TxRecord {
  signature: string
  slot: number
  err: TransactionErrorJson | null
  logs: string[]
  unitsConsumed: number
  /** Lamports the transaction actually cost (Σ pre − Σ post over its accounts). */
  fee: number
  /** Static account keys (base58) → lamports before / after. */
  preBalances: Record<string, number>
  postBalances: Record<string, number>
}

/** One sendTransaction the RPC accepted, in arrival order (rebroadcasts included). */
export interface SendRecord {
  signature: string
  bytes: Uint8Array
  skipPreflight: boolean
  /** True if this call executed the transaction (first successful delivery). */
  executed: boolean
}

export interface SimulationResult {
  err: TransactionErrorJson | null
  logs: string[]
  unitsConsumed: number
}

export type AnyTransaction = Transaction | VersionedTransaction

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

export function base58Encode(bytes: Uint8Array): string {
  const digits: number[] = []
  for (const byte of bytes) {
    let carry = byte
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8
      digits[j] = carry % 58
      carry = (carry / 58) | 0
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = (carry / 58) | 0
    }
  }
  let out = ''
  for (const byte of bytes) {
    if (byte !== 0) break
    out += '1'
  }
  for (let k = digits.length - 1; k >= 0; k--) out += B58[digits[k]]
  return out
}

function signatureBytes(tx: AnyTransaction): Uint8Array {
  if (tx instanceof VersionedTransaction) return tx.signatures[0] ?? new Uint8Array(64)
  const sig = tx.signatures[0]?.signature
  return sig ? Uint8Array.from(sig) : new Uint8Array(64)
}

export function signatureOf(tx: AnyTransaction): string {
  return base58Encode(signatureBytes(tx))
}

function staticKeys(tx: AnyTransaction): PublicKey[] {
  return tx instanceof VersionedTransaction ? tx.message.staticAccountKeys : tx.compileMessage().accountKeys
}

function recentBlockhashOf(tx: AnyTransaction): string {
  return (tx instanceof VersionedTransaction ? tx.message.recentBlockhash : tx.recentBlockhash) ?? ''
}

function toKey(value: unknown, what = 'pubkey'): PublicKey {
  try {
    return new PublicKey(value as string)
  } catch {
    throw new RpcFailure(-32602, `Invalid param: Invalid ${what}`)
  }
}

function asConfig(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

export class LiteSvmChain {
  readonly svm: LiteSVM
  slot = 1
  blockHeight: number
  /** Every JSON-RPC call received, in order. */
  readonly calls: RpcCall[] = []
  /** Every sendTransaction the RPC accepted, in order. */
  readonly sends: SendRecord[] = []
  /** Every simulateTransaction answer, in order. */
  readonly simulations: SimulationResult[] = []
  /** Answer to getRecentPrioritizationFees (default: no samples, like a quiet cluster). */
  prioritizationFees: Array<{ slot: number; prioritizationFee: number }> = []
  /** A landed transaction reports 'processed' for this many status lookups before 'confirmed'. */
  processedPolls = 0
  /**
   * Test hook run before every RPC method. Throw an RpcFailure to fail the
   * call, return `{ result }` to answer it instead of the chain.
   */
  onRpc?: (method: string, params: unknown[]) => void | { result: unknown }

  private readonly known = new Set<string>()
  private readonly lifetimes = new Map<string, number>()
  private readonly records = new Map<string, TxRecord>()
  private readonly statusPolls = new Map<string, number>()
  private uniq = 0

  constructor(opts: { startBlockHeight?: number } = {}) {
    // Standard LiteSVM: builtins, sysvars, SPL Token, Token-2022, ATA, Memo, native mints, sigverify on.
    this.svm = new LiteSVM().withNativeMints()
    this.blockHeight = opts.startBlockHeight ?? 1_000
    this.lifetimes.set(this.svm.latestBlockhash(), this.blockHeight + BLOCKHASH_LIFETIME)
  }

  // ── State ──────────────────────────────────────────────────────────────

  /** The account, or null when it doesn't exist (0 lamports counts as deleted, as on a validator). */
  account(key: PublicKey | string): AccountInfo<Uint8Array> | null {
    const info = this.svm.getAccount(typeof key === 'string' ? new PublicKey(key) : key)
    if (!info || info.lamports === 0) return null
    return info
  }

  balance(key: PublicKey | string): number {
    return this.account(key)?.lamports ?? 0
  }

  exists(key: PublicKey | string): boolean {
    return this.account(key) !== null
  }

  airdrop(key: PublicKey, lamports: number): void {
    const res = this.svm.airdrop(key, BigInt(lamports))
    if (!res || res instanceof FailedTransactionMetadata) throw new Error(`airdrop to ${key.toBase58()} failed`)
    this.known.add(key.toBase58())
  }

  /** A funded keypair. */
  fundedKeypair(lamports = 100_000_000_000): Keypair {
    const kp = Keypair.generate()
    this.airdrop(kp.publicKey, lamports)
    return kp
  }

  /** Overwrites an account (bypassing the runtime — only for states transactions can't reach). */
  setAccount(key: PublicKey, info: AccountInfo<Uint8Array>): void {
    this.svm.setAccount(key, info)
    this.known.add(key.toBase58())
  }

  rentExempt(dataLen: number): number {
    return Number(this.svm.minimumBalanceForRentExemption(BigInt(dataLen)))
  }

  // ── Blockhashes ────────────────────────────────────────────────────────

  latestBlockhash(): { blockhash: string; lastValidBlockHeight: number } {
    const blockhash = this.svm.latestBlockhash()
    let lastValidBlockHeight = this.lifetimes.get(blockhash)
    if (lastValidBlockHeight === undefined) {
      lastValidBlockHeight = this.blockHeight + BLOCKHASH_LIFETIME
      this.lifetimes.set(blockhash, lastValidBlockHeight)
    }
    return { blockhash, lastValidBlockHeight }
  }

  isBlockhashValid(blockhash: string): boolean {
    const lastValid = this.lifetimes.get(blockhash)
    return lastValid !== undefined && this.blockHeight <= lastValid && blockhash === this.svm.latestBlockhash()
  }

  /** Lets every issued blockhash expire: block height moves past all their lastValidBlockHeights. */
  expireBlockhash(): void {
    const target = Math.max(this.blockHeight, ...this.lifetimes.values()) + 1
    this.slot += target - this.blockHeight
    this.blockHeight = target
    this.svm.expireBlockhash()
    this.latestBlockhash()
  }

  // ── Execution ──────────────────────────────────────────────────────────

  /** Runs a transaction on the SVM (no preflight). Load errors leave no trace, like a dropped tx. */
  process(tx: AnyTransaction): { signature: string; err: TransactionErrorJson | null; landed: boolean; record?: TxRecord } {
    const keys = staticKeys(tx)
    for (const k of keys) this.known.add(k.toBase58())
    const signature = signatureOf(tx)
    if (!this.isBlockhashValid(recentBlockhashOf(tx))) return { signature, err: 'BlockhashNotFound', landed: false }
    if (this.records.has(signature)) return { signature, err: 'AlreadyProcessed', landed: false }

    const pre: Record<string, number> = {}
    for (const k of keys) pre[k.toBase58()] = this.balance(k)
    const res = this.svm.sendTransaction(tx)
    let err: TransactionErrorJson | null = null
    const meta = res instanceof FailedTransactionMetadata ? res.meta() : res
    if (res instanceof FailedTransactionMetadata) {
      err = transactionErrorJson(res.err())
      if (isLoadError(err)) return { signature, err, landed: false }
    }
    const post: Record<string, number> = {}
    for (const k of keys) post[k.toBase58()] = this.balance(k)
    const sum = (r: Record<string, number>) => Object.values(r).reduce((s, v) => s + v, 0)

    this.slot += 1
    this.blockHeight += 1
    const record: TxRecord = {
      signature,
      slot: this.slot,
      err,
      logs: meta.logs(),
      unitsConsumed: Number(meta.computeUnitsConsumed()),
      fee: sum(pre) - sum(post),
      preBalances: pre,
      postBalances: post,
    }
    this.records.set(signature, record)
    return { signature, err, landed: true, record }
  }

  /** Simulates without changing state (signature check optional, like the RPC's sigVerify). */
  simulate(tx: AnyTransaction, opts: { sigVerify?: boolean } = {}): SimulationResult {
    if (!this.isBlockhashValid(recentBlockhashOf(tx))) return { err: 'BlockhashNotFound', logs: [], unitsConsumed: 0 }
    const sigVerify = opts.sigVerify ?? false
    if (!sigVerify) this.svm.withSigverify(false)
    try {
      const res = this.svm.simulateTransaction(tx)
      if (res instanceof FailedTransactionMetadata) {
        const meta = res.meta()
        return { err: transactionErrorJson(res.err()), logs: meta.logs(), unitsConsumed: Number(meta.computeUnitsConsumed()) }
      }
      const meta = res.meta()
      return { err: null, logs: meta.logs(), unitsConsumed: Number(meta.computeUnitsConsumed()) }
    } finally {
      if (!sigVerify) this.svm.withSigverify(true)
    }
  }

  /** Builds, signs and lands a setup transaction (payer = signers[0]). Throws with logs on failure. */
  send(instructions: TransactionInstruction[], signers: Keypair[]): TxRecord {
    const out = this.trySend(instructions, signers)
    if (out.err || !out.record) {
      throw new Error(`setup transaction failed: ${JSON.stringify(out.err)}\n${(out.record?.logs ?? []).join('\n')}`)
    }
    return out.record
  }

  /** Like send(), but returns the outcome instead of throwing (for "does this really fail on-chain?" checks). */
  trySend(
    instructions: TransactionInstruction[],
    signers: Keypair[],
  ): { signature: string; err: TransactionErrorJson | null; landed: boolean; record?: TxRecord; logs: string[] } {
    if (signers.length === 0) throw new Error('send needs at least the fee payer')
    // A distinct compute-unit limit per setup tx keeps identical instruction
    // lists (e.g. two equal mintTo calls) from colliding as AlreadyProcessed.
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 - (this.uniq++ % 100_000) }),
      ...instructions,
    )
    tx.feePayer = signers[0].publicKey
    tx.recentBlockhash = this.latestBlockhash().blockhash
    tx.sign(...signers)
    const out = this.process(tx)
    if (!out.landed) {
      const sim = this.simulate(tx, { sigVerify: true })
      return { ...out, logs: sim.logs }
    }
    return { ...out, logs: out.record?.logs ?? [] }
  }

  record(signature: string): TxRecord | undefined {
    return this.records.get(signature)
  }

  /** Every landed transaction, oldest first. */
  history(): TxRecord[] {
    return [...this.records.values()]
  }

  callsTo(method: string): RpcCall[] {
    return this.calls.filter((c) => c.method === method)
  }

  // ── JSON-RPC ───────────────────────────────────────────────────────────

  private context() {
    return { apiVersion: RPC_API_VERSION, slot: this.slot }
  }

  private encodeAccount(key: PublicKey, encoding: unknown): Record<string, unknown> | null {
    const info = this.account(key)
    if (!info) return null
    let data: unknown = [Buffer.from(info.data).toString('base64'), 'base64']
    if (encoding === 'jsonParsed') {
      const parsed = parseTokenAccount(key, info, (k) => this.account(k))
      if (parsed) data = parsed
    }
    return {
      data,
      executable: info.executable,
      lamports: info.lamports,
      owner: info.owner.toBase58(),
      rentEpoch: RENT_EPOCH_MAX,
      space: info.data.length,
    }
  }

  private tokenAccountsByOwner(params: unknown[]) {
    const owner = toKey(params[0])
    const filter = asConfig(params[1])
    const encoding = asConfig(params[2]).encoding ?? 'binary'
    let programId: PublicKey
    let mint: string | null = null
    if (typeof filter.mint === 'string') {
      const mintKey = toKey(filter.mint, 'mint')
      const mintInfo = this.account(mintKey)
      if (!mintInfo) throw new RpcFailure(-32602, 'Invalid param: could not find mint')
      programId = mintInfo.owner
      mint = mintKey.toBase58()
    } else if (typeof filter.programId === 'string') {
      programId = toKey(filter.programId, 'programId')
    } else {
      throw new RpcFailure(-32602, 'Invalid params: expected mint or programId filter')
    }
    if (!programId.equals(TOKEN_PROGRAM_ID) && !programId.equals(TOKEN_2022_PROGRAM_ID)) {
      throw new RpcFailure(-32602, 'Invalid param: unrecognized Token program id')
    }
    const ownerB58 = owner.toBase58()
    const value: Array<{ pubkey: string; account: Record<string, unknown> }> = []
    for (const address of this.known) {
      const key = new PublicKey(address)
      const info = this.account(key)
      if (!info || !info.owner.equals(programId)) continue
      // Agave drops accounts it cannot parse (e.g. whose mint is gone) from jsonParsed answers.
      const parsed = parseTokenAccount(key, info, (k) => this.account(k))
      if (!parsed || parsed.parsed.info.owner !== ownerB58) continue
      if (mint && parsed.parsed.info.mint !== mint) continue
      const account = this.encodeAccount(key, encoding)
      if (account) value.push({ pubkey: address, account })
    }
    return { context: this.context(), value }
  }

  private decodeTransaction(param: unknown): { tx: VersionedTransaction; bytes: Uint8Array } {
    try {
      const bytes = Uint8Array.from(Buffer.from(String(param), 'base64'))
      return { tx: VersionedTransaction.deserialize(bytes), bytes }
    } catch (err) {
      throw new RpcFailure(-32602, `invalid transaction: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private sendTransaction(params: unknown[]): string {
    const { tx, bytes } = this.decodeTransaction(params[0])
    const cfg = asConfig(params[1])
    const skipPreflight = cfg.skipPreflight === true
    const signature = signatureOf(tx)
    if (!skipPreflight) {
      const sim = this.records.has(signature)
        ? ({ err: 'AlreadyProcessed', logs: [], unitsConsumed: 0 } satisfies SimulationResult)
        : this.simulate(tx, { sigVerify: true })
      if (sim.err === 'SignatureFailure') throw new RpcFailure(-32003, 'Transaction signature verification failure')
      if (sim.err) {
        throw new RpcFailure(-32002, `Transaction simulation failed: ${transactionErrorText(sim.err)}`, {
          accounts: null,
          err: sim.err,
          innerInstructions: null,
          loadedAccountsDataSize: 0,
          logs: sim.logs,
          replacementBlockhash: null,
          returnData: null,
          unitsConsumed: sim.unitsConsumed,
        })
      }
    }
    const out = this.process(tx)
    if (out.err === 'SignatureFailure') throw new RpcFailure(-32003, 'Transaction signature verification failure')
    // With skipPreflight a dead blockhash or a duplicate is still "accepted":
    // the RPC returns the signature and the leader silently drops it.
    this.sends.push({ signature, bytes, skipPreflight, executed: out.landed })
    return signature
  }

  private simulateTransaction(params: unknown[]) {
    const { tx } = this.decodeTransaction(params[0])
    const cfg = asConfig(params[1])
    if (cfg.replaceRecentBlockhash === true) tx.message.recentBlockhash = this.latestBlockhash().blockhash
    const sim = this.simulate(tx, { sigVerify: cfg.sigVerify === true })
    this.simulations.push(sim)
    return {
      context: this.context(),
      value: {
        accounts: null,
        err: sim.err,
        innerInstructions: null,
        loadedAccountsDataSize: 0,
        logs: sim.logs,
        replacementBlockhash: null,
        returnData: null,
        unitsConsumed: sim.unitsConsumed,
      },
    }
  }

  private signatureStatuses(params: unknown[]) {
    const signatures = Array.isArray(params[0]) ? (params[0] as unknown[]) : []
    if (signatures.length > 256) throw new RpcFailure(-32602, 'Invalid param: too many signatures (max 256)')
    const value = signatures.map((s) => {
      const record = this.records.get(String(s))
      if (!record) return null
      const polls = (this.statusPolls.get(record.signature) ?? 0) + 1
      this.statusPolls.set(record.signature, polls)
      const processed = polls <= this.processedPolls
      return {
        confirmationStatus: processed ? 'processed' : 'confirmed',
        confirmations: processed ? 0 : 1,
        err: record.err,
        slot: record.slot,
        status: record.err ? { Err: record.err } : { Ok: null },
      }
    })
    return { context: this.context(), value }
  }

  /** Answers one JSON-RPC call (result value) or throws RpcFailure. */
  rpc(method: string, params: unknown[] = []): unknown {
    this.calls.push({ method, params })
    const override = this.onRpc?.(method, params)
    if (override) return override.result
    switch (method) {
      case 'getLatestBlockhash':
        return { context: this.context(), value: this.latestBlockhash() }
      case 'getBlockHeight':
        return this.blockHeight
      case 'getSlot':
        return this.slot
      case 'getBalance':
        return { context: this.context(), value: this.balance(toKey(params[0])) }
      case 'getAccountInfo':
        return { context: this.context(), value: this.encodeAccount(toKey(params[0]), asConfig(params[1]).encoding) }
      case 'getMultipleAccounts': {
        const keys = Array.isArray(params[0]) ? params[0] : []
        if (keys.length > 100) throw new RpcFailure(-32602, 'Too many inputs provided; max 100')
        const encoding = asConfig(params[1]).encoding
        return { context: this.context(), value: keys.map((k) => this.encodeAccount(toKey(k), encoding)) }
      }
      case 'getTokenAccountsByOwner':
        return this.tokenAccountsByOwner(params)
      case 'getRecentPrioritizationFees':
        return this.prioritizationFees.map((f) => ({ ...f }))
      case 'getMinimumBalanceForRentExemption':
        return this.rentExempt(Number(params[0]))
      case 'simulateTransaction':
        return this.simulateTransaction(params)
      case 'sendTransaction':
        return this.sendTransaction(params)
      case 'getSignatureStatuses':
        return this.signatureStatuses(params)
      case 'getVersion':
        return { 'feature-set': 0, 'solana-core': RPC_API_VERSION }
      case 'getGenesisHash':
        return '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
      default:
        throw new RpcFailure(-32601, 'Method not found')
    }
  }

  /** A full JSON-RPC body (single request or batch) → the response body. Never throws. */
  handleJsonRpc(body: unknown): unknown {
    const one = (req: unknown) => {
      const r = asConfig(req)
      const id = r.id ?? null
      try {
        const result = this.rpc(String(r.method ?? ''), Array.isArray(r.params) ? r.params : [])
        return { jsonrpc: '2.0', id, result }
      } catch (err) {
        if (err instanceof RpcFailure) {
          const error: Record<string, unknown> = { code: err.code, message: err.message }
          if (err.data !== undefined) error.data = err.data
          return { jsonrpc: '2.0', id, error }
        }
        return { jsonrpc: '2.0', id, error: { code: -32603, message: `Internal error: ${err instanceof Error ? err.message : String(err)}` } }
      }
    }
    return Array.isArray(body) ? body.map(one) : one(body)
  }
}

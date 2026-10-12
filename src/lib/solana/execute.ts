import {
  PublicKey,
  VersionedTransaction,
  type AccountInfo,
  type Connection,
  type ParsedAccountData,
  type TransactionError,
} from '@solana/web3.js'
import type {
  BatchProgress,
  BatchStatus,
  CleanupBatch,
  CleanupQuote,
  CleanupWallet,
  FeeConfig,
  TokenAccountInfo,
} from '../types'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from './programs'
import { abortError } from './scan'
import {
  MAX_TRANSACTION_BYTES,
  assertSafeCleanupTransaction,
  buildCleanupTransactions,
  withBlockhash,
} from './transactions'

export interface ExecuteCleanupParams {
  connection: Connection
  wallet: CleanupWallet
  quote: CleanupQuote
  fee: FeeConfig
  /** Called with a fresh array every time any batch changes status. */
  onProgress: (progress: BatchProgress[]) => void
  signal?: AbortSignal
}

export const MESSAGES = {
  hasTokens: 'An account received tokens since the scan — rescan and try again',
  noSolForFee: 'Not enough SOL in the wallet to pay the network fee',
  alreadyClosed: 'An account was already closed — rescan',
  frozen: 'An account was frozen since the scan — rescan',
  ownerChanged: 'An account’s owner or close authority changed since the scan — rescan',
  rent: 'The transaction would leave an account below Solana’s rent-exempt minimum',
  blockhash: 'The network didn’t recognise the transaction’s blockhash — try again',
  expired: 'Transaction expired before it landed — try again',
  walletModified: 'Wallet modified the transaction; not sent',
  walletBadResponse: 'The wallet returned an unexpected response; not sent',
  feeWalletUnfunded:
    'The service fee wallet is not funded yet (it needs at least 0.00089088 SOL to receive fees), so this transaction can’t succeed — please tell the mopi operator',
  nativeChanged: 'A wrapped SOL account changed since the scan — rescan and try again',
} as const

/** Send options: preflight on (catches state that changed since simulation, and dead blockhashes, for free); RPC retries until expiry. */
export const SEND_OPTIONS = { skipPreflight: false, preflightCommitment: 'confirmed' } as const

/** Extra context for describeTransactionError. */
export interface TransactionErrorContext {
  /** Static account keys of the message (base58), by index. */
  accountKeys?: readonly string[]
  /** Configured service fee wallet (base58). */
  feeWallet?: string | null
}

const TOKEN_PROGRAMS = new Set([TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()])

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

/** Program id (base58) of every top-level instruction in `tx`, by index. */
function instructionPrograms(tx: VersionedTransaction | undefined): string[] {
  if (!tx) return []
  try {
    const keys = tx.message.staticAccountKeys
    return tx.message.compiledInstructions.map((ix) => keys[ix.programIdIndex]?.toBase58() ?? '')
  } catch {
    return []
  }
}

/** Static account keys (base58) of `tx`, by index. */
function accountKeysOf(tx: VersionedTransaction | undefined): string[] {
  if (!tx) return []
  try {
    return tx.message.staticAccountKeys.map((k) => k.toBase58())
  } catch {
    return []
  }
}

/** First log line that looks like an error, without the "Program log: " noise. */
function firstRelevantLog(logs: readonly string[] | null | undefined): string | null {
  if (!logs) return null
  const line = logs.find((l) => /error|failed|insufficient|invalid/i.test(l))
  if (!line) return null
  return line.replace(/^Program log:\s*/, '').replace(/^Error:\s*/, '').trim() || null
}

/**
 * Human-readable explanation for a failed simulation / confirmation.
 * `programs` maps instruction index → program id so token-program custom
 * errors are only interpreted for token instructions.
 */
export function describeTransactionError(
  err: TransactionError | null | undefined,
  logs?: readonly string[] | null,
  programs: readonly string[] = [],
  context: TransactionErrorContext = {},
): string {
  const text = typeof err === 'string' ? err : (() => {
    try {
      return JSON.stringify(err) ?? ''
    } catch {
      return String(err)
    }
  })()
  const allLogs = (logs ?? []).join('\n')

  if (/InsufficientFundsForFee/.test(text) || /insufficient funds for fee/i.test(allLogs)) return MESSAGES.noSolForFee
  // Top-level AccountNotFound = the fee payer has no lamports at all.
  if (err === 'AccountNotFound') return MESSAGES.noSolForFee
  if (/InsufficientFundsForRent/.test(text)) {
    // { InsufficientFundsForRent: { account_index } } — the account that would end up below the rent-exempt minimum.
    const index =
      err && typeof err === 'object' && 'InsufficientFundsForRent' in err
        ? Number((err as { InsufficientFundsForRent?: { account_index?: unknown } }).InsufficientFundsForRent?.account_index)
        : NaN
    if (isFeeWalletIndex(index, context)) return MESSAGES.feeWalletUnfunded
    return MESSAGES.rent
  }
  if (/BlockhashNotFound/.test(text)) return MESSAGES.blockhash

  if (err && typeof err === 'object' && 'InstructionError' in err) {
    const ie = (err as { InstructionError: unknown }).InstructionError
    if (Array.isArray(ie) && ie.length === 2) {
      const [index, detail] = ie as [number, unknown]
      const program = programs[index]
      const isToken = program === undefined || program === '' ? true : TOKEN_PROGRAMS.has(program)
      const custom =
        detail && typeof detail === 'object' && 'Custom' in detail ? Number((detail as { Custom: unknown }).Custom) : null
      if (isToken) {
        if (custom === 11) return MESSAGES.hasTokens
        if (custom === 9) return MESSAGES.alreadyClosed
        if (custom === 17) return MESSAGES.frozen
        if (custom === 4) return MESSAGES.ownerChanged
        if (detail === 'IncorrectProgramId' || detail === 'UninitializedAccount' || detail === 'InvalidAccountData') {
          return MESSAGES.alreadyClosed
        }
      }
    }
  }

  if (/custom program error: 0xb\b/i.test(allLogs)) return MESSAGES.hasTokens
  if (/account not found|could not find account|AccountNotFound/i.test(allLogs + text)) return MESSAGES.alreadyClosed

  const log = firstRelevantLog(logs)
  if (log) return log
  return text ? `Transaction failed: ${text}` : 'Transaction failed'
}

function isFeeWalletIndex(index: number, context: TransactionErrorContext): boolean {
  if (!Number.isInteger(index) || index < 0 || !context.feeWallet || !context.accountKeys) return false
  return context.accountKeys[index] === context.feeWallet
}

/** Human-readable explanation for a sendRawTransaction failure (usually a failed preflight simulation). */
export function describeSendError(
  err: unknown,
  programs: readonly string[] = [],
  context: TransactionErrorContext = {},
): string {
  const msg = errMessage(err)
  const rawLogs = err && typeof err === 'object' ? (err as { logs?: unknown }).logs : undefined
  const logs = Array.isArray(rawLogs) ? rawLogs.filter((l): l is string => typeof l === 'string') : []
  if (/blockhash not found/i.test(msg)) return MESSAGES.expired
  if (/insufficient funds for fee|no record of a prior credit/i.test(msg)) return MESSAGES.noSolForFee
  const rent = /account \((\d+)\) with insufficient funds for rent/i.exec(msg)
  if (rent) return isFeeWalletIndex(Number(rent[1]), context) ? MESSAGES.feeWalletUnfunded : MESSAGES.rent
  const custom = /Error processing Instruction (\d+): custom program error: 0x([0-9a-f]+)/i.exec(msg)
  if (custom) {
    const described = describeTransactionError(
      { InstructionError: [Number(custom[1]), { Custom: parseInt(custom[2], 16) }] },
      logs,
      programs,
      context,
    )
    if (!described.startsWith('Transaction failed')) return described
  }
  if (/simulation failed/i.test(msg)) {
    const log = firstRelevantLog(logs)
    if (log) return log
  }
  return `Could not send the transaction: ${msg}`
}

export function isUserRejection(err: unknown): boolean {
  if (!err || typeof err !== 'object') return typeof err === 'string' && /reject|declin|cancel/i.test(err)
  const name = (err as { name?: unknown }).name
  const message = (err as { message?: unknown }).message
  return name === 'WalletSignTransactionError' || (typeof message === 'string' && /reject|declin|cancel/i.test(message))
}

function isBlockheightExceeded(err: unknown): boolean {
  if (err && typeof err === 'object' && (err as { name?: unknown }).name === 'TransactionExpiredBlockheightExceededError') {
    return true
  }
  return /block ?height exceeded|has expired/i.test(errMessage(err))
}

/** An immutable copy of what the wallet returned: the exact wire bytes and the tx decoded from them. */
interface SignedSnapshot {
  bytes: Uint8Array
  tx: VersionedTransaction
}

/**
 * Serializes the wallet's response once and decodes our own copy from those
 * bytes. Every check runs on the copy and exactly these bytes are sent, so the
 * wallet-returned object (which may be mutated later, or whose serialize()
 * may disagree with its .message) is never trusted or touched again.
 * Returns null if the response is not a canonical v0 transaction.
 */
function snapshotSigned(signed: unknown): SignedSnapshot | null {
  if (!signed || typeof signed !== 'object') return null
  const serialize = (signed as { serialize?: unknown }).serialize
  if (typeof serialize !== 'function') return null
  try {
    const raw: unknown = serialize.call(signed)
    if (!raw || typeof raw !== 'object' || typeof (raw as { length?: unknown }).length !== 'number') return null
    const bytes = Uint8Array.from(raw as ArrayLike<number>)
    if (bytes.length === 0 || bytes.length > MAX_TRANSACTION_BYTES) return null
    const tx = VersionedTransaction.deserialize(bytes)
    if (tx.version !== 0) return null
    // Canonical round trip: no trailing or alternative encodings slip past the checks.
    const again = tx.serialize()
    if (again.length !== bytes.length || again.some((b, k) => b !== bytes[k])) return null
    return { bytes, tx }
  } catch {
    return null
  }
}

/** True if the live account still matches the empty native (wSOL) account we quoted. */
function nativeStillEmpty(
  info: AccountInfo<Buffer | ParsedAccountData> | null | undefined,
  quoted: TokenAccountInfo,
  ownerB58: string,
): boolean {
  if (!info) return false
  if (info.owner.toBase58() !== quoted.programId) return false
  if (info.lamports !== quoted.lamports) return false
  const data = info.data as Partial<ParsedAccountData> | Buffer
  if (!data || typeof data !== 'object' || !('parsed' in data)) return false
  const parsed = (data as ParsedAccountData).parsed as { type?: unknown; info?: Record<string, unknown> } | undefined
  const tokenInfo = parsed?.info
  if (parsed?.type !== 'account' || !tokenInfo) return false
  const amount = (tokenInfo.tokenAmount as { amount?: unknown } | undefined)?.amount
  return tokenInfo.isNative === true && tokenInfo.owner === ownerB58 && amount === '0'
}

const UNSENT: ReadonlySet<BatchStatus> = new Set(['pending', 'simulating', 'awaiting-signature'])

/**
 * Builds, verifies (assertSafeCleanupTransaction), simulates, signs (one
 * signAllTransactions prompt when available, else one prompt per batch, each
 * with a fresh blockhash), snapshots + re-verifies what the wallet returned,
 * drops expired blockhashes and changed wSOL accounts, sends exactly the
 * verified bytes (with preflight) and confirms every batch. A failed
 * simulation marks that batch failed and skips it; it never sends a
 * transaction that failed simulation.
 * Resolves with the final progress (never rejects for per-batch failures;
 * rejects only on wallet-level errors such as the user declining to sign).
 */
export async function executeCleanup(params: ExecuteCleanupParams): Promise<BatchProgress[]> {
  const { connection, wallet, quote, fee, onProgress, signal } = params
  const owner: PublicKey | null = wallet.publicKey
  if (!owner) throw new Error('Connect a wallet to continue.')
  if (!wallet.signAllTransactions && !wallet.signTransaction) throw new Error('This wallet cannot sign transactions.')

  const batches: CleanupBatch[] = quote.batches
  let progress: BatchProgress[] = batches.map((b) => ({
    index: b.index,
    status: 'pending',
    accountCount: b.accounts.length,
    reclaimLamports: b.reclaimLamports,
  }))
  const emit = () => onProgress(progress.map((p) => ({ ...p })))
  const update = (changes: Map<number, Partial<BatchProgress>>) => {
    if (changes.size === 0) return
    progress = progress.map((p, i) => {
      const c = changes.get(i)
      return c ? { ...p, ...c } : p
    })
    emit()
  }
  const set = (i: number, patch: Partial<BatchProgress>) => update(new Map([[i, patch]]))
  const setMany = (indices: number[], patch: Partial<BatchProgress>) =>
    update(new Map(indices.map((i) => [i, patch] as const)))
  const unsent = () => progress.flatMap((p, i) => (UNSENT.has(p.status) ? [i] : []))

  // Confirmations of already-sent transactions; awaited before returning or throwing.
  const pendingConfirms: Promise<void>[] = []
  const settle = () => Promise.allSettled(pendingConfirms)

  const abortIfNeeded = async () => {
    if (!signal?.aborted) return
    setMany(unsent(), { status: 'skipped' })
    await settle()
    throw abortError()
  }

  emit()
  if (batches.length === 0) return progress
  await abortIfNeeded()

  // 1. Build every transaction with one fresh blockhash.
  let built: Awaited<ReturnType<typeof buildCleanupTransactions>>
  try {
    built = await buildCleanupTransactions({ connection, owner, quote, fee })
  } catch (err) {
    setMany(unsent(), { status: 'failed', error: `Could not prepare the transactions: ${errMessage(err)}` })
    return progress
  }
  await abortIfNeeded()
  /** Current unsigned tx and its blockhash lifetime, per batch (the per-prompt path refreshes these). */
  const current: VersionedTransaction[] = [...built.transactions]
  const lifetimes = batches.map(() => ({ blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight }))
  const ownerB58 = owner.toBase58()
  const errorContext = (tx: VersionedTransaction | undefined): TransactionErrorContext => ({
    accountKeys: accountKeysOf(tx),
    feeWallet: fee.feeWallet,
  })

  // 2. Safety check what we built (defense in depth against builder bugs).
  let live: number[] = []
  {
    const failed = new Map<number, Partial<BatchProgress>>()
    batches.forEach((batch, i) => {
      const tx = current[i]
      try {
        if (!tx) throw new Error('transaction missing')
        assertSafeCleanupTransaction(tx, owner, batch, fee)
        live.push(i)
      } catch (err) {
        failed.set(i, { status: 'failed', error: `Safety check failed: ${errMessage(err)}` })
      }
    })
    update(failed)
  }

  // 3. Simulate. A failed simulation is never sent.
  setMany(live, { status: 'simulating' })
  const simOk = await Promise.all(
    live.map(async (i) => {
      const tx = current[i]
      try {
        const sim = await connection.simulateTransaction(tx, { sigVerify: false, commitment: 'confirmed' })
        if (sim.value.err) {
          set(i, {
            status: 'failed',
            error: describeTransactionError(sim.value.err, sim.value.logs, instructionPrograms(tx), errorContext(tx)),
          })
          return false
        }
        return true
      } catch (err) {
        set(i, { status: 'failed', error: `Simulation could not run: ${errMessage(err)}` })
        return false
      }
    }),
  )
  live = live.filter((_, k) => simOk[k])
  await abortIfNeeded()
  if (live.length === 0) return progress

  setMany(live, { status: 'awaiting-signature' })

  // Wallet-level signing failure: stop, keep what's already in flight, rethrow.
  const onSignError = async (err: unknown): Promise<never> => {
    if (isUserRejection(err)) setMany(unsent(), { status: 'skipped' })
    else setMany(unsent(), { status: 'failed', error: `The wallet could not sign: ${errMessage(err)}` })
    await settle()
    throw err
  }

  /**
   * Snapshots the wallet's response and re-verifies the snapshot. Returns the
   * snapshot to send, or null (batch marked failed) if the wallet changed it.
   */
  const verifySigned = (i: number, signed: unknown): SignedSnapshot | null => {
    const snap = snapshotSigned(signed)
    if (!snap) {
      set(i, { status: 'failed', error: MESSAGES.walletBadResponse })
      return null
    }
    try {
      assertSafeCleanupTransaction(snap.tx, owner, batches[i], fee)
      if (snap.tx.message.recentBlockhash !== lifetimes[i].blockhash) throw new Error('blockhash changed')
      const sig = snap.tx.signatures[0]
      if (!sig || sig.length !== 64 || sig.every((b) => b === 0)) throw new Error('not signed')
      return snap
    } catch {
      set(i, { status: 'failed', error: MESSAGES.walletModified })
      return null
    }
  }

  /** Marks batches whose blockhash already expired (signing took too long). Returns the rest. */
  const dropExpired = async (indices: number[]): Promise<number[]> => {
    if (indices.length === 0) return indices
    let height: number
    try {
      height = await connection.getBlockHeight('confirmed')
    } catch {
      return indices // can't tell; preflight rejects a dead blockhash anyway
    }
    if (typeof height !== 'number' || !Number.isFinite(height)) return indices
    const expired = indices.filter((i) => height > lifetimes[i].lastValidBlockHeight)
    setMany(expired, { status: 'failed', error: MESSAGES.expired })
    return indices.filter((i) => !expired.includes(i))
  }

  /**
   * Token programs let CloseAccount close a native (wSOL) account that holds a
   * balance, so the on-chain "has tokens" check never protects wSOL. Re-read
   * every native account right before sending and refuse batches whose wSOL
   * account is no longer exactly the empty account that was quoted.
   */
  const dropChangedNative = async (indices: number[]): Promise<number[]> => {
    const natives = indices.flatMap((i) => batches[i].accounts.filter((a) => a.isNative).map((a) => ({ i, a })))
    if (natives.length === 0) return indices
    const bad = new Map<number, Partial<BatchProgress>>()
    for (let k = 0; k < natives.length; k += 100) {
      const chunk = natives.slice(k, k + 100)
      try {
        const res = await connection.getMultipleParsedAccounts(
          chunk.map(({ a }) => new PublicKey(a.address)),
          { commitment: 'confirmed' },
        )
        const values = Array.isArray(res?.value) ? res.value : []
        chunk.forEach(({ i, a }, j) => {
          if (bad.has(i)) return
          const info = values[j]
          if (!nativeStillEmpty(info, a, ownerB58)) {
            bad.set(i, { status: 'failed', error: info ? MESSAGES.nativeChanged : MESSAGES.alreadyClosed })
          }
        })
      } catch (err) {
        for (const { i } of chunk) {
          if (!bad.has(i)) {
            bad.set(i, { status: 'failed', error: `Could not re-check a wrapped SOL account: ${errMessage(err)}` })
          }
        }
      }
    }
    update(bad)
    return indices.filter((i) => !bad.has(i))
  }

  /** Last word on a signature whose confirmation errored (e.g. a missed websocket notification). */
  const finalStatus = async (signature: string): Promise<'confirmed' | { err: TransactionError } | null> => {
    try {
      const res = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })
      const st = res?.value?.[0]
      if (!st) return null
      if (st.err) return { err: st.err }
      if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return 'confirmed'
      return null
    } catch {
      return null
    }
  }

  /** Sends exactly the verified bytes and queues the confirmation. */
  const send = async (i: number, snap: SignedSnapshot) => {
    set(i, { status: 'sending' })
    const programs = instructionPrograms(snap.tx)
    const ctx = errorContext(snap.tx)
    let signature: string
    try {
      signature = await connection.sendRawTransaction(snap.bytes, SEND_OPTIONS)
    } catch (err) {
      set(i, { status: 'failed', error: describeSendError(err, programs, ctx) })
      return
    }
    set(i, { signature })
    const { blockhash, lastValidBlockHeight } = lifetimes[i]
    pendingConfirms.push(
      (async () => {
        try {
          const res = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed')
          if (res.value.err) {
            set(i, { status: 'failed', error: describeTransactionError(res.value.err, null, programs, ctx) })
          } else {
            set(i, { status: 'confirmed' })
          }
        } catch (err) {
          const final = await finalStatus(signature)
          if (final === 'confirmed') set(i, { status: 'confirmed' })
          else if (final) set(i, { status: 'failed', error: describeTransactionError(final.err, null, programs, ctx) })
          else set(i, { status: 'failed', error: isBlockheightExceeded(err) ? MESSAGES.expired : errMessage(err) })
        }
      })(),
    )
  }

  // 4. Sign → snapshot + re-verify → pre-send checks → send → confirm.
  if (wallet.signAllTransactions) {
    let signed: unknown
    try {
      signed = await wallet.signAllTransactions(live.map((i) => current[i]))
    } catch (err) {
      return onSignError(err)
    }
    if (!Array.isArray(signed) || signed.length !== live.length) {
      setMany(live, { status: 'failed', error: MESSAGES.walletBadResponse })
      return progress
    }
    const response = signed as unknown[]
    // Snapshot every response synchronously, before anything else can run.
    const snaps = new Map<number, SignedSnapshot>()
    live.forEach((i, k) => {
      const snap = verifySigned(i, response[k])
      if (snap) snaps.set(i, snap)
    })
    await abortIfNeeded()
    let ready = await dropExpired([...snaps.keys()])
    ready = await dropChangedNative(ready)
    await abortIfNeeded()
    for (const i of ready) {
      await send(i, snaps.get(i)!)
    }
  } else if (wallet.signTransaction) {
    for (const [k, i] of live.entries()) {
      await abortIfNeeded()
      if (k > 0) {
        // Earlier prompts took time: give this one a fresh blockhash (same instructions).
        try {
          const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
          const refreshed = withBlockhash(current[i], blockhash)
          assertSafeCleanupTransaction(refreshed, owner, batches[i], fee)
          current[i] = refreshed
          lifetimes[i] = { blockhash, lastValidBlockHeight }
        } catch {
          // Keep the original; dropExpired / preflight catch a dead blockhash.
        }
      }
      let signed: unknown
      try {
        signed = await wallet.signTransaction(current[i])
      } catch (err) {
        return onSignError(err)
      }
      const snap = verifySigned(i, signed)
      if (!snap) continue
      let ready = await dropExpired([i])
      ready = await dropChangedNative(ready)
      if (ready.length === 1) await send(i, snap)
    }
  }

  await settle()
  return progress
}

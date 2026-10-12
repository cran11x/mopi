import type { Connection, PublicKey, TransactionError, VersionedTransaction } from '@solana/web3.js'
import type { BatchProgress, BatchStatus, CleanupBatch, CleanupQuote, CleanupWallet, FeeConfig } from '../types'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from './programs'
import { abortError } from './scan'
import { assertSafeCleanupTransaction, buildCleanupTransactions } from './transactions'

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
} as const

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
  if (/InsufficientFundsForRent/.test(text)) return MESSAGES.rent
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

function looksLikeVersionedTx(v: unknown): v is VersionedTransaction {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as VersionedTransaction).serialize === 'function' &&
    !!(v as VersionedTransaction).message &&
    Array.isArray((v as VersionedTransaction).signatures)
  )
}

const UNSENT: ReadonlySet<BatchStatus> = new Set(['pending', 'simulating', 'awaiting-signature'])

/**
 * Builds, verifies (assertSafeCleanupTransaction), simulates, signs (one
 * signAllTransactions prompt when available, else one prompt per batch),
 * sends and confirms every batch. A failed simulation marks that batch
 * failed and skips it; it never sends a transaction that failed simulation.
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
  const { transactions, blockhash, lastValidBlockHeight } = built

  // 2. Safety check what we built (defense in depth against builder bugs).
  let live: number[] = []
  {
    const failed = new Map<number, Partial<BatchProgress>>()
    batches.forEach((batch, i) => {
      const tx = transactions[i]
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
      const tx = transactions[i]
      try {
        const sim = await connection.simulateTransaction(tx, { sigVerify: false, commitment: 'confirmed' })
        if (sim.value.err) {
          set(i, { status: 'failed', error: describeTransactionError(sim.value.err, sim.value.logs, instructionPrograms(tx)) })
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

  /** Re-verifies a signed tx; returns false (and marks the batch failed) if the wallet changed it. */
  const verifySigned = (i: number, signed: unknown): signed is VersionedTransaction => {
    if (!looksLikeVersionedTx(signed)) {
      set(i, { status: 'failed', error: MESSAGES.walletBadResponse })
      return false
    }
    try {
      assertSafeCleanupTransaction(signed, owner, batches[i], fee)
      if (signed.message.recentBlockhash !== blockhash) throw new Error('blockhash changed')
      const sig = signed.signatures[0]
      if (!sig || sig.every((b) => b === 0)) throw new Error('not signed')
      return true
    } catch {
      set(i, { status: 'failed', error: MESSAGES.walletModified })
      return false
    }
  }

  /** Sends one verified tx and queues its confirmation. */
  const send = async (i: number, signed: VersionedTransaction) => {
    set(i, { status: 'sending' })
    let signature: string
    try {
      signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: true, maxRetries: 3 })
    } catch (err) {
      set(i, { status: 'failed', error: `Could not send the transaction: ${errMessage(err)}` })
      return
    }
    set(i, { signature })
    pendingConfirms.push(
      (async () => {
        try {
          const res = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed')
          if (res.value.err) {
            set(i, { status: 'failed', error: describeTransactionError(res.value.err, null, instructionPrograms(signed)) })
          } else {
            set(i, { status: 'confirmed' })
          }
        } catch (err) {
          set(i, { status: 'failed', error: isBlockheightExceeded(err) ? MESSAGES.expired : errMessage(err) })
        }
      })(),
    )
  }

  // 4. Sign → re-verify → send → confirm.
  if (wallet.signAllTransactions) {
    let signed: VersionedTransaction[]
    try {
      signed = await wallet.signAllTransactions(live.map((i) => transactions[i]))
    } catch (err) {
      return onSignError(err)
    }
    if (!Array.isArray(signed) || signed.length !== live.length) {
      setMany(live, { status: 'failed', error: MESSAGES.walletBadResponse })
      return progress
    }
    const verified = live.flatMap((i, k) => (verifySigned(i, signed[k]) ? [[i, signed[k]] as const] : []))
    await abortIfNeeded()
    for (const [i, tx] of verified) {
      await send(i, tx)
    }
  } else if (wallet.signTransaction) {
    for (const i of live) {
      await abortIfNeeded()
      let signed: VersionedTransaction
      try {
        signed = await wallet.signTransaction(transactions[i])
      } catch (err) {
        return onSignError(err)
      }
      if (verifySigned(i, signed)) await send(i, signed)
    }
  }

  await settle()
  return progress
}

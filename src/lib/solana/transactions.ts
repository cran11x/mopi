import { Buffer } from 'buffer'
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
} from '@solana/web3.js'
import type { CleanupBatch, CleanupQuote, FeeConfig, TokenAccountInfo } from '../types'
import { serviceFeeFor } from './fees'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from './programs'

/** Solana's maximum serialized transaction size. */
export const MAX_TRANSACTION_BYTES = 1232

/** SPL Token / Token-2022 CloseAccount instruction discriminator. */
export const CLOSE_ACCOUNT_DISCRIMINATOR = 9

const COMPUTE_BUDGET_SET_LIMIT = 2
const COMPUTE_BUDGET_SET_PRICE = 3
const SYSTEM_TRANSFER = 2

const TOKEN_PROGRAMS = [TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()]

/** SPL Token / Token-2022 CloseAccount (instruction index 9): account (w), destination (w), authority (signer). */
export function createCloseAccountInstruction(
  account: PublicKey,
  destination: PublicKey,
  authority: PublicKey,
  programId: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([CLOSE_ACCOUNT_DISCRIMINATOR]),
  })
}

function parsePubkey(value: string, what: string): PublicKey {
  try {
    return new PublicKey(value)
  } catch {
    throw new Error(`${what} is not a valid public key: ${value}`)
  }
}

function tokenProgramFor(account: TokenAccountInfo): PublicKey {
  if (!TOKEN_PROGRAMS.includes(account.programId)) {
    throw new Error(`Account ${account.address} is owned by ${account.programId}, not a token program`)
  }
  return new PublicKey(account.programId)
}

/** Validates the fee side of a batch; returns the fee wallet key when a fee is due. */
function feeRecipientFor(batch: CleanupBatch, fee: FeeConfig): PublicKey | null {
  const amount = batch.serviceFeeLamports
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error(`Batch ${batch.index}: invalid service fee ${amount}`)
  }
  if (amount === 0) return null
  if (!fee.feeWallet) throw new Error(`Batch ${batch.index}: a service fee is due but no fee wallet is configured`)
  return parsePubkey(fee.feeWallet, 'Fee wallet')
}

/** Instructions for one batch: compute budget, CloseAccount × n (destination = owner), optional fee transfer. */
export function buildBatchInstructions(owner: PublicKey, batch: CleanupBatch, fee: FeeConfig): TransactionInstruction[] {
  if (batch.accounts.length === 0) throw new Error(`Batch ${batch.index} has no accounts`)
  const ownerB58 = owner.toBase58()

  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: batch.computeUnitLimit }),
  ]
  if (fee.priorityFeeMicroLamports > 0) {
    ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: fee.priorityFeeMicroLamports }))
  }

  const seen = new Set<string>()
  for (const account of batch.accounts) {
    if (account.status !== 'eligible') {
      throw new Error(`Account ${account.address} is not eligible for closing (${account.status})`)
    }
    if (account.amountRaw !== '0') throw new Error(`Account ${account.address} holds tokens`)
    if (account.owner !== ownerB58) throw new Error(`Account ${account.address} is not owned by ${ownerB58}`)
    if (account.closeAuthority !== null && account.closeAuthority !== ownerB58) {
      throw new Error(`Account ${account.address} has a different close authority`)
    }
    if (seen.has(account.address)) throw new Error(`Account ${account.address} appears twice in batch ${batch.index}`)
    seen.add(account.address)
    const programId = tokenProgramFor(account)
    ixs.push(createCloseAccountInstruction(parsePubkey(account.address, 'Token account'), owner, owner, programId))
  }

  const feeWallet = feeRecipientFor(batch, fee)
  if (feeWallet) {
    ixs.push(SystemProgram.transfer({ fromPubkey: owner, toPubkey: feeWallet, lamports: batch.serviceFeeLamports }))
  }
  return ixs
}

export interface BuiltCleanupTransactions {
  transactions: VersionedTransaction[]
  blockhash: string
  lastValidBlockHeight: number
}

/** One v0 transaction per quote batch, sharing a fresh blockhash, fee payer = owner. */
export async function buildCleanupTransactions(params: {
  connection: Connection
  owner: PublicKey
  quote: CleanupQuote
  fee: FeeConfig
}): Promise<BuiltCleanupTransactions> {
  const { connection, owner, quote, fee } = params
  // Build instructions first so invalid input fails before any RPC call.
  const instructionSets = quote.batches.map((batch) => buildBatchInstructions(owner, batch, fee))
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')

  const transactions = instructionSets.map((instructions, i) => {
    const message = new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash, instructions }).compileToV0Message()
    const tx = new VersionedTransaction(message)
    const label = quote.batches[i]?.index ?? i
    let size: number
    try {
      size = tx.serialize().length
    } catch (err) {
      // web3.js serializes into a fixed 1232-byte buffer and throws when it overruns.
      throw new Error(
        `Batch ${label} transaction exceeds ${MAX_TRANSACTION_BYTES} bytes (${err instanceof Error ? err.message : String(err)})`,
      )
    }
    if (size > MAX_TRANSACTION_BYTES) {
      throw new Error(`Batch ${label} transaction is ${size} bytes (max ${MAX_TRANSACTION_BYTES})`)
    }
    return tx
  })

  return { transactions, blockhash, lastValidBlockHeight }
}

function readU32LE(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true)
}

function readU64LE(data: Uint8Array, offset: number): bigint {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(offset, true)
}

/**
 * Defense in depth: throws unless every instruction in `tx` is a ComputeBudget
 * instruction, a CloseAccount on an expected account whose destination AND
 * authority are `owner`, or a single SystemProgram transfer owner → feeWallet
 * of exactly `batch.serviceFeeLamports`. Called right before signing.
 *
 * Also bounds the network fee: the compute-unit limit may not exceed
 * `batch.computeUnitLimit` and the price may not exceed
 * `fee.priorityFeeMicroLamports`, so the priority fee can never exceed what
 * the quote displayed.
 */
export function assertSafeCleanupTransaction(
  tx: VersionedTransaction,
  owner: PublicKey,
  batch: CleanupBatch,
  fee: FeeConfig,
): void {
  const fail: (msg: string) => never = (msg) => {
    throw new Error(`Unsafe transaction (batch ${batch.index}): ${msg}`)
  }
  const ownerB58 = owner.toBase58()
  const message = tx.message

  // ── Batch / quote self-consistency ──────────────────────────────────────
  if (batch.accounts.length === 0) fail('batch has no accounts')
  const reclaim = batch.accounts.reduce((s, a) => s + a.lamports, 0)
  if (reclaim !== batch.reclaimLamports) fail(`batch reclaim ${batch.reclaimLamports} != sum of accounts ${reclaim}`)
  if (!Number.isSafeInteger(batch.serviceFeeLamports) || batch.serviceFeeLamports < 0) {
    fail(`invalid service fee ${batch.serviceFeeLamports}`)
  }
  const expectedFee = serviceFeeFor(batch.reclaimLamports, fee)
  if (batch.serviceFeeLamports !== expectedFee) {
    fail(`batch service fee ${batch.serviceFeeLamports} != ${expectedFee} computed from the fee config`)
  }
  const expected = new Map<string, TokenAccountInfo>()
  for (const a of batch.accounts) {
    if (a.status !== 'eligible') fail(`account ${a.address} is not eligible`)
    if (a.owner !== ownerB58) fail(`account ${a.address} is not owned by the wallet`)
    if (!TOKEN_PROGRAMS.includes(a.programId)) fail(`account ${a.address} has non-token program ${a.programId}`)
    if (expected.has(a.address)) fail(`account ${a.address} listed twice in batch`)
    expected.set(a.address, a)
  }
  let feeWallet: string | null = null
  if (batch.serviceFeeLamports > 0) {
    if (!fee.feeWallet) fail('service fee due but no fee wallet configured')
    try {
      feeWallet = new PublicKey(fee.feeWallet as string).toBase58()
    } catch {
      fail(`fee wallet is not a valid public key: ${fee.feeWallet}`)
    }
    if (feeWallet !== null && expected.has(feeWallet)) fail('fee wallet is one of the closed accounts')
  }

  // ── Message header ──────────────────────────────────────────────────────
  if (message.addressTableLookups.length > 0) fail('address lookup tables are not allowed')
  const keys = message.staticAccountKeys
  if (keys.length === 0 || !keys[0].equals(owner)) fail('fee payer is not the wallet')
  if (message.header.numRequiredSignatures !== 1) {
    fail(`expected exactly 1 signer, found ${message.header.numRequiredSignatures}`)
  }
  if (tx.signatures.length !== 1) fail(`expected exactly 1 signature slot, found ${tx.signatures.length}`)

  let decompiled: TransactionMessage
  try {
    decompiled = TransactionMessage.decompile(message)
  } catch (err) {
    return fail(`could not decompile message: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!decompiled.payerKey.equals(owner)) fail('fee payer is not the wallet')

  // ── Instructions ────────────────────────────────────────────────────────
  const computeBudget = ComputeBudgetProgram.programId.toBase58()
  const system = SystemProgram.programId.toBase58()
  const closed = new Set<string>()
  let unitLimitCount = 0
  let unitPriceCount = 0
  let systemCount = 0
  let feeTransfers = 0

  decompiled.instructions.forEach((ix, i) => {
    const program = ix.programId.toBase58()
    const data = Uint8Array.from(ix.data)
    const where = `instruction #${i}`

    if (program === computeBudget) {
      const kind = data[0]
      if (kind === COMPUTE_BUDGET_SET_LIMIT) {
        if (data.length !== 5) fail(`${where}: malformed SetComputeUnitLimit`)
        if (++unitLimitCount > 1) fail(`${where}: duplicate SetComputeUnitLimit`)
        const units = readU32LE(data, 1)
        if (units > batch.computeUnitLimit) fail(`${where}: compute unit limit ${units} > ${batch.computeUnitLimit}`)
      } else if (kind === COMPUTE_BUDGET_SET_PRICE) {
        if (data.length !== 9) fail(`${where}: malformed SetComputeUnitPrice`)
        if (++unitPriceCount > 1) fail(`${where}: duplicate SetComputeUnitPrice`)
        const price = readU64LE(data, 1)
        if (price > BigInt(Math.max(0, Math.floor(fee.priorityFeeMicroLamports)))) {
          fail(`${where}: compute unit price ${price} > ${fee.priorityFeeMicroLamports}`)
        }
      } else {
        fail(`${where}: ComputeBudget instruction type ${kind} is not allowed`)
      }
      if (ix.keys.length !== 0) fail(`${where}: ComputeBudget instruction must not reference accounts`)
      return
    }

    if (TOKEN_PROGRAMS.includes(program)) {
      if (data.length !== 1 || data[0] !== CLOSE_ACCOUNT_DISCRIMINATOR) fail(`${where}: token instruction is not CloseAccount`)
      if (ix.keys.length !== 3) fail(`${where}: CloseAccount must have exactly 3 accounts`)
      const [acct, dest, auth] = ix.keys
      const acctB58 = acct.pubkey.toBase58()
      const info = expected.get(acctB58)
      if (!info) fail(`${where}: closes ${acctB58}, which is not in this batch`)
      if (closed.has(acctB58)) fail(`${where}: closes ${acctB58} twice`)
      closed.add(acctB58)
      if (info && info.programId !== program) fail(`${where}: ${acctB58} closed via the wrong token program`)
      if (!dest.pubkey.equals(owner)) fail(`${where}: destination ${dest.pubkey.toBase58()} is not the wallet`)
      if (!auth.pubkey.equals(owner)) fail(`${where}: authority ${auth.pubkey.toBase58()} is not the wallet`)
      if (!auth.isSigner) fail(`${where}: authority is not a signer`)
      return
    }

    if (program === system) {
      if (++systemCount > 1) fail(`${where}: more than one System instruction`)
      if (data.length !== 12 || readU32LE(data, 0) !== SYSTEM_TRANSFER) fail(`${where}: System instruction is not Transfer`)
      if (ix.keys.length !== 2) fail(`${where}: Transfer must have exactly 2 accounts`)
      const [from, to] = ix.keys
      if (!from.pubkey.equals(owner)) fail(`${where}: transfer source is not the wallet`)
      if (batch.serviceFeeLamports === 0 || feeWallet === null) fail(`${where}: no service fee is due for this batch`)
      if (to.pubkey.toBase58() !== feeWallet) fail(`${where}: fee sent to ${to.pubkey.toBase58()}, not the fee wallet`)
      const lamports = readU64LE(data, 4)
      if (lamports !== BigInt(batch.serviceFeeLamports)) {
        fail(`${where}: fee transfer of ${lamports} lamports != quoted ${batch.serviceFeeLamports}`)
      }
      feeTransfers++
      return
    }

    fail(`${where}: program ${program} is not allowed`)
  })

  if (unitPriceCount > 0 && unitLimitCount === 0) fail('compute unit price without a compute unit limit')
  if (closed.size !== batch.accounts.length) {
    fail(`expected ${batch.accounts.length} CloseAccount instructions, found ${closed.size}`)
  }
  if (batch.serviceFeeLamports > 0 && feeTransfers !== 1) fail('the service fee transfer is missing')
}

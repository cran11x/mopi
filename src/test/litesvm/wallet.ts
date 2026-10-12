import { VersionedTransaction, type Keypair, type PublicKey } from '@solana/web3.js'

// A wallet that really signs (ed25519, via Keypair) — what Phantom & co. do
// after the user presses Approve. Like a browser wallet it hands back new
// transaction objects (deserialized from the signed bytes), not the inputs.

export interface KeypairWalletOptions {
  /** 'all' exposes signAllTransactions (one prompt); 'single' only signTransaction (one prompt per batch). */
  mode?: 'all' | 'single'
  /** Runs while the "prompt" is open, before signing (e.g. let the blockhash expire). */
  beforeSign?: (txs: VersionedTransaction[], call: number) => void | Promise<void>
  /** Reject like a user pressing Cancel. */
  reject?: boolean
}

export interface KeypairWallet {
  publicKey: PublicKey
  signAllTransactions?: <T extends VersionedTransaction>(txs: T[]) => Promise<T[]>
  signTransaction?: <T extends VersionedTransaction>(tx: T) => Promise<T>
  /** Signing prompts so far. */
  readonly prompts: number
  /** Transactions signed so far. */
  readonly signed: VersionedTransaction[]
}

export function signWithKeypair(keypair: Keypair, bytes: Uint8Array): Uint8Array {
  const tx = VersionedTransaction.deserialize(bytes)
  tx.sign([keypair])
  return tx.serialize()
}

export function keypairWallet(keypair: Keypair, opts: KeypairWalletOptions = {}): KeypairWallet {
  const signed: VersionedTransaction[] = []
  let prompts = 0
  const signOne = (tx: VersionedTransaction): VersionedTransaction => {
    const copy = VersionedTransaction.deserialize(signWithKeypair(keypair, tx.serialize()))
    signed.push(copy)
    return copy
  }
  const prompt = async (txs: VersionedTransaction[]) => {
    prompts += 1
    await opts.beforeSign?.(txs, prompts)
    if (opts.reject) throw new Error('User rejected the request.')
  }
  const wallet: KeypairWallet = {
    publicKey: keypair.publicKey,
    get prompts() {
      return prompts
    },
    signed,
  }
  if ((opts.mode ?? 'all') === 'all') {
    wallet.signAllTransactions = async <T extends VersionedTransaction>(txs: T[]) => {
      await prompt(txs)
      return txs.map((tx) => signOne(tx) as T)
    }
  }
  wallet.signTransaction = async <T extends VersionedTransaction>(tx: T) => {
    await prompt([tx])
    return signOne(tx) as T
  }
  return wallet
}

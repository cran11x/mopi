import { Buffer } from 'buffer'
import { Keypair, PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js'
import {
  AuthorityType,
  ExtensionType,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createApproveCheckedInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createBurnCheckedInstruction,
  createCloseAccountInstruction,
  createEnableCpiGuardInstruction,
  createEnableRequiredMemoTransfersInstruction,
  createFreezeAccountInstruction,
  createInitializeAccount3Instruction,
  createInitializeImmutableOwnerInstruction,
  createInitializeMint2Instruction,
  createInitializeNonTransferableMintInstruction,
  createInitializePausableConfigInstruction,
  createInitializeTransferFeeConfigInstruction,
  createInitializeTransferHookInstruction,
  createMintToCheckedInstruction,
  createSetAuthorityInstruction,
  createSyncNativeInstruction,
  createTransferCheckedInstruction,
  createTransferCheckedWithFeeInstruction,
  getAccountLen,
  getAccountTypeOfMintType,
  getExtensionTypes,
  getAssociatedTokenAddressSync,
  getMintLen,
  unpackMint,
} from '@solana/spl-token'
import type { LiteSvmChain, TxRecord } from './chain'

// Builds token state the way it happens on mainnet: every mint, account,
// extension, balance, freeze and authority change below is a real SPL Token /
// Token-2022 / ATA instruction executed by LiteSVM. Nothing is written with
// setAccount. (@solana/spl-token is used only here, in test setup — the app
// bundle never imports it.)

export type Program = 'spl-token' | 'token-2022'

export function programIdOf(program: Program): PublicKey {
  return program === 'token-2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
}

export interface MintOptions {
  program?: Program
  decimals?: number
  /** Freeze authority (the factory's payer when true). */
  freezable?: boolean
  /** Token-2022 TransferFeeConfig. */
  transferFee?: { basisPoints: number; maximumFee: bigint }
  /** Token-2022 NonTransferable (accounts get NonTransferableAccount + ImmutableOwner). */
  nonTransferable?: boolean
  /** Token-2022 TransferHook program (accounts get TransferHookAccount). */
  transferHook?: PublicKey
  /** Token-2022 Pausable (accounts get PausableAccount). */
  pausable?: boolean
}

export interface MintRef {
  address: PublicKey
  program: Program
  programId: PublicKey
  decimals: number
}

export class TokenFactory {
  /** Pays for everything and is mint + freeze authority of every mint it creates. */
  readonly payer: Keypair

  constructor(
    readonly chain: LiteSvmChain,
    payer?: Keypair,
  ) {
    this.payer = payer ?? chain.fundedKeypair(1_000_000_000_000)
  }

  private send(ixs: TransactionInstruction[], extraSigners: Keypair[] = []): TxRecord {
    const signers = [this.payer, ...extraSigners.filter((s) => !s.publicKey.equals(this.payer.publicKey))]
    return this.chain.send(ixs, signers)
  }

  createMint(opts: MintOptions = {}): MintRef {
    const program = opts.program ?? 'spl-token'
    const programId = programIdOf(program)
    const decimals = opts.decimals ?? 6
    const mint = Keypair.generate()
    const extensions: ExtensionType[] = []
    if (opts.transferFee) extensions.push(ExtensionType.TransferFeeConfig)
    if (opts.nonTransferable) extensions.push(ExtensionType.NonTransferable)
    if (opts.transferHook) extensions.push(ExtensionType.TransferHook)
    if (opts.pausable) extensions.push(ExtensionType.PausableConfig)
    if (extensions.length > 0 && program !== 'token-2022') throw new Error('mint extensions need Token-2022')
    const space = getMintLen(extensions)
    const auth = this.payer.publicKey
    const ixs: TransactionInstruction[] = [
      SystemProgram.createAccount({
        fromPubkey: auth,
        newAccountPubkey: mint.publicKey,
        lamports: this.chain.rentExempt(space),
        space,
        programId,
      }),
    ]
    if (opts.transferFee) {
      ixs.push(
        createInitializeTransferFeeConfigInstruction(
          mint.publicKey,
          auth,
          auth,
          opts.transferFee.basisPoints,
          opts.transferFee.maximumFee,
          programId,
        ),
      )
    }
    if (opts.nonTransferable) ixs.push(createInitializeNonTransferableMintInstruction(mint.publicKey, programId))
    if (opts.transferHook) ixs.push(createInitializeTransferHookInstruction(mint.publicKey, auth, opts.transferHook, programId))
    if (opts.pausable) ixs.push(createInitializePausableConfigInstruction(mint.publicKey, auth, programId))
    ixs.push(createInitializeMint2Instruction(mint.publicKey, decimals, auth, opts.freezable ? auth : null, programId))
    this.send(ixs, [mint])
    return { address: mint.publicKey, program, programId, decimals }
  }

  /** The owner's associated token account (created by the ATA program, so Token-2022 ones get ImmutableOwner + mint-required extensions). */
  createAta(owner: PublicKey, mint: MintRef): PublicKey {
    const ata = getAssociatedTokenAddressSync(mint.address, owner, true, mint.programId)
    this.send([createAssociatedTokenAccountIdempotentInstruction(this.payer.publicKey, ata, owner, mint.address, mint.programId)])
    return ata
  }

  /**
   * A non-associated token account (fresh keypair address) with explicit
   * account extensions. ImmutableOwner is initialized before the account;
   * MemoTransfer / CpiGuard are enabled afterwards by the owner, exactly as a
   * wallet would.
   */
  createAccount(
    owner: Keypair | PublicKey,
    mint: MintRef,
    opts: { immutableOwner?: boolean; memoTransfer?: boolean; cpiGuard?: boolean; extra?: ExtensionType[] } = {},
  ): PublicKey {
    const account = Keypair.generate()
    // Space for what the mint forces on its accounts (as the ATA program
    // computes with GetAccountDataSize) plus the requested extensions.
    const extensions = new Set<ExtensionType>([...this.requiredAccountExtensions(mint), ...(opts.extra ?? [])])
    if (opts.immutableOwner) extensions.add(ExtensionType.ImmutableOwner)
    if (opts.memoTransfer) extensions.add(ExtensionType.MemoTransfer)
    if (opts.cpiGuard) extensions.add(ExtensionType.CpiGuard)
    if (extensions.size > 0 && mint.program !== 'token-2022') throw new Error('account extensions need Token-2022')
    const ownerKey = owner instanceof Keypair ? owner.publicKey : owner
    const signers = [account]
    if (opts.memoTransfer || opts.cpiGuard) {
      if (!(owner instanceof Keypair)) throw new Error('enabling memo transfer / CPI guard needs the owner keypair')
      signers.push(owner)
    }
    const space = getAccountLen([...extensions])
    const ixs: TransactionInstruction[] = [
      SystemProgram.createAccount({
        fromPubkey: this.payer.publicKey,
        newAccountPubkey: account.publicKey,
        lamports: this.chain.rentExempt(space),
        space,
        programId: mint.programId,
      }),
    ]
    if (opts.immutableOwner) ixs.push(createInitializeImmutableOwnerInstruction(account.publicKey, mint.programId))
    ixs.push(createInitializeAccount3Instruction(account.publicKey, mint.address, ownerKey, mint.programId))
    if (opts.memoTransfer) {
      ixs.push(createEnableRequiredMemoTransfersInstruction(account.publicKey, ownerKey, [], mint.programId))
    }
    if (opts.cpiGuard) ixs.push(createEnableCpiGuardInstruction(account.publicKey, ownerKey, [], mint.programId))
    this.send(ixs, signers)
    return account.publicKey
  }

  /** Account extensions InitializeAccount adds for this mint (Token-2022's get_required_init_account_extensions). */
  requiredAccountExtensions(mint: MintRef): ExtensionType[] {
    if (mint.program !== 'token-2022') return []
    const info = this.chain.account(mint.address)
    if (!info) throw new Error(`mint ${mint.address.toBase58()} not found`)
    const data = unpackMint(mint.address, { ...info, data: Buffer.from(info.data) }, mint.programId)
    const out: ExtensionType[] = []
    for (const type of getExtensionTypes(data.tlvData)) {
      const accountType = getAccountTypeOfMintType(type)
      if (accountType !== ExtensionType.Uninitialized) out.push(accountType)
      if (type === ExtensionType.NonTransferable) out.push(ExtensionType.ImmutableOwner)
    }
    return out
  }

  mintTo(mint: MintRef, destination: PublicKey, amount: bigint): void {
    this.send([
      createMintToCheckedInstruction(mint.address, destination, this.payer.publicKey, amount, mint.decimals, [], mint.programId),
    ])
  }

  burn(mint: MintRef, account: PublicKey, owner: Keypair, amount: bigint): void {
    this.send(
      [createBurnCheckedInstruction(account, mint.address, owner.publicKey, amount, mint.decimals, [], mint.programId)],
      [owner],
    )
  }

  transfer(mint: MintRef, source: PublicKey, destination: PublicKey, owner: Keypair, amount: bigint): void {
    this.send(
      [createTransferCheckedInstruction(source, mint.address, destination, owner.publicKey, amount, mint.decimals, [], mint.programId)],
      [owner],
    )
  }

  /** TransferCheckedWithFee: the fee is withheld in the destination account. */
  transferWithFee(mint: MintRef, source: PublicKey, destination: PublicKey, owner: Keypair, amount: bigint, fee: bigint): void {
    this.send(
      [
        createTransferCheckedWithFeeInstruction(
          source,
          mint.address,
          destination,
          owner.publicKey,
          amount,
          mint.decimals,
          fee,
          [],
          mint.programId,
        ),
      ],
      [owner],
    )
  }

  freeze(mint: MintRef, account: PublicKey): void {
    this.send([createFreezeAccountInstruction(account, mint.address, this.payer.publicKey, [], mint.programId)])
  }

  /** Hands the CloseAccount authority to `newAuthority` (signed by the owner). */
  setCloseAuthority(mint: MintRef, account: PublicKey, owner: Keypair, newAuthority: PublicKey | null): void {
    this.send(
      [createSetAuthorityInstruction(account, owner.publicKey, AuthorityType.CloseAccount, newAuthority, [], mint.programId)],
      [owner],
    )
  }

  /** The SPL Token native mint (wrapped SOL), which LiteSVM preloads. */
  get nativeMint(): MintRef {
    return { address: NATIVE_MINT, program: 'spl-token', programId: TOKEN_PROGRAM_ID, decimals: 9 }
  }

  /** An empty wrapped-SOL account (not the ATA): amount 0, lamports = its rent-exempt reserve. */
  createEmptyWsol(owner: PublicKey): PublicKey {
    return this.createAccount(owner, this.nativeMint)
  }

  /** Wraps `lamports` of the owner's SOL: create the wSOL ATA, transfer into it, SyncNative. */
  wrapSol(owner: Keypair, lamports: number): PublicKey {
    const ata = this.createAta(owner.publicKey, this.nativeMint)
    this.send(
      [
        SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: ata, lamports }),
        createSyncNativeInstruction(ata, TOKEN_PROGRAM_ID),
      ],
      [owner],
    )
    return ata
  }

  /** Approves a delegate (Token's Approve; amount 0 is allowed and leaves a delegate set). */
  approve(mint: MintRef, account: PublicKey, owner: Keypair, delegate: PublicKey, amount: bigint): void {
    this.send(
      [createApproveCheckedInstruction(account, mint.address, delegate, owner.publicKey, amount, mint.decimals, [], mint.programId)],
      [owner],
    )
  }

  /** Attempts CloseAccount (destination = authority = owner) on-chain; returns the raw outcome. */
  tryClose(account: PublicKey, owner: Keypair, programId: PublicKey) {
    return this.chain.trySend([createCloseAccountInstruction(account, owner.publicKey, owner.publicKey, [], programId)], [
      this.payer,
      owner,
    ])
  }
}

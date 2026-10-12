// LiteSVM error objects → the JSON shapes and messages a real Solana RPC
// (Agave) produces, so web3.js and mopi's error handling see exactly what they
// would see on mainnet.
//
// `TransactionError` is serialized by serde as either a bare string
// ("BlockhashNotFound") or a single-key object
// ({ "InstructionError": [1, { "Custom": 11 }] },
//  { "InsufficientFundsForRent": { "account_index": 2 } }).

/** TransactionError as the RPC serializes it (what web3.js hands to the app). */
export type TransactionErrorJson = string | Record<string, unknown>

// litesvm's enums are `const enum`s in an ambient .d.ts, which isolated
// modules can't read, so the variant names are listed here in enum order.
const TRANSACTION_ERRORS = [
  'AccountInUse',
  'AccountLoadedTwice',
  'AccountNotFound',
  'ProgramAccountNotFound',
  'InsufficientFundsForFee',
  'InvalidAccountForFee',
  'AlreadyProcessed',
  'BlockhashNotFound',
  'CallChainTooDeep',
  'MissingSignatureForFee',
  'InvalidAccountIndex',
  'SignatureFailure',
  'InvalidProgramForExecution',
  'SanitizeFailure',
  'ClusterMaintenance',
  'AccountBorrowOutstanding',
  'WouldExceedMaxBlockCostLimit',
  'UnsupportedVersion',
  'InvalidWritableAccount',
  'WouldExceedMaxAccountCostLimit',
  'WouldExceedAccountDataBlockLimit',
  'TooManyAccountLocks',
  'AddressLookupTableNotFound',
  'InvalidAddressLookupTableOwner',
  'InvalidAddressLookupTableData',
  'InvalidAddressLookupTableIndex',
  'InvalidRentPayingAccount',
  'WouldExceedMaxVoteCostLimit',
  'WouldExceedAccountDataTotalLimit',
  'MaxLoadedAccountsDataSizeExceeded',
  'ResanitizationNeeded',
  'InvalidLoadedAccountsDataSizeLimit',
  'UnbalancedTransaction',
  'ProgramCacheHitMaxLimit',
  'CommitCancelled',
] as const

const INSTRUCTION_ERRORS = [
  'GenericError',
  'InvalidArgument',
  'InvalidInstructionData',
  'InvalidAccountData',
  'AccountDataTooSmall',
  'InsufficientFunds',
  'IncorrectProgramId',
  'MissingRequiredSignature',
  'AccountAlreadyInitialized',
  'UninitializedAccount',
  'UnbalancedInstruction',
  'ModifiedProgramId',
  'ExternalAccountLamportSpend',
  'ExternalAccountDataModified',
  'ReadonlyLamportChange',
  'ReadonlyDataModified',
  'DuplicateAccountIndex',
  'ExecutableModified',
  'RentEpochModified',
  'NotEnoughAccountKeys',
  'AccountDataSizeChanged',
  'AccountNotExecutable',
  'AccountBorrowFailed',
  'AccountBorrowOutstanding',
  'DuplicateAccountOutOfSync',
  'InvalidError',
  'ExecutableDataModified',
  'ExecutableLamportChange',
  'ExecutableAccountNotRentExempt',
  'UnsupportedProgramId',
  'CallDepth',
  'MissingAccount',
  'ReentrancyNotAllowed',
  'MaxSeedLengthExceeded',
  'InvalidSeeds',
  'InvalidRealloc',
  'ComputationalBudgetExceeded',
  'PrivilegeEscalation',
  'ProgramEnvironmentSetupFailure',
  'ProgramFailedToComplete',
  'ProgramFailedToCompile',
  'Immutable',
  'IncorrectAuthority',
  'AccountNotRentExempt',
  'InvalidAccountOwner',
  'ArithmeticOverflow',
  'UnsupportedSysvar',
  'IllegalOwner',
  'MaxAccountsDataAllocationsExceeded',
  'MaxAccountsExceeded',
  'MaxInstructionTraceLengthExceeded',
  'BuiltinProgramsMustConsumeComputeUnits',
  'BorshIoError',
] as const

type Obj = Record<string, unknown>

function className(v: unknown): string {
  return v && typeof v === 'object' ? ((v as { constructor?: { name?: string } }).constructor?.name ?? '') : ''
}

function instructionErrorJson(e: unknown): unknown {
  if (typeof e === 'number') return INSTRUCTION_ERRORS[e] ?? `InstructionError${e}`
  if (e && typeof e === 'object') {
    if ('code' in e && typeof (e as { code: unknown }).code === 'number') return { Custom: (e as { code: number }).code }
    if ('msg' in e) return { BorshIoError: String((e as { msg: unknown }).msg) }
  }
  return 'GenericError'
}

/** litesvm `FailedTransactionMetadata.err()` → RPC JSON. */
export function transactionErrorJson(err: unknown): TransactionErrorJson {
  if (typeof err === 'number') return TRANSACTION_ERRORS[err] ?? `TransactionError${err}`
  if (!err || typeof err !== 'object') return String(err)
  const name = className(err)
  const o = err as Obj
  if (typeof o.err === 'function' && typeof o.index === 'number') {
    return { InstructionError: [o.index, instructionErrorJson((o.err as () => unknown).call(err))] }
  }
  if (name.includes('InsufficientFundsForRent')) return { InsufficientFundsForRent: { account_index: Number(o.accountIndex) } }
  if (name.includes('ProgramExecutionTemporarilyRestricted')) {
    return { ProgramExecutionTemporarilyRestricted: { account_index: Number(o.accountIndex) } }
  }
  if (name.includes('DuplicateInstruction')) return { DuplicateInstruction: Number(o.index) }
  return String(err)
}

const TRANSACTION_ERROR_TEXT: Record<string, string> = {
  AccountInUse: 'Account in use',
  AccountLoadedTwice: 'Account loaded twice',
  AccountNotFound: 'Attempt to debit an account but found no record of a prior credit.',
  ProgramAccountNotFound: 'Attempt to load a program that does not exist',
  InsufficientFundsForFee: 'Insufficient funds for fee',
  InvalidAccountForFee: 'This account may not be used to pay transaction fees',
  AlreadyProcessed: 'This transaction has already been processed',
  BlockhashNotFound: 'Blockhash not found',
  SignatureFailure: 'Transaction did not pass signature verification',
  SanitizeFailure: 'Transaction failed to sanitize accounts offsets correctly',
}

const INSTRUCTION_ERROR_TEXT: Record<string, string> = {
  GenericError: 'generic instruction error',
  InvalidArgument: 'invalid program argument',
  InvalidInstructionData: 'invalid instruction data',
  InvalidAccountData: 'invalid account data for instruction',
  AccountDataTooSmall: 'account data too small for instruction',
  InsufficientFunds: 'insufficient funds for instruction',
  IncorrectProgramId: 'incorrect program id for instruction',
  MissingRequiredSignature: 'missing required signature for instruction',
  UninitializedAccount: 'instruction requires an initialized account',
  ComputationalBudgetExceeded: 'Computational budget exceeded',
  InvalidAccountOwner: 'Invalid account owner',
  ProgramFailedToComplete: 'Program failed to complete',
}

/** Agave's `Display` for a TransactionError (the text after "Transaction simulation failed: "). */
export function transactionErrorText(err: TransactionErrorJson): string {
  if (typeof err === 'string') return TRANSACTION_ERROR_TEXT[err] ?? err
  if ('InstructionError' in err && Array.isArray(err.InstructionError)) {
    const [index, detail] = err.InstructionError as [number, unknown]
    let text: string
    if (detail && typeof detail === 'object' && 'Custom' in detail) {
      text = `custom program error: 0x${Number((detail as { Custom: number }).Custom).toString(16)}`
    } else if (detail && typeof detail === 'object' && 'BorshIoError' in detail) {
      text = `Failed to serialize or deserialize account data: ${String((detail as { BorshIoError: unknown }).BorshIoError)}`
    } else {
      text = INSTRUCTION_ERROR_TEXT[String(detail)] ?? String(detail)
    }
    return `Error processing Instruction ${index}: ${text}`
  }
  if ('InsufficientFundsForRent' in err) {
    const index = (err.InsufficientFundsForRent as { account_index?: unknown })?.account_index
    return `Transaction results in an account (${String(index)}) with insufficient funds for rent`
  }
  return JSON.stringify(err)
}

/**
 * Errors that stop a transaction before it is executed: the leader drops it,
 * no fee is charged and it never appears in history.
 */
export function isLoadError(err: TransactionErrorJson): boolean {
  return (
    typeof err === 'string' &&
    [
      'AccountNotFound',
      'InsufficientFundsForFee',
      'InvalidAccountForFee',
      'AlreadyProcessed',
      'BlockhashNotFound',
      'SignatureFailure',
      'SanitizeFailure',
      'MissingSignatureForFee',
      'AccountLoadedTwice',
      'TooManyAccountLocks',
      'UnsupportedVersion',
    ].includes(err)
  )
}

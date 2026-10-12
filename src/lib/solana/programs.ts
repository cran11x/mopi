import { PublicKey } from '@solana/web3.js'
import type { TokenProgramKind } from '../types'

export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
export const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')

export function programKind(programId: string): TokenProgramKind | null {
  if (programId === TOKEN_PROGRAM_ID.toBase58()) return 'spl-token'
  if (programId === TOKEN_2022_PROGRAM_ID.toBase58()) return 'token-2022'
  return null
}

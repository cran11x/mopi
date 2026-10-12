// Must be imported before anything from @solana/*. web3.js relies on Node's Buffer.
import { Buffer } from 'buffer'

const g = globalThis as typeof globalThis & { Buffer?: typeof Buffer }
if (!g.Buffer) g.Buffer = Buffer

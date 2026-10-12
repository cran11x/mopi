# mopi · $MOPI

**A tiny cleaner for your Solana wallet.** mopi finds supported token accounts that hold 0 tokens, shows every fee up front, and prepares a cleanup that you approve in your own wallet. Closing an empty token account returns the SOL locked in it (its rent deposit, called "account SOL" in the UI) to your wallet.

> Clean up. Get your SOL back.

## How it works

1. **Scan.** mopi reads public account data for any address (`getTokenAccountsByOwner` for SPL Token and Token-2022). It signs nothing and needs no wallet.
2. **Review.** Accounts are grouped as **eligible** (0 tokens, closable by you), **with tokens** (never touched), or **unsupported** (empty, but blocked from closing: frozen, another address holds close authority, withheld Token-2022 transfer fees, unsupported extensions). You choose which eligible accounts to close and see the account SOL, the estimated network fee, the service fee and the estimated return.
3. **Approve in your wallet.** mopi builds one transaction per batch of up to 20 accounts. Every transaction is checked against a strict allowlist before signing, and again after your wallet signs it. It is also simulated, and only transactions that pass simulation are sent.

### What a mopi transaction can contain

- `ComputeBudget` set-limit and set-price instructions
- `CloseAccount` (SPL Token / Token-2022) for accounts you selected. **The destination and the authority are always your wallet.**
- At most one `SystemProgram.transfer` for exactly the service fee shown, to the configured fee wallet

Nothing else: no token transfers, approvals or delegations, and no extra signers. These rules are enforced in code by `assertSafeCleanupTransaction` (`src/lib/solana/transactions.ts`) and covered by tests.

## $MOPI holder access (planned utility)

- **Lower service fee:** 4% → 2% of returned account SOL (configurable)
- **Saved wallet watchlists:** save wallets and rescan them in one tap

Holder perks turn on automatically once `VITE_MOPI_MINT` is set. Until then the UI shows them as planned. $MOPI is a utility token for mopi features. Nothing here is financial advice, and no returns are promised.

## Development

```bash
npm install
cp .env.example .env.local   # optional — see below
npm run dev                  # http://localhost:5173
npm test                     # unit tests (vitest)
npm run typecheck
npm run build                # static site in dist/
npm run e2e                  # Playwright (RPC is mocked)
```

The app is a static SPA with hash routes, so it can be hosted anywhere. `vercel.json` ships strict security headers (CSP, no framing).

### Configuration

Everything is public and baked into the client bundle at build time.

| Variable | Default | Purpose |
| --- | --- | --- |
| `VITE_SOLANA_RPC_URL` | public mainnet endpoint | Mainnet RPC. The public endpoint is heavily rate limited, so use your own provider in production. |
| `VITE_SOLANA_DEVNET_RPC_URL` | public devnet endpoint | Devnet RPC |
| `VITE_FEE_WALLET` | _(empty)_ | Service fee recipient. **Empty means no service fee** and no transfer instruction. Must be an existing, funded system account. A transfer below the rent-exempt minimum to a brand-new address fails. |
| `VITE_SERVICE_FEE_BPS` | `400` | Service fee in basis points of returned account SOL (capped at 1000) |
| `VITE_HOLDER_FEE_BPS` | `200` | Service fee for $MOPI holders |
| `VITE_MOPI_MINT` | _(empty)_ | $MOPI mint. Enables the holder check. |
| `VITE_MOPI_HOLDER_MIN` | `100000` | Whole $MOPI tokens required for holder access |

## Project layout

```
src/
  config.ts              env-driven configuration
  lib/
    types.ts             shared domain types
    format.ts            SOL / address formatting (integer math)
    demo.ts              deterministic demo wallet
    router.ts            tiny hash router
    solana/
      classify.ts        jsonParsed token account → eligible | has-tokens | unsupported
      scan.ts            read-only wallet scan (SPL Token + Token-2022)
      fees.ts            batching + fee quote (drives UI and tx builder)
      transactions.ts    CloseAccount instructions, v0 transactions, safety assertions
      execute.ts         verify → simulate → sign → verify → send → confirm
      holder.ts          $MOPI holder check
  state/                 React providers (cluster, wallet, cleaner state, watchlist)
  components/            UI (ui primitives, layout, home, review, mascot)
  pages/                 Clean wallet, How it works, Fees, Docs, Benefits, Wallets
  assets/mascot/         mopi mascot art (SVG)
```

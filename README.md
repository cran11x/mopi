# mopi · $MOPI

**A tiny cleaner for your Solana wallet.** mopi finds supported token accounts that hold 0 tokens, shows every fee up front, and prepares a cleanup that you approve in your own wallet. Closing an empty token account returns the SOL locked in it (its rent deposit, called "account SOL" in the UI) to your wallet.

> Clean up. Get your SOL back.

## How it works

1. **Scan.** mopi reads public account data for any address (`getTokenAccountsByOwner` for SPL Token and Token-2022). It signs nothing and needs no wallet.
2. **Review.** Accounts are grouped as **eligible** (0 tokens, closable by you), **with tokens** (never touched), or **unsupported** (empty, but blocked from closing: frozen, another address holds close authority, withheld Token-2022 transfer fees, unsupported extensions). You choose which eligible accounts to close and see the account SOL, the estimated network fee, the service fee and the estimated return.
3. **Approve in your wallet.** mopi builds one transaction per batch of up to 20 accounts. Every transaction is checked against a strict allowlist before signing, and again after your wallet signs it. It is also simulated, and only transactions that pass simulation are sent.
4. **Confirm.** mopi watches the signatures over plain HTTP (`getSignatureStatuses`, no websocket needed) and, while a transaction is not yet seen, re-sends the **exact same verified bytes** until it lands or its blockhash expires. If the RPC endpoint fails, the identical request goes to a fallback endpoint.

### What a mopi transaction can contain

- `ComputeBudget` set-limit and set-price instructions
- `CloseAccount` (SPL Token / Token-2022) for accounts you selected. **The destination and the authority are always your wallet.**
- At most one `SystemProgram.transfer` for exactly the service fee shown, to the configured fee wallet

Nothing else: no token transfers, approvals or delegations, and no extra signers. These rules are enforced in code by `assertSafeCleanupTransaction` (`src/lib/solana/transactions.ts`) and covered by tests.

## $MOPI holder access (planned utility)

- **Lower service fee:** 4% → 2% of returned account SOL (configurable)
- **Saved wallet watchlists:** save wallets and rescan them in one tap

Holder perks apply once the operator sets `VITE_MOPI_MINT` and rebuilds. Until then the UI shows them as planned. $MOPI is a utility token for mopi features. Nothing here is financial advice, and no returns are promised.

## Development

```bash
npm install
cp .env.example .env.local   # optional — see below
npm run dev                  # http://localhost:5173
npm test                     # unit + on-chain integration tests (vitest)
npm run typecheck
npm run build                # static site in dist/
npm run e2e                  # Playwright against the production build
```

The app is a static SPA with hash routes, so it can be hosted anywhere. `vercel.json` ships strict security headers (CSP, no framing).

### Testing

- **Unit tests** (`src/**/*.test.ts`, vitest): classification, fee math, transaction building and the safety allowlist (`assertSafeCleanupTransaction`), the execute pipeline (simulate → sign → re-verify the signed bytes → send → poll/rebroadcast → confirm), RPC failover, the priority-fee estimate and the cleaner state.
- **On-chain integration tests** (`src/lib/solana/onchain.test.ts`): mopi's real code runs against [LiteSVM](https://github.com/LiteSVM/litesvm), an in-process Solana runtime with the real SPL Token, Token-2022, ATA and System programs. A real web3.js `Connection` talks to the chain through `src/test/litesvm/` (an RPC adapter answering every method mopi uses, in mainnet's response shapes), and the wallet signs with a real key. The tests check that the network fee, the service fee and the amount returned to the owner match the quote to the lamport, that skipped accounts stay byte-for-byte untouched, and the failure paths (tokens arriving mid-flow, expired blockhashes, dropped sends, lost replies, lagging nodes, unfunded fee wallet, near-empty wallets). `@solana/spl-token` and `litesvm` are dev dependencies used only by tests; the app bundle never imports them.
- **E2E** (`e2e/`, Playwright, desktop 1440 px and phone 375 px): builds the app and serves it on port 4173. Most specs mock the RPC with `page.route` (primary and the default fallback endpoint, so nothing reaches the real network) and use a fake Wallet Standard wallet. `e2e/onchain.spec.ts` runs the unmodified production build against a LiteSVM chain in node, signs with a real key, and reads the chain state afterwards. Install the browser once with `npx playwright install chromium`, or point `PLAYWRIGHT_CHROMIUM_PATH` at an existing Chromium. Setting `VITE_FEE_WALLET` when running the suite also exercises the fee-transfer path.

LiteSVM ships prebuilt native binaries as optional dependencies (`litesvm-linux-x64-gnu`, `-darwin-arm64`, …); `npm ci` installs the one for your platform. CI runs all of the above on `ubuntu-latest` (`.github/workflows/ci.yml`).

### Configuration

Everything is public and baked into the client bundle at build time: change a value, then rebuild and redeploy.

| Variable | Default | Purpose |
| --- | --- | --- |
| `VITE_SOLANA_RPC_URL` | public mainnet endpoint | Mainnet RPC (HTTPS, must allow CORS from your domain; no websocket needed). The public endpoint is heavily rate limited, so use your own provider in production. |
| `VITE_SOLANA_DEVNET_RPC_URL` | public devnet endpoint | Devnet RPC |
| `VITE_SOLANA_RPC_FALLBACKS` | `https://solana-rpc.publicnode.com` only while `VITE_SOLANA_RPC_URL` is unset, else none | Comma-separated https mainnet endpoints tried after the primary fails (network error, 15 s timeout, HTTP 401/402/403/404/408/410/429/5xx). The endpoint that answered is preferred for 60 s. `none` disables. Same cluster only. |
| `VITE_SOLANA_DEVNET_RPC_FALLBACKS` | _(none)_ | Same, for devnet |
| `VITE_FEE_WALLET` | _(empty)_ | Service fee recipient. **Empty means no service fee** and no transfer instruction. Must be an existing system account holding at least 0.00089088 SOL: a transfer that leaves a brand-new account below the rent-exempt minimum fails, so mopi checks its balance when a review opens and blocks approval until it is funded. |
| `VITE_SERVICE_FEE_BPS` | `400` | Service fee in basis points of returned account SOL (capped at 1000) |
| `VITE_HOLDER_FEE_BPS` | `200` | Service fee for $MOPI holders |
| `VITE_MOPI_MINT` | _(empty)_ | $MOPI mint. Enables the holder check and shows the contract address (copy + Solscan) in the footer, the home holder banner and the Benefits page. |
| `VITE_MOPI_HOLDER_MIN` | `100000` | Whole $MOPI tokens required for holder access |
| `VITE_X_URL` | `https://x.com/MopiClean` | Official X profile, `https://` only, shown in the header, mobile menu and footer. |
| `VITE_TELEGRAM_URL` | _(empty)_ | Official Telegram link, `https://` only. Empty (or invalid) hides the link. |
| `VITE_SITE_URL` | _(empty)_ | Public origin, e.g. `https://mopi.example`. Adds the canonical link, `og:url` and the absolute `og:image` share preview at build time. |

**Priority fee** (not an env var, `src/config.ts`): real cleanups estimate the price from `getRecentPrioritizationFees` (75th percentile of non-zero recent fees for the accounts involved) and clamp it to `priorityFeeMicroLamports` (20,000) … `maxPriorityFeeMicroLamports` (1,000,000) micro-lamports per compute unit. Any error or a 5 s timeout falls back to the floor. Independently of the config, the final safety check refuses any price above 1,000,000. If the estimate rises by more than 10% between review and approval, the new amounts are shown and must be approved again.

## Launch checklist

1. **Own RPC.** Set `VITE_SOLANA_RPC_URL` to a paid provider endpoint that allows CORS from your domain. Optionally list a second provider in `VITE_SOLANA_RPC_FALLBACKS` (same cluster); otherwise there is no fallback once you set your own primary. The free public endpoint (`api.mainnet-beta.solana.com`) answers many website requests with **403 Access forbidden**, especially the Token-2022 query, so don't launch on it. Visitors can also paste their own endpoint under **network menu → Custom RPC…** (stored only in their browser), and a scan where one token program is refused still shows the other program's accounts with a "Partial scan" warning.
2. **Funded fee wallet.** Set `VITE_FEE_WALLET` to a wallet you control and send it at least 0.001 SOL **before** launch. Without that, mopi blocks every approval with a "fee wallet unfunded" warning.
3. **Domain.** Point your domain at the static host, set `VITE_SITE_URL=https://your.domain` (canonical link and share image), and keep the `vercel.json` security headers (or their equivalent on another host).
4. **Socials.** The X link defaults to https://x.com/MopiClean; set `VITE_TELEGRAM_URL` if you have one, then rebuild and redeploy.
5. **After the token launches:** set `VITE_MOPI_MINT` to the real mint, check `VITE_MOPI_HOLDER_MIN`, then rebuild and **redeploy**. The CA appears on the site only after the redeploy; double-check it against the mint on Solscan.
6. **Wallet reputation.** Submit the domain for review so wallets don't flag it as unknown: Phantom (its domain review / allowlist request form) and Blowfish (the transaction-scanning service used by Phantom and other wallets). Expect a few days of lead time.
7. **Smoke test on mainnet** with a small wallet: scan, review, approve one batch, and check on Solscan that the fee transfer and the returned SOL match the review.

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
      execute.ts         verify → simulate → sign → verify → send → poll/rebroadcast → confirm
      rpc.ts             fetch with per-request timeout and endpoint failover
      priority.ts        recent priority-fee estimate (clamped, never throws)
      walletErrors.ts    plain-language wallet / Ledger error messages
      holder.ts          $MOPI holder check
  socials.ts             https-only X / Telegram links and the Solscan CA link
  test/litesvm/          LiteSVM chain behind a real web3.js Connection (tests only)
  state/                 React providers (cluster, wallet, cleaner state, watchlist)
  components/            UI (ui primitives, layout, home, review, mascot)
  pages/                 Clean wallet, How it works, Fees, Docs, Benefits, Wallets
  assets/mascot/         mopi mascot art (SVG)
e2e/                     Playwright specs (mocked RPC + fake wallet; onchain.spec.ts on LiteSVM)
```

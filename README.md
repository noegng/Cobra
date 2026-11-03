# Cobrá

Cobrá is a checkout for Latin American merchants on **Celo mainnet (42220)**. The merchant (on Telegram) types
"cobrar 4500 pizza" and gets a QR code and a payment link. The payer opens the link, **signs once** with whatever
stablecoins they hold (USDC, USDT, USAT, other wFIAT), and a relayer submits the transaction. An immutable router swaps
through Uniswap V3 and pays the merchant an **exact wFIAT amount** (for example wARS or wBRL). The payer never needs
CELO for gas. The router has no owner, no fees and no upgrade path, and the relayer cannot redirect funds.

## Architecture

```
 Merchant (Telegram) --> bot (grammY + LLM agent, deterministic amount parser) --> invoices (Postgres)
                                                                                      |
 payer page /pay/[id] --> web API (Vercel, no keys) --> quotes --> submissions queue (pending)
   (signs 1 per leg)        solver.solve(): legs, paths, split        |
                                                                      v
                                           worker (VPS): relayer (only signer; simulate, ERC-8021 tag)
                                                                      |
                                                                      v
                        CobraRouter.pay(invoice, payer, legs) --> Uniswap V3 (SwapRouter02) --> merchant gets exact wFIAT
                                                                      |                          surplus refunded to payer
                                                                      v
                           worker: indexer (Paid log, N confirmations) --> payments row, invoice paid --> bot notifies merchant
```

Full flow and data contracts: `docs/interfaces.md` §4. Invoice status machine: `packages/shared/src/invoice-state.ts`.

## How every signature is bound to the invoice

Spec: `docs/interfaces.md` §3, code in `packages/shared/src/eip712.ts`, Solidity in `contracts/src/CobraRouter.sol`.

- The payer signs a `PaymentIntent` (EIP-712): the `Invoice` (id, merchant, tokenOut, amountOut, deadline), the payer,
  and for each leg the token, `amountIn`, pull kind and `keccak256(path)`.
- **EIP-3009 legs** (USDC, USDT, USAT): the token's `receiveWithAuthorization` has `to = router` and
  `nonce = keccak256(abi.encode(intentDigest, legIndex))`, recomputed on-chain by the router. The token only accepts it
  from the router, and only for that exact intent.
- **Permit2 legs** (wFIAT and other tokens without EIP-3009): `permitWitnessTransferFrom` with `spender = router` and the
  `PaymentIntent` as witness.
- **Allowance legs**: the payer sends the transaction themselves.
- Result: the relayer can submit the exact intent or nothing. Changing the merchant, amount, token, path or split
  invalidates the signature. The router checks the aggregate output (`InsufficientOutput`) and `isPaid` is keyed by the
  invoice struct hash, so replay and front-running pay once. Solidity and TypeScript are tied together by
  `contracts/test/vectors/eip712.json`. Self-review: `contracts/SECURITY.md` (not an audit).

## Celo stack used

| Piece | Use |
| --- | --- |
| wARS, wBRL (Ripio LatamStable; also wMXN, wCOP, wCLP, wPEN in the registry) | Settlement currency paid to the merchant, 1:1 with the local currency |
| EIP-3009 | Gasless pulls from USDC, USDT, USAT |
| Permit2 | Gasless pulls (witness transfer) from wFIAT, which have `permit` but not EIP-3009 |
| Uniswap V3 (SwapRouter02, QuoterV2) | Swaps and quotes; the solver splits a payment across up to 3 legs |
| ERC-8004 | On-chain agent identity for the relayer wallet (`scripts/agent/register.ts`) |
| ERC-8021 | Attribution tag `celo_502e1bea2794` appended to every `pay` call and to the router deployment |
| Fee abstraction | ALLOWANCE-mode payer gas paid in a stable through the fee-currency adapter |

Verified addresses and token capabilities: `docs/research/onchain-verification.md`.

## Repo map

| Path | Role |
| --- | --- |
| `contracts/` | `CobraRouter.sol`, Foundry tests (unit, invariants, mainnet fork), `SECURITY.md` |
| `packages/shared` | Types, token registry, router ABI, EIP-712 scheme, path codec, invoice state machine |
| `packages/db` | Drizzle schema, migrations, queries, PGlite test helper |
| `packages/solver` | `solve()` routing and splitting, Uniswap quoter, FX reference rates |
| `packages/relayer` | Queue consumer, guarded signer (whitelist, caps, kill switch), ERC-8004 and deploy CLIs |
| `packages/indexer` | `Paid` log indexer, reconciliation, expiry, notification outbox |
| `packages/bot` | Telegram bot, LLM agent, amount parser, reminders, daily close |
| `apps/web` | Next.js: payer page, merchant dashboard, API routes, Telegram webhook |
| `apps/worker` | VPS process: relayer, indexer, expiry, reminders (systemd unit in `apps/worker/deploy`) |
| `scripts/agent` | Human-run CLIs: `deploy-router.ts`, `register.ts` |
| `docs/` | `interfaces.md` (frozen contracts), research, night reports in `docs/reports/` |

## Tests

```sh
export PATH="/opt/homebrew/opt/node@24/bin:$HOME/.foundry/bin:$PATH"
pnpm install
pnpm test          # all TS packages (vitest, PGlite, anvil for some suites)
pnpm typecheck
cd contracts && CELO_RPC_URL=https://forno.celo.org forge test   # fork tests skip if the RPC is unreachable
```

Tests need no secrets and never broadcast.

## Deployment runbook (human only)

Step-by-step guide (French) with every environment variable and a check after each step: [docs/DEPLOY.md](docs/DEPLOY.md). Read-only post-deployment checks: `pnpm verify:deploy --env .env.verify`.

Agents never broadcast. Mainnet transactions are sent by the human.

1. Build the contract: `(cd contracts && forge build)`.
2. Deploy the router with the ERC-8021 tag. `forge script --broadcast` cannot add the suffix, so use:
   `pnpm exec tsx scripts/agent/deploy-router.ts` (dry run, prints the calldata), then
   `RELAYER_PRIVATE_KEY=... RPC_URL=... pnpm exec tsx scripts/agent/deploy-router.ts --execute`.
   Record the address and the deploy block.
3. Register the agent (ERC-8004): `pnpm exec tsx scripts/agent/register.ts --base-url https://<host> --write` for the
   dry run and the card, then `--execute` with `RELAYER_PRIVATE_KEY`, `RPC_URL`, `ATTRIBUTION_CODE` set.
4. Web on Vercel (root `apps/web`): set `DATABASE_URL`, `RPC_URL`, `ROUTER_ADDRESS`, `ROUTER_DEPLOY_BLOCK`,
   `PUBLIC_BASE_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`, `DASHBOARD_SECRET`,
   `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`, `NEXT_PUBLIC_ATTRIBUTION_CODE=celo_502e1bea2794` (see `.env.example`).
   No private key on Vercel. Point the Telegram webhook at `/api/telegram` with the same secret.
5. Worker on the VPS: follow `apps/worker/README.md` (systemd unit `cobra-worker.service`, env file at
   `/etc/cobra/worker.env` is the only place `RELAYER_PRIVATE_KEY` exists). Fund the relayer wallet with CELO.
   Emergency stop: `KILL_SWITCH=true` or the DB flag `kill_switch`.

### Deployed addresses and proof transactions

| Item | Value |
| --- | --- |
| CobraRouter | [`0xfe38683105fa36ee664acefe7e714ba93492e458`](https://celoscan.io/address/0xfe38683105fa36ee664acefe7e714ba93492e458) |
| Router deploy tx | [`0x06edbc66…6cd892148`](https://celoscan.io/tx/0x06edbc66bfd5312620541da2327387eb8b198a0f0c6a40a80c799ca6cd892148) (ERC-8021 tag `celo_502e1bea2794`) |
| Deploy block | 81818614 |
| Relayer / agent wallet | [`0x9E828B877EFCdb79B507fF6234d841A8265Cccd5`](https://celoscan.io/address/0x9E828B877EFCdb79B507fF6234d841A8265Cccd5) |
| ERC-8004 agent id and registration tx | `10033` on IdentityRegistry `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, tx [`0xe02818c2…4de85811`](https://celoscan.io/tx/0xe02818c2fa247cb0e70790b82bb372f28c5afb20ca7138dcb6841fc74de85811) |
| Proof payment: wARS | TBD |
| Proof payment: wBRL | TBD |
| Proof payment: multi-leg split | TBD |
| Web URL | https://cobra-beige.vercel.app |
| Telegram bot | [@cobra_agent_telegram_bot](https://t.me/cobra_agent_telegram_bot) |

## Coverage and fees (measured)

Read-only measurements on Celo mainnet, 2026-11-03 (one pass; Plan 3). Data: `docs/research/plan3/coverage-matrix.json`,
report: `docs/research/plan3/fees-report.md`.

| Country | Token | Route | Total cost at 5 / 50 / 500 / 5000 USD | Status |
| --- | --- | --- | --- | --- |
| Argentina | wARS | USD₮ → wARS (Uniswap V3, 0.01%) | 0.19 / 0.08 / 0.09 / 0.36 % | Supported |
| Argentina | wARS | USDC → USD₮ → wARS | 0.23 / 0.09 / 0.10 / 0.38 % | Supported |
| Brazil | wBRL | USD₮ → wBRL | 3.40 / 3.30 / 3.40 % / refused above 500 USD | Limited (price ~3.3% above market) |
| Mexico, Colombia, Chile, Peru | wMXN, wCOP, wCLP, wPEN | none | no pool | Coming soon |

Total cost = relayer gas (about 0.007 USD per payment, paid by Cobrá) + pool fee + price impact + deviation from the
reference rate (dólar cripto for ARS, AwesomeAPI for BRL). On-ramp and off-ramp costs are not included. wARS follows the
crypto dollar rate, not the official ARS rate. Liquidity can move: payments are capped and the solver refuses quotes
beyond its price guard.

## Known limitations

- **wBRL pool is one-sided**: the wBRL/USDT pool holds about 23 USDT against 147k wBRL and is priced 2.2 to 3.3% off
  market (3.26% vs AwesomeAPI on 2026-11-03), so Brazilian payments cost about 3.3 to 3.4% up to 500 USD and selling
  wBRL is impossible. The solver's price guard is 350 bps for BRL, which leaves only 0.1 to 0.2 point of margin.
- **MX, CO, CL, PE**: wMXN, wCOP, wCLP and wPEN have no liquid pool; the payer must hold the wFIAT and pay directly.
- **ALLOWANCE mode is not credited to the agent**: the payer sends the transaction, so the relayer does not appear as the
  submitter. It is also not tested on-chain.
- **Tokens sent to the router by mistake are stuck**: there is no sweep function by design.
- **Sponsored gas is declared**: the relayer pays gas in CELO for EIP-3009 and Permit2 payments; the merchant is not charged.
- Payers whose wallet is an EIP-7702-delegated EOA depend on the delegate accepting a raw ECDSA signature (ERC-1271).
- Mobile wallet support for `eth_signTypedData_v4` (MiniPay) is unverified.
- The router is an author self-review, not an audit; payments are capped (USD caps in the signer).

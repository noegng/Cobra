# Cobrá: project status (2026-11-05)

This file replaces the per-workstream build logs written between 2 and 5 November 2026. Those logs are still in the
git history (`git log -- docs/reports/`). Everything below was re-checked on 2026-11-05 against the current `main`
and against Celo mainnet (read-only RPC calls to `forno.celo.org`).

## 1. What is live on Celo mainnet

All transactions below have status `success`. All are sent by the agent wallet
`0x9E828B877EFCdb79B507fF6234d841A8265Cccd5`, and all carry the ERC-8021 attribution tag `celo_502e1bea2794` in
their calldata. The agent wallet's nonce is 8, which matches these 8 transactions exactly.

| # | What | Tx | Block |
|---|---|---|---|
| 1 | CobraRouter v1 deployment (`0xfe38…e458`) | [`0x06edbc66…`](https://celoscan.io/tx/0x06edbc66bfd5312620541da2327387eb8b198a0f0c6a40a80c799ca6cd892148) | 81818614 |
| 2 | ERC-8004 registration, agent id `10033` | [`0xe02818c2…`](https://celoscan.io/tx/0xe02818c2fa247cb0e70790b82bb372f28c5afb20ca7138dcb6841fc74de85811) | 81824144 |
| 3 | Payment: USD₮ → 100 wARS (EIP-3009, Uniswap V3) | [`0x7951aea4…`](https://celoscan.io/tx/0x7951aea4693affabca3250605dcb43ee8ecebe2597a9dd416a06aa58fe07ddc3) | 81840096 |
| 4 | Gas grant: 0.05 CELO to a payer holding 0 CELO | [`0x0052cc07…`](https://celoscan.io/tx/0x0052cc07e384c7cd8794b9f0514c298ea3a60719d862097d6d971bb02f2af0fe) | 81840839 |
| 5 | Payment: wARS → 1 000 wARS (Permit2, gasless) | [`0x66cc8e51…`](https://celoscan.io/tx/0x66cc8e5185076c10fd03cc0ce3e591e5e84395885ce6b67a7f42304352a2fb19) | 81841018 |
| 6 | CobraRouterV2 deployment (`0x5658…7069`, Uniswap V3 + Textile FX RFQ) | [`0x1210747d…`](https://celoscan.io/tx/0x1210747d76db666fd668e9c3606bdc871189142800cd2862c3fe758783202af1) | 81913649 |
| 7 | Payment: USD₮ → 100 wARS through router v2 | [`0xf6c4de47…`](https://celoscan.io/tx/0xf6c4de473e4f3a28559ed42c734cdfc63412e3fb1d53c689c1fb485f85b61528) | 81915079 |
| 8 | Payment: USD₮ → 8 wBRL, filled by a Textile FX quote (0.68 % total cost) | [`0xe7e62efe…`](https://celoscan.io/tx/0xe7e62efe850bcad1293c50b0cd5d8aa3d29bc028538db4466ce216095edfd6f1) | 81916439 |

- `IdentityRegistry.ownerOf(10033)` on `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` returns the agent wallet.
- In every payment, the merchant received exactly the invoiced wFIAT amount. Any surplus went back to the payer.
- Web app: https://cobra-beige.vercel.app. Its `/proof` page lists each payment with a Celoscan link, and the same
  agent journal is served as JSON at `/api/agent/journal`. Telegram bot: `@cobra_agent_telegram_bot`. The worker
  (relayer + indexer) runs on a VPS under systemd.
- The team ran these four payments to validate each payment path on mainnet: swap, same-token Permit2, router v2,
  and the Textile RFQ venue. The next step is onboarding pilot merchants.

## 2. Test suites (run on 2026-11-05)

| Suite | Result |
|---|---|
| `pnpm test` (TypeScript, vitest) | **584 passed**: bot 306, web 78, solver 66, relayer 66, indexer 38, shared 15, db 10, worker 5 |
| `forge test` (unit, vectors, ABI parity, invariants, fork tests against real Celo contracts) | **151 passed, 0 skipped** |
| `pnpm test:e2e` (anvil fork of mainnet, bot → API → relayer → router → indexer → Telegram) | **8 passed**, 1 `todo` (Textile flow; it is covered by the forge fork tests and by mainnet payment #8) |
| `pnpm typecheck` | green |

## 3. Security review: findings and status

The off-chain security review ran on 3 November. Every finding has since been fixed. The contract reviews (v1 and v2)
are in [`contracts/SECURITY.md`](../../contracts/SECURITY.md).

| Id | Finding | Fix |
|---|---|---|
| WS7-1 (medium) | Self-payments could use up the relayer's global daily budget | Self-payment is refused in the web API, in the relayer and in the signer. Per-merchant and per-payer 24 h caps were added |
| WS7-2 | A payer could revoke a signature after simulation and burn relayer gas | Rate limits per payer and per invoice. A payer is blocked after 3 reverted submissions in 30 min |
| WS7-3 | A submission that was never broadcast could be marked `failed` | A kill-switch refusal before signing puts the submission back in the queue |
| WS7-4 | No reconciliation after a reorg | `packages/indexer/src/reorg.ts` re-checks payment receipts for about 10 min and un-pays an invoice whose `Paid` log disappears. It needs 3 consecutive misses on a caught-up node before acting |
| WS7-5 | `KILL_SWITCH` was fail-open | The kill switch is now fail-closed: any non-empty value other than `false`, `0`, `off` or `no` turns it on |
| WS7-6 | A missing FX rate blocked payments in every currency | The USD value is stored at signing time and the 24 h totals are summed from the stored values |
| WS7-7 | A swap leg with `amountIn = 0` triggers SwapRouter02's "contract balance" mode | Zero amounts are refused in the solver, in `verify` and in the signer |

Other safeguards in place:
- The bot's LLM has no tool that moves funds. Amounts come from a deterministic parser.
- The signer is the only code path that holds the key. It signs only `pay()` calls to the configured router, plus the
  bounded gas grants and the ERC-8004 registration. It enforces the kill switch, the USD caps and the attribution tag.
- Payer signatures are verified off-chain, including for EIP-7702 delegated accounts (checked with ERC-1271 at submit time).
- Merchants can prove they own their payout wallet by signing a message (`/m/<slug>/verify`, no transaction).

## 4. Measurements

**Solver cost against the reference rate.** Recorded at block 81,746,717 on 2026-11-02 (ARS at the 1657.22 crypto
rate, BRL at 5.4376), in basis points (1 bp = 0.01 %). The 486 real quotes are replayed offline by
`packages/solver/test/replay.test.ts`.

| Scenario | 50 USD | 500 USD | 5 000 USD |
|---|---|---|---|
| wARS, payer holds USDC only (2 hops) | −2.8 | −0.1 | 27.0 |
| wARS, payer holds USD₮ only | 8.1 | 10.7 | 36.9 |
| wARS, USDC + USD₮ split | −2.8 | −0.1 | 16.8 (2 legs, 10.2 bps saved against the single-leg route) |
| wBRL, payer holds USDC only (Uniswap) | 212.9 | 224.9 | 346.2 |
| wBRL, USDC + USD₮ split (Uniswap) | 212.9 | 224.9 | 283.8 (2 legs, 62.4 bps saved) |
| wBRL, USD₮ through Textile FX RFQ (mainnet payment #8, 8 BRL) | 68 | not measured yet | not measured yet |

**Gas of `pay` on router v2** (fork against the real Textile reactor, execution gas): one Textile leg with an EIP-3009
pull costs 397 225; Textile plus one Uniswap leg costs 586 206.

## 5. Not yet done on mainnet (known limits)

These limits are also listed in the [README](../../README.md#known-limitations).

- **Multi-leg split payments.** They are covered by fork tests (`test_fork_twoLegs_usdc3009_usdtPermit2`,
  `test_fork_threeLegs_mixed_payerSends`) and by the e2e suite, but none has run on mainnet yet.
- **Fallback mode (the payer sends the transaction).** Built, but not run on mainnet.
- **Textile FX.** One filled payment so far, so costs at larger sizes are not measured yet. When no filler quotes,
  the payment falls back to the Uniswap pool at about 3.3 %, under a 350 bps price guard.
- **Ripio on-ramp and off-ramp.** These are prefilled public links. A full purchase (KYC, fees, limits) has not been
  tested end to end.
- **MiniPay.** Support for `eth_signTypedData_v4` is unverified.
- **Merchant conversion from wFIAT to USD₮ by the agent.** The contract supports it (`docs/decisions/E3-conversion-via-pay.md`,
  fork test). The off-chain flow is not built, because it needs a separate, capped budget.
- **Bank transfer / Pix.** At the analysis stage (`docs/research/b1-bank-transfer-pix.md`, `docs/backlog.md`).
- Web rate limits are kept in memory, per serverless instance.

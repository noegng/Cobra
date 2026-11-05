# Review follow-up (2026-11-05)

Follow-up to an external review of the bounty fit. Only items that code or docs can fix are done here; the rest needs a human.

## Fait

- **Payer receipt** (`apps/web/components/pay-page.tsx`, `apps/web/lib/units.ts`): new rows above "You pay": effective rate
  (`1 USD ≈ 1 659,09 ARS`, dollar legs only, bigint math, display only), cost vs. reference rate (`plan.costBps`, already in
  the quote, negatives shown as 0 %), network fee "free, paid by Cobrá" (hidden in payer-sent fallback mode). es/pt/en.
  Tests: `apps/web/test/units.test.ts`.
- **Payment-level proof** (`packages/relayer/src/payment-proof.ts`, CLI `pnpm verify:payments`): read-only, zero config,
  scans `Paid` logs of router v1 + v2 from their deploy blocks and checks each tx: success, `to` = router, `from` = agent
  (WARN if payer fallback), ERC-8021 code in calldata. Run on mainnet: **4 payments, 4 PASS, 1 distinct merchant wallet**.
  Tests: `packages/relayer/test/payment-proof.test.ts`.
- Removed the stale `docs/agent/registration.json` (`cobra.example` placeholders, no agentId). The served card is
  `apps/web/public/.well-known/agent-registration.json` and was already correct.
- `contracts/SECURITY.md` #12: blocklist wording clarified (wARS/wBRL contracts have an optional blocklist the issuer has
  not switched on; the router handles it if switched on). It was not wrong, just easy to misread.
- README: `pnpm verify:payments` in the proof section, with the honest "team-run, 1 merchant wallet" line; customer guide
  mentions the new rate / cost / fee rows. STATUS.md test counts updated.
- Checked, nothing to do: the 3-vs-4 payment count (the old WS11 report is gone, STATUS.md and README both say 4);
  x402 is not claimed anywhere (`x402Support: false`); README already leads with wARS/wBRL and marks MX/CO/CL/PE as
  direct payment only.

Tests: `pnpm test` all green (592), `pnpm typecheck` green. No contract change, no `forge test` needed.

## À relire

- The rate row is the effective rate including cost; the cost row is `plan.costBps` from the solver. Both are display only.
- Visual check of the receipt on a phone (four to five rows now).

## Bloqué (needs a human)

- Real merchants and payers: on-chain, all 4 payments go to one merchant wallet. Pilot onboarding (`docs/pilot/`).
- MiniPay `eth_signTypedData_v4` on a real device: verify or drop the claim.
- ERC-8004 beyond display (e.g. agentId in receipts) and x402: product decisions, not started.
- Merchant-savings figure for one named merchant: needs a real merchant's current fees.

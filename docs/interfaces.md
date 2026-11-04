# Cobrá — frozen interfaces (WS0, 2 Nov 2026)

Everything in this file is **frozen**. A workstream that needs to change it must say so in its night report
under "Interface changes" with the reason; the change is merged only after review.

## 1. Package map and ownership

| Path | Owner | Role |
| --- | --- | --- |
| `packages/shared` | WS0 | Types, token registry, router ABI, EIP-712 scheme, path codec, JSON codecs |
| `packages/db` | WS0 schema / WS6 queries | Drizzle schema + migrations, PGlite test helper |
| `contracts/` | WS1 | `CobraRouter.sol` implementing `ICobraRouter.sol` |
| `packages/solver` | WS2 | `solve()` + `createUniswapQuoter()` |
| `packages/relayer` | WS3 | Submission queue consumer, `signer` module, ERC-8004 / ERC-8021 |
| `apps/worker` | WS3 | VPS process wiring relayer, indexer, schedulers |
| `packages/bot` | WS4 | grammY bot, LLM agent + tools, amount parser, reminders, daily close, notifier |
| `apps/web` | WS5 | Next.js: `/pay/[id]`, `/pay/m/[slug]`, dashboard, API routes, Telegram webhook route |
| `packages/indexer` | WS6 | `Paid` log indexer, reconciliation, expiry |

Rule: edit only the paths you own. Need something from another package? Code against its frozen signature
(stub in `src/index.ts`) and use a local fake in your tests.

## 2. Router semantics (`contracts/src/ICobraRouter.sol`)

`pay(Invoice inv, address payer, Leg[] legs)`:

1. `block.timestamp <= inv.deadline` else `Expired()`. `1 <= legs.length <= 3` else `InvalidLegs()`.
2. `h = hashInvoice(inv)`; `isPaid[h]` else `AlreadyPaid()`; mark paid **before** external calls (CEI + `nonReentrant`).
3. `digest = intentDigest(inv, payer, legs)` (EIP-712, domain `{name:"Cobra Router", version:"1", chainId, verifyingContract: this}`).
4. For each leg `i`, pull `amountIn` of `token` from `payer` to the router:
   - `EIP3009`: `token.receiveWithAuthorization(payer, this, amountIn, validAfter, validBefore, legNonce(digest,i), v, r, s)`
     with `(validAfter, validBefore, v, r, s) = abi.decode(pullData)`.
   - `PERMIT2`: `PERMIT2.permitWitnessTransferFrom({ {token, amountIn}, nonce, deadline }, {to: this, requestedAmount: amountIn},
     payer, hashIntent(inv, payer, legs), PERMIT2_WITNESS_TYPE_STRING, signature)` with `(nonce, deadline, signature) = abi.decode(pullData)`.
   - `ALLOWANCE`: requires `msg.sender == payer` else `PayerMustBeSender()`; `safeTransferFrom(payer, this, amountIn)`.
   - Measure the **balance delta** (fee-on-transfer safe).
5. If `token == tokenOut`: `path` must be empty; the delta counts directly. Otherwise `path` must start with `token` and end with
   `tokenOut` (else `InvalidPath()`); approve the swap router for exactly the delta, `exactInput` with recipient = router,
   `amountOutMinimum = 0` (the aggregate check below protects the merchant; the signed `amountIn` protects the payer); reset approval.
6. `got = balanceOf(tokenOut) - balanceBefore`; `got >= amountOut` else `InsufficientOutput(got, amountOut)`.
7. Transfer exactly `amountOut` to `merchant`, the surplus `got - amountOut` to `payer`. Router balance of every touched token == balance before the call (0).
8. `emit Paid(inv.id, payer, inv.merchant, inv.tokenOut, inv.amountOut)`.

No owner, no upgrade, no fees, no pause. Constructor: `(address permit2, address swapRouter)` immutable.
`isPaid` is keyed by the invoice **struct hash** so nobody can burn someone else's `id` by front-running different terms;
the indexer therefore must check event fields against the DB invoice (§5).

## 3. Signing scheme (`packages/shared/src/eip712.ts`)

```
Invoice(bytes32 id,address merchant,address tokenOut,uint256 amountOut,uint256 deadline)
LegCommitment(address token,uint256 amountIn,uint8 kind,bytes32 pathHash)      // pathHash = keccak256(path)
PaymentIntent(Invoice invoice,address payer,LegCommitment[] legs)
legNonce(digest, i) = keccak256(abi.encode(bytes32 digest, uint256 i))
PERMIT2 witness type string = "PaymentIntent witness)" + Invoice + LegCommitment + PaymentIntent + TokenPermissions
```

- EIP-3009 legs: payer signs the **token's** `ReceiveWithAuthorization` with `to = router`, `nonce = legNonce(digest, i)`.
  `receiveWithAuthorization` requires `msg.sender == to`, so only the router can consume it, and only for that intent.
- Permit2 legs: payer signs `PermitWitnessTransferFrom` with `spender = router`, `witness = PaymentIntent`. Recommended
  nonce: `uint256(legNonce(digest, i))`.
- Allowance legs: payer sends the tx themselves (ERC-8021 suffix added by the page).
- Parity fixture: `contracts/test/vectors/eip712.json` (regenerate with `pnpm vectors`). The Solidity implementation
  must reproduce every hash in it.

Consequence: a relayer can only submit the exact intent or nothing — it cannot change merchant, amount, token, path or split.

## 4. Payment flow and data contracts

```
page ──GET  /api/invoices/:id──────────────▶ web API (Vercel, no keys)
page ──POST /api/invoices/:id/quote {payer}─▶ solver.solve() → quotes row → { quoteId, plan, invoice, toSign[] }
page ── wallet signs toSign[] (1 per leg) ──
page ──POST /api/invoices/:id/submit {quoteId, signatures[]}
          web API: quote not expired, invoice open, caps, recover every signature off-chain
          → INSERT submissions(status=pending, legs=SerializedLeg[])   (unique live submission per invoice)
worker/relayer (VPS) polls submissions: pending → sending → simulate → send pay (ERC-8021 tagged) → sent
          invoice open → submitted ; on revert/failure: submission failed, invoice back to open
worker/indexer: Paid log (N confirmations) → payments row, invoice paid, submission confirmed → notifier.invoicePaid
```

- JSON columns use `SerializedLeg` / `SerializedPlan` from `packages/shared/src/json.ts`.
- Amounts: base-unit integer strings on-chain side, decimal strings for local fiat. Never JS `number` for money.
- `invoices.amountOut` and `merchantAddress` are frozen at creation; the on-chain `Invoice` is rebuilt from the row:
  `{ id, merchant: merchantAddress, tokenOut, amountOut, deadline: floor(expiresAt/1000) }`.
- Status machine: `packages/shared/src/invoice-state.ts`. Transitions: `open -> submitted | expired | cancelled | paid`,
  `submitted -> paid | open`, `expired -> paid`. The last one exists because the router accepts payment up to the
  deadline (inclusive): a matching `Paid` event on a row the expiry job already moved to `expired` is an on-time
  payment and must be recorded as `paid`. `paid` and `cancelled` are terminal.
- Deployment: the router is deployed with `scripts/agent/deploy-router.ts` (dry run by default, `--execute` is human
  only) so the creation transaction carries the ERC-8021 suffix. `forge script --broadcast` cannot add it. The tag is
  `HACKATHON_ATTRIBUTION_CODE` (`celo_502e1bea2794`, `packages/shared/src/chain.ts`); the relayer appends the same tag
  to every `pay` call and the web page to ALLOWANCE transactions.

## 5. Indexer matching rule

A `Paid` log is applied to invoice `id` only if `merchant`, `tokenOut` and `amountOut` equal the DB row and the
invoice is `open` or `submitted`. Anything else → `unmatched_events` (never auto-applied). Writes are idempotent on
`payments.invoice_id`.

## 6. Environment

See `.env.example`. `RELAYER_PRIVATE_KEY` exists only on the VPS. Tests never need secrets: use PGlite
(`@cobra/db/testing`), fake `QuoteSource`, anvil / fork with public RPC.

## 7. CobraRouter v2: Textile FX RFQ venue (added 2026-11-04, additive)

Goal: settle a leg at Textile FX RFQ prices (UniswapX `LimitOrderReactor` operated by Textile, Celo
`0xa9aa0a64769cbed4d3b1ceb4df01cde915c235b3`) while keeping the payment atomic and non-custodial.

- **Same ABI and signing scheme as v1.** `CobraRouterV2` implements the frozen `ICobraRouter` unchanged (same `pay`,
  `Leg`, `Invoice`, `Paid`, EIP-712 types; domain name "Cobra Router", version "1", separated from v1 by
  `verifyingContract`). It adds `ICobraRouterV2 is ICobraRouter { function TEXTILE_REACTOR() external view returns (address); }`
  and implements UniswapX `IReactorCallback.reactorCallback`.
- **Venue selection is by `leg.path` content only** (codec: `packages/shared/src/textile-venue.ts`):
  - empty → `token == tokenOut`, no swap (as v1);
  - starts with `TXF1` (`0x54584631`) → Textile leg: `path = magic ++ abi.encode((bytes order, bytes sig)[])`;
  - otherwise → Uniswap V3 path (as v1).
  The payer signs `keccak256(path)` in `LegCommitment.pathHash`, so the Textile orders are bound to the intent.
- **Textile leg execution** (inside `pay`, after the pull): approve the reactor for exactly `leg.amountIn` of `leg.token`,
  call `executeBatchWithCallback(orders, "")`; the reactor transfers each maker's input (`inv.tokenOut`) to the router
  and pulls the maker outputs + protocol fee (`leg.token`) from the router; `reactorCallback` only accepts
  `msg.sender == TEXTILE_REACTOR` during an active `pay` and does nothing else; reset the approval to 0; any unspent
  `leg.token` is refunded to the payer. Each order must have `input.token == inv.tokenOut` and only `leg.token` outputs.
  Then the v1 aggregate check (`InsufficientOutput`) and exact payment to the merchant apply unchanged.
- **Quotes**: requested server-side with the partner (aggregator) API key `TEXTILE_API_KEY`, `taker = router v2`,
  exact output `buyAmount = invoice.amountOut`; `leg.amountIn = quote.takerPays`. Firm quotes live 120 s on most
  corridors. v2 scope: a Textile leg is a single hop `leg.token → inv.tokenOut`; multi-hop and mixed splits stay Uniswap.
- Deployment and `ROUTER_ADDRESS` switch are human-only, like v1. v1 stays on-chain (immutable); indexer and `/proof`
  follow both routers.

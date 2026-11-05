# CobraRouter: security self-review (WS1, 2 Nov 2026)

Scope: `src/CobraRouter.sol`, `src/libraries/SafeTransfer.sol`, `src/interfaces/*`. Spec: `docs/interfaces.md` §2–§3.
This is an author self-review. It is **not** an audit.

## Design summary

- The router is immutable and ownerless. It has no fees, no pause, no `receive` and no `fallback`. It holds no funds
  between calls, and has no sweep function.
- Constructor arguments: `PERMIT2` and `SWAP_ROUTER` (Uniswap **SwapRouter02**: its `exactInput` takes no deadline).
- The payer signs once. Every pull is bound to the full `PaymentIntent`, which covers the invoice, the payer, and each
  leg's token, amountIn, kind and keccak(path). Binding per pull kind:
  - EIP-3009: the nonce is `keccak256(abi.encode(intentDigest, i))`. The router recomputes it on-chain.
  - Permit2: `permitWitnessTransferFrom` with `witness = hashStruct(PaymentIntent)`.
  - Allowance: requires `msg.sender == payer`.
- Checks run in this order: deadline, leg count, `isPaid[hashInvoice]` (set before any external call), path validation
  per leg, pull, swap, aggregate output check, merchant payout, payer refund, then the event.

## Checklist

| # | Risk | Mitigation | Tests |
|---|------|-----------|-------|
| 1 | **Reentrancy** | `nonReentrant` with a transient-storage lock (EIP-1153). I checked that Celo mainnet executes TSTORE/TLOAD with `cast call --create 0x602a60005d60005c…` on forno, which returned `0x2a`. `isPaid` is set before the first external call (CEI). | `test_reentrancy_blocked` (a malicious token re-enters `pay` for another invoice and gets `REENTRANCY`), `test_reentrancy_sameInvoice_blocked`, `test_guardReleased_afterCall` |
| 2 | **Approvals** | The router never approves anything except `SWAP_ROUTER`. It approves exactly the measured delta of the leg token, calls `exactInput` and resets the approval to 0. Approving from 0 also covers USDT-style "approve-from-zero" tokens. Payers' standing allowances to the router can only be spent when `msg.sender == payer`. | `_assertRouterEmpty` (allowance == 0) in every happy path, `invariant_routerHoldsNothing`, `test_revert_allowance_nonPayerSender`, `test_tamper_kind` |
| 3 | **Signature binding / relayer tampering** | Covered fields: invoice id, merchant, tokenOut, amountOut, deadline; payer; and per leg token, amountIn, kind, path and order. Changing any of them changes `intentDigest` and `hashIntent`, so the EIP-3009 nonce or the Permit2 witness no longer matches. `pullData` is not hashed, but it is itself covered by the token or Permit2 signature. | `test_tamper_*` (merchant, amountOut, id/deadline, tokenOut, amountIn ±1, path fee/extra hop, leg token, leg order, dropped leg, payer, kind, swapped pullData) against EIP-3009 and Permit2 mocks; `test_fork_tamperedMerchant_realTokensReject` against the real USDT (`TetherToken: invalid signature`) and the real Permit2 (`InvalidSigner()`); `test_cases` in Vectors.t.sol (TS parity) |
| 4 | **Replay** | `isPaid[hashInvoice(inv)]`. Token nonces are single-use (EIP-3009 `authorizationState`, Permit2 unordered bitmap). The domain includes `chainId` and `verifyingContract`, so a signature is not valid on another chain or router. The Permit2 witness carries no router address, but Permit2 binds `spender = msg.sender = router`. DOMAIN_SEPARATOR is recomputed if the chain id changes. | `test_revert_replay_alreadyPaid`, `invariant_noDoublePay` (verbatim replays from random senders), `test_domainSeparator_followsChainId`, `test_eip3009Auth_notUsableOutsideRouter`, `test_permit2Sig_notUsableOutsideRouter` |
| 5 | **Front-running / griefing** | Copying the relayer's calldata produces the same outcome: the merchant is paid once and the payer charged once; the relayer's transaction then reverts with `AlreadyPaid`. Paying a *different* invoice with the same `id` does not block the real one, because the key is the struct hash. The indexer must match event fields (§5). The payer can grief the relayer (cancel an EIP-3009 authorization, invalidate a Permit2 nonce, move funds), so the relayer must simulate before sending. | `test_frontRun_copiedCalldata_paysOnce`, `test_griefing_sameIdDifferentTerms_doesNotBlockRealInvoice` |
| 6 | **Fee-on-transfer** | All amounts are balance deltas. The swap amount is the received delta, not `amountIn`. On payout, the merchant's balance delta must equal `amountOut`, otherwise it reverts with `InsufficientOutput(received, want)`, so a merchant is never underpaid. The research found no fee-on-transfer token on Celo, but wFIAT and USDC/USDT are upgradeable. | `test_feeOnTransfer_legSwapsMeasuredDelta`, `test_feeOnTransfer_tokenOut_shortInbound_reverts`, `test_feeOnTransfer_tokenOut_merchantShortPaid_reverts` |
| 7 | **Rebasing tokens** | Not supported as a design goal. Deltas are measured inside one call, so between-call rebases do not matter. Tokens donated to the router are never counted (deltas) and cannot be extracted; they are stuck because there is no sweep. A balance change in the middle of a call would make the merchant check revert (fail closed). | `invariant_routerHoldsNothing`, design note |
| 8 | **Return-value-less / false-returning tokens** | `SafeTransfer` accepts empty return data or `true`, and reverts on `false`, on a revert, or if the token has no code. | `test_noReturnTokens_usdtStyle`, `test_returnFalseToken_reverts`, `test_codelessToken_reverts` |
| 9 | **Deadline handling** | `block.timestamp > inv.deadline` reverts with `Expired()` (inclusive at the deadline). SwapRouter02 has no deadline, so the router's check is the only one. EIP-3009 `validBefore` and the Permit2 `deadline` come from the payer and are enforced by the token or Permit2 as well. | `test_revert_expired`, `test_deadlineInclusive` |
| 10 | **Dust / rounding / partial fills** | The router does no math besides `got - want`. Per-leg `amountOutMinimum = 0`; the aggregate check protects the merchant and the signed `amountIn` protects the payer. If a pool stops at its price limit, which can happen on the one-sided wBRL/USDT pool, the unswapped residue of the leg token goes back to the payer. Any surplus of tokenOut goes back to the payer, exactly. | `test_partialFill_residueRefundedToPayer`, `test_oneSwap_eip3009` (exact 4.5 wARS surplus), `testFuzz_exactPayoutOrRevert`, `invariant_merchantExact`, `invariant_payerSpendBounded`, `test_fork_eip3009_usdt_to_wARS` (surplus == quote − amountOut on the real pool) |
| 11 | **Gas griefing / long paths** | 1 to 3 legs (`InvalidLegs`). Path length is validated *before* any pull: at least 43 bytes, `(len−20) % 23 == 0`, and **at most 4 hops**. That cap is mine, not in the spec; it reverts with `InvalidPath`. Leg tokens are chosen by the payer and can burn gas or return-bomb `SafeTransfer`'s returndata copy. The relayer pays, so it must simulate and allow-list tokens. | `test_revert_invalidLegs_zeroAndFour`, `test_revert_invalidPath_*` (direct with path, swap with empty path, wrong first/last token, bad lengths, 5 hops), `test_fourHops_ok` |
| 12 | **Paused / blocklisted tokens** | wARS and wBRL (Ripio LatamStable) are pausable, and their contract has an optional blocklist that the issuer has not switched on (checked on-chain, see `docs/research/onchain-verification.md`); the router still handles the case if it is switched on. USDC and USDT have active blocklists. In every case the token's revert reverts the whole `pay`: nothing is pulled and the invoice stays unpaid. Specific cases: (a) a blocklisted payer or merchant means that invoice cannot be paid with that token; (b) a paused wFIAT blocks every payment into it; (c) **if the router address itself is blocklisted by Circle or Tether, it can no longer handle that token, and since it is immutable the fix is to redeploy**; (d) an upgrade of a token can change its semantics. Fee-on-transfer on payout is caught by the merchant delta check. | `test_blocklistedMerchant_failsClosed` (same signatures work once unblocked), `test_blocklistedRouterOrPayer_failsClosed`, `test_pausedTokenOut_failsClosed`. Note: `SafeTransfer` replaces the token's own revert reason with `ST`/`STF`/`SA`, while EIP-3009 and Permit2 reverts bubble up unchanged |
| 13 | **Trailing calldata (ERC-8021 attribution suffix)** | Standard ABI decoding ignores trailing bytes. | `test_trailingCalldata_erc8021Suffix_ok` |
| 14 | **ABI surface** | Exactly ICobraRouter: 8 functions, 1 event, 6 errors, no receive/fallback. Other reverts use short strings (`REENTRANCY`, `ST`, `STF`, `SA`, `ZERO_ADDRESS`), so no custom error leaks into the ABI. | `test/AbiParity.t.sol`, `packages/shared/test/abi-parity.test.ts`, `test_noReceive` |
| 15 | **Hash parity with TS** | The typehashes, the witness type string, invoiceHash, intentHash, intentDigest and legNonces all equal `test/vectors/eip712.json`. | `test/Vectors.t.sol` |

## Forge lint findings (accepted)

- `calls-loop` and `require-revert-in-loop`: the loop is bounded by 3 legs, and reverting the whole payment is intended.
- `reentrancy-no-eth` and `reentrancy-events`: the guard covers them, and `isPaid` is written before any external call.
  The event is emitted last on purpose, after the payout succeeds.
- `block-timestamp`: invoice deadlines have minute-level granularity, so this is acceptable.
- `unused-return` on `exactInput`: the router measures its own balance delta instead.
- `missing-zero-check`: the constructor rejects zero addresses, and `Deploy.s.sol` also requires code at both addresses.

## Findings from fork testing

- **The public anvil keys #0 and #1 have EIP-7702 delegations on Celo mainnet** (code `0xef0100…`). USDC (FiatToken
  v2.2 SignatureChecker), USDT and Permit2 all switch to ERC-1271 when the signer has code. Plain ECDSA signatures from
  those addresses then fail (`invalid signature`). Fork tests clear the code locally (`vm.etch`). **The same will happen
  to real payers whose wallet is a 7702-delegated EOA**: their signature is valid only if the delegate's
  `isValidSignature` accepts a raw ECDSA signature over the digest. Some smart-account delegates require an
  ERC-7739/replay-safe wrapped signature instead.

## Open questions for the reviewer

1. Is the merchant balance-delta check (stricter than the spec, reverts with `InsufficientOutput(received, want)`) wanted?
   It also rejects any tokenOut whose transfer delivers more or less than requested.
2. Is the 4-hop cap acceptable? The WS2 solver on `main` (71d7426) emits direct or two-hop paths and `MAX_LEGS = 3`,
   so it fits today.
3. Should `pay` reject `payer == address(0)` and `amountOut == 0`? Today it relies on tokens and Permit2 rejecting a
   zero signer (Permit2 and FiatToken do; the behaviour of USDT's implementation was not checked).
4. EIP-7702 / ERC-1271 payers (see above): WS5 should detect `payer.code.length > 0` and either test the signature
   with an `eth_call` or fall back to ALLOWANCE. **Resolved (4 Nov 2026):** at submit, for a delegated payer, the API
   calls `isValidSignature` on the account for each leg. MetaMask's delegator passes (fork-tested). A delegate that
   rejects gets a clear `smart_account_unsupported` message, and nothing is queued.
5. There is no sweep, so tokens sent to the router by mistake are lost for good. I accept this as the price of being
   ownerless.
6. MEV: the per-leg `amountOutMinimum` is 0. A sandwich can take at most the payer's signed buffer
   (`amountIn` minus what was really needed), never the merchant's amount. Celo L2 has a single FCFS sequencer, but
   the solver should still keep the buffer small.

## Deployment (human only, never run by agents)

```sh
cd contracts
PERMIT2=0x000000000022D473030F116dDEE9F6B43aC78BA3 \
SWAP_ROUTER=0x5615CDAb10dc425a742d643d949a7F474C01abc4 \
forge script script/Deploy.s.sol --rpc-url https://forno.celo.org \
  --broadcast --account <your-keystore-name> --sender <deployer-address>
# optional: --verify --verifier etherscan --etherscan-api-key $ETHERSCAN_API_KEY  (Etherscan v2 supports chain 42220)
```

A dry run without `--broadcast` succeeded against forno on 2 Nov 2026: about 2.45M gas, max ~0.98 CELO at a 200 gwei
base fee.

## Off-chain fixes (night security review, 3 Nov 2026)

### WS7-1: the global 24h relayer cap could be used up by self-payments (medium)

Merchant onboarding and static-QR invoices are open, and `CobraRouter.pay` allows `payer == inv.merchant` (the
merchant balance delta is measured after the pull). One actor could pay their own ~200 USD invoices ten times in a row
with the same wARS (W -> router -> W, gas paid by the relayer), fill the single global `perDayUsd` budget (2000 USD) and
make the signer refuse every real merchant with `cap_per_day` for 24h. The router is unchanged; the fix is off-chain:

- **Self-payment refused** in three places: `POST /api/invoices/:id/quote` and `/submit` return `400 self_payment`
  (`apps/web/lib/server/api.ts`), relayer `validate()` fails the submission with `self_payment`
  (`packages/relayer/src/relayer.ts`), and the signer refuses `pay()` calldata whose `payer == inv.merchant`
  (`SignerRefusedError("self_payment")`, `packages/relayer/src/signer.ts`), so no path can reach the key with it.
- **Per-merchant and per-payer rolling-24h caps** in the signer, next to the global one: relayed USD to one merchant
  payout address must stay ≤ `caps.perMerchantDayUsd`, and for one payer address ≤ `caps.perPayerDayUsd` (refusals
  `cap_per_merchant_day` / `cap_per_payer_day`). Both live in the existing `flags.caps` JSON; a stored flag without
  them falls back to `DEFAULT_CAPS` (500 USD each), never to "unlimited".
- Regression tests: `packages/relayer/test/signer.test.ts` (WS7-1 cases), `packages/relayer/test/relayer.test.ts`
  (self-payment on anvil, no tx sent), `apps/web/test/api.test.ts` (quote and signed submit refused, nothing stored).

Residual risk: with 500 USD per merchant and per payer, exhausting the 2000 USD global budget now needs at least four
distinct merchant onboardings (Telegram accounts) and four distinct payer wallets, plus real circulating funds between
them. Still sybil-able; a stronger follow-up is a lower cap for newly onboarded / unproven merchants.

## CobraRouterV2: Textile FX RFQ venue (WS12, 4 Nov 2026)

Scope: `src/CobraRouterV2.sol`, `src/ICobraRouterV2.sol`, `src/interfaces/IUniswapXReactor.sol`. Spec:
`docs/interfaces.md` §7. Author self-review, **not an audit**. v1 (`CobraRouter.sol`) is unchanged and byte-identical.

### What changes against v1

- Constructor `(permit2, swapRouter, textileReactor)`, all immutable and non-zero. Still no owner, fee, pause, upgrade,
  sweep or fallback. Same `pay`, structs, events, the 6 frozen errors and the same EIP-712 scheme; v1 and v2
  signatures are separated only by `verifyingContract` (`test_crossRouter_v1SignatureRejectedByV2`,
  `V2VectorsTest`).
- Venue by `leg.path`: empty = direct; `> 4` bytes starting with `TXF1` = Textile (same rule as `isTextileVenue` in
  `packages/shared`); anything else = Uniswap V3 path with the v1 rules.
- Textile leg, all checks before any pull: `path[4:]` decodes as `SignedOrder[]` (malformed bytes revert in the ABI
  decoder), at least one order, each `LimitOrder` has `info.reactor == TEXTILE_REACTOR`, `input.token == inv.tokenOut`
  and every output token `== leg.token` (else `InvalidTextileOrder()`). Then: approve the reactor for the **received
  delta** of `leg.token`, `executeBatchWithCallback(orders, "")`, approve back to 0, refund unspent `leg.token` to the
  payer. The v1 aggregate `InsufficientOutput` check and exact merchant payout apply unchanged.
- ABI additions: `TEXTILE_REACTOR()`, `reactorCallback(...)` (selector `0x585da628`, UniswapX `IReactorCallback`),
  `receive()`, errors `InvalidTextileOrder()` (`0xd8e037ec`) and `UnauthorizedCallback()` (`0xf5c6c81a`). `pay` and
  the views are ABI-identical to v1, so the frozen `packages/shared/src/abi.ts` can call v2.

### Verified reactor behaviour (Celoscan source, read-only `eth_call`, 4 Nov 2026, block ~81.90M)

- `0xa9aa0a64769cbed4d3b1ceb4df01cde915c235b3` is `LimitOrderReactor` (UniswapX BaseReactor vendored by Textile,
  solc 0.8.30, not a proxy). `permit2()` = canonical Permit2. `owner()` = `0x51727A09…ECbA4` (constructor owner
  `0x0ddf1dbb…93a7` transferred ownership). The owner's only power is `setProtocolFeeController`.
- `feeController()` = `0x7b005466…3Ea7` (`SellFirstFeeController`, BUSL-1.1): one fee output per output token,
  `FEE_BPS = 1` on Celo (its source comment says 5; the on-chain immutable is 1), reverts `FeeRoundsToZero` if
  `output * FEE_BPS < 10_000` (USD₮: outputs below 0.01). The reactor caps any controller at 5 bps of the matching
  output/input amount.
- Flow of `executeBatchWithCallback`: resolve, then per order `_injectFees`, `validate(filler = msg.sender)`
  (`InvalidReactor` + optional `additionalValidationContract.validate`, a `view` call), Permit2
  `permitWitnessTransferFrom` of the maker input to the filler (maker deadline enforced by Permit2); then
  `reactorCallback`; then `transferFrom(filler, recipient, amount)` for every output and fee; **then, if the reactor
  holds any native balance, it sends all of it to the filler** and reverts `NativeTransferFailed()` if the filler
  cannot receive it (`test_fork_v1RouterWouldRevertOnNativeRefund_documented`).
- `0x10B9EbA3…58C5` is `PreferredFillerValidation` (BUSL-1.1): `abi.encode(address[] fillers, uint256 exclusiveUntil)`;
  before `exclusiveUntil` only listed fillers may fill, **after it anyone may**.
- Fork proof (`test/fork/CobraRouterV2Fork.t.sol`): a forge-key maker funded with `deal`, approving the real Permit2,
  signs a LimitOrder for the real reactor (with `additionalValidationContract = 0` and with the real
  PreferredFillerValidation naming v2); v2 fills it and the merchant receives exactly `amountOut`; the real fee
  recipient receives exactly `floor(out * 1 / 10_000)`.

### Checklist (new external calls and approvals)

| # | Risk | Mitigation | Tests |
|---|------|-----------|-------|
| V1 | **Reactor allowance** | Only `leg.token`, only for the received delta (≤ signed `amountIn`), set right before the call and reset to 0 right after. `tokenOut` is never approved, so a fee on the maker's input token, or an output in `tokenOut`, fails closed. | `_assertRouterEmpty` (allowances to reactor and swap router) in every happy path, `invariant_v2_routerHoldsNothing`, `test_revert_textile_feeOnInputToken_failsClosed`, `test_revert_textile_outputIsTokenOut` |
| V2 | **Order content** | reactor, input token and output tokens are checked by the router; amounts, recipients, nonces, deadlines and maker signatures by the reactor and Permit2. The payer's signature commits to `keccak256(path)`, i.e. to every order byte and maker signature. Whatever the orders say, the payer spends at most `amountIn` (allowance) and the merchant gets exactly `amountOut` or the tx reverts. | `test_revert_textile_{wrongInputToken,wrongReactor,outputWrongToken,extraOutputToken,secondOrderInvalid,noOrders,malformedEncoding,orderBytesNotALimitOrder}`, `test_tamper_{swappedOrder,malleatedMakerSignature,droppedOrder}_invalidatesPayerSignature`, `test_fork_textile_tamperedOrder_realUsdtRejects`, `testFuzz_textile_exactOrRevert` |
| V3 | **Callback / reentrancy** | `reactorCallback` is `view` and reverts unless `msg.sender == TEXTILE_REACTOR` and the transient `_inTextileFill` flag is set (only around our own reactor call, inside `pay`). `pay` keeps the v1 transient lock, and the callback is a different function so the lock does not block it. Fee controller and validation contract are `view` calls (STATICCALL). The reactor has its own `nonReentrant`. | `test_revert_callback_{notReactor,reactorOutsidePay}`, `test_reentrancy_{payFromInsideTextileFill,callbackFromNonReactorDuringFill,reactorReentryDuringFill}_blocked`, `test_guardReleased_afterTextilePay` |
| V4 | **Native refund by the reactor (DoS)** | Without `receive`, 1 wei sent to the reactor by anyone would make every Textile leg revert until another filler drains it. v2 accepts native only from the reactor during its own fill and forwards `balance(end) − balance(start)` to the payer as the very last step of `pay` (after the event, lock still held). All ERC-20 flows net to zero, so this stays correct on Celo where CELO is also an ERC-20. The forward ignores failure on purpose: a payer that cannot receive native must not block its own payment; the dust then stays in the router (documented exception to "holds nothing"). | `test_textile_nativeDustInReactor_forwardedToPayer`, `test_textile_nativeDust_payerRejects_paymentStillSucceeds`, `test_revert_receive_outsideFill`, `test_fork_textile_nativeDustInReactor_forwarded`, `invariant_v2_nativeDustNotRetained` |
| V5 | **Quote expiry / exclusivity / missing fee** | All fail closed inside the reactor or Permit2 and revert the whole `pay`: nothing is pulled, the invoice stays unpaid. | `test_revert_textile_{expiredOrder,fillerRestrictedToOtherTaker,amountInBelowOutputPlusFee,makerUnderdelivers,makerOrderAlreadyFilled}`, fork equivalents |
| V6 | **Mixed legs** | Up to `MAX_LEGS = 3`, Textile legs can be mixed with Uniswap and direct legs (also two Textile legs of the same token); the aggregate check covers the total. | `test_mixed_*`, `test_fork_textile_plus_uniswap_mixed`, `RouterV2Invariant` |
| V7 | **Codec parity** | Solidity encodes/decodes `TXF1 ++ abi.encode(SignedOrder[])` exactly like `encodeTextileVenue` (vector generated by the frozen TS codec). | `V2VectorsTest.test_v2_textileCodecParity` |

### Residual risks / open questions

1. **Quote sniping.** The maker orders are public in the pending `pay` calldata. Exclusivity binds the filler to the
   *router*, not to the payer, so anyone can copy the orders into their own `pay` (paying the maker themselves) and
   make the original tx revert; after `exclusiveUntil`, or with no validation contract, anyone can also fill them
   directly on the reactor. No funds are lost (the victim's pay reverts entirely), it is a liveness / griefing risk.
   Celo L2's single FCFS sequencer (v1 open question 6) makes this harder but not impossible (not verified further).
2. **Reactor owner.** Can swap the fee controller at any time: fee ≤ 5 bps (reactor code), a fee change between
   quote and fill makes `pay` revert (payer protected by the allowance), a reverting controller DoSes the venue.
3. **`FeeRoundsToZero`.** With 1 bps, any order output below 10 000 base units reverts.
4. **Gas.** The number of orders is not capped (payer-signed; the relayer must simulate). Orders are ABI-decoded twice
   (router check + reactor).
5. A Uniswap path whose first token address starts with `0x54584631` would be routed to the Textile decoder and
   revert; no registry token does.
6. `TEXTILE_REACTOR` is immutable: if Textile moves to a new reactor, v2 must be redeployed.
7. **Native dust when the payer cannot receive native (accepted, decided 4 Nov 2026).** See V4: if the forward to the
   payer fails, the dust stays in the router, unrecoverable. Kept on purpose over the two alternatives: reverting
   would let anyone block a contract payer's Textile payments with 1 wei left in the reactor, and a sweep function
   needs an owner (the router has no admin, by design). Exposure: only native that a third party left in the
   reactor, only for payers that reject native; amounts are dust. No redeployment.

### Vendored test code (license)

`test/vendor/textile-uniswapx/**` and `test/vendor/openzeppelin/**` are the verified Celoscan sources of the reactor
(UniswapX: GPL-2.0-or-later; solmate: AGPL-3.0-only; Permit2 interfaces and OpenZeppelin: MIT), unmodified, with
their SPDX headers. They are **test-only**: the deployed `CobraRouterV2` (MIT) imports none of them;
`IUniswapXReactor.sol` holds independent ABI declarations. Textile's own BUSL-1.1 contracts (fee controller,
PreferredFillerValidation) are not vendored; the mocks re-implement their observed behaviour.

### Deployment (human only)

```sh
(cd contracts && forge build)
pnpm deploy:router --v2              # dry run: code checks, reactor.permit2(), tagged calldata, eth_estimateGas
# HUMAN ONLY, on the machine that holds the agent key (RELAYER_PRIVATE_KEY and RPC_URL in the environment):
pnpm deploy:router --v2 --execute
```

Dry run on 4 Nov 2026 (forno): initcode 11 720 bytes, tagged creation 11 755 bytes, `eth_estimateGas` 2 457 221.

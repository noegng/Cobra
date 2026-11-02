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
| 12 | **Paused / blocklisted tokens** | wARS and wBRL (Ripio LatamStable) are pausable and have a blocklist, which is currently not enforced. USDC and USDT have active blocklists. In every case the token's revert reverts the whole `pay`: nothing is pulled and the invoice stays unpaid. Specific cases: (a) a blocklisted payer or merchant means that invoice cannot be paid with that token; (b) a paused wFIAT blocks every payment into it; (c) **if the router address itself is blocklisted by Circle or Tether, it can no longer handle that token, and since it is immutable the fix is to redeploy**; (d) an upgrade of a token can change its semantics. Fee-on-transfer on payout is caught by the merchant delta check. | `test_blocklistedMerchant_failsClosed` (same signatures work once unblocked), `test_blocklistedRouterOrPayer_failsClosed`, `test_pausedTokenOut_failsClosed`. Note: `SafeTransfer` replaces the token's own revert reason with `ST`/`STF`/`SA`, while EIP-3009 and Permit2 reverts bubble up unchanged |
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
   with an `eth_call` or fall back to ALLOWANCE.
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

# End-to-end test (anvil fork of Celo mainnet)

One test replays the filmed demo across packages, so a change in the bot, the web API, the solver, the relayer, the
indexer or the router wiring cannot silently break it.

```sh
export PATH="/opt/homebrew/opt/node@24/bin:$HOME/.foundry/bin:$PATH"
pnpm test:e2e            # from the repo root, about 15 s once anvil has forked
```

It is NOT part of `pnpm test` (files are `apps/worker/test/e2e/*.e2e.ts`, config `apps/worker/vitest.e2e.config.ts`).
It skips cleanly, with a warning, if `anvil` is not installed or the fork RPC is unreachable.

Environment (all optional): `E2E_FORK_URL` (default `https://forno.celo.org`, read-only source of the fork),
`E2E_FORK_BLOCK` (default: head minus 20).

## What runs

`anvil --fork-url ... --chain-id 42220 --fork-block-number <head-20>` on a free local port, then, in one process:

- PGlite (`@cobra/db/testing`) with the real migrations;
- the Telegram bot (`buildBot`, `model: null`) driven with synthetic updates; every Bot API call is intercepted by a
  grammY transformer, nothing leaves the machine; the indexer/relayer notifier shares that intercepted `Api`;
- the web API handlers (`apps/web/lib/server/api.ts`: quote, submit, status) with deps wired like `deps.ts` but pointed at
  anvil (real solver + QuoterV2 on the fork);
- the worker pieces wired like `apps/worker/src/main.ts`: `createRelayerSigner` (guarded, ERC-8021 tagged), `startRelayer`
  with the gas grant, `startIndexer` (confirmations 0 because anvil automines);
- the deployed router `0xfe38...e458` from the fork.

Payers sign EIP-712 with viem local accounts, hydrating the quote's wire typed data exactly as `pay-page.tsx` does.

## Scenarios

| Test | Covers |
| --- | --- |
| scene 2 | onboard AR merchant, `cobrar 100 prueba`, payer with USD₮ and 0 CELO, EIP-3009, relayed, exactly 100 wARS, surplus refunded, ERC-8021 suffix, `payments` row, invoice `paid`, "Pago recibido" message |
| scene 3 | `cobrar 1000 café`, payer with wARS and 0 CELO, gas grant of 0.05 CELO, Permit2 approval, Permit2 signature, paid, notification |
| split | USDC + USD₮ two-leg EIP-3009 plan |
| wBRL | USD₮ to wBRL for a Brazilian merchant, Portuguese notification |
| negative | tampered value/nonce/foreign signature rejected by the API; a valid signature replayed against a tampered merchant is refused by the relayer; nothing is paid, payer funds do not move |

## Safety

Only anvil's public test keys are used. Every write goes to `127.0.0.1`. Token balances are set with
`anvil_setStorageAt` on the local fork only (USDC slot 9, USD₮/USAT slot 51, wFIAT: ERC-7201 namespaced OpenZeppelin
ERC20 storage). If a token upgrade moves these slots, `setTokenBalance` fails loudly instead of testing nothing.

Reference rates fed to the solver price guard and the relayer caps are derived from the fork's own Uniswap pools, so the
test is independent of live FX APIs (it exercises plumbing, not FX sanity).

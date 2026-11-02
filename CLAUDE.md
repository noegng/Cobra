# Cobrá — rules for every agent

LatAm merchant checkout on **Celo mainnet (42220)**: payer signs once, relayer submits, immutable router swaps via
Uniswap V3 and pays the merchant an exact wFIAT amount. Hackathon deadline: Mon 9 Nov 2026 09:00 GMT.

Read first: `docs/interfaces.md` (frozen contracts between packages), `docs/research/onchain-verification.md`
(verified addresses and token capabilities — trust it over anything remembered).

## Toolchain

```sh
export PATH="/opt/homebrew/opt/node@24/bin:$HOME/.foundry/bin:$PATH"
pnpm install            # workspace root
pnpm test               # all TS packages (vitest)
pnpm typecheck
cd contracts && forge test   # fork tests: CELO_RPC_URL=https://forno.celo.org
```

TypeScript ESM everywhere, packages export `src/*.ts` directly (no build step). Pin exact versions
(`pnpm add --save-exact`), justify every new dependency in your report.

## Hard safety rules (non-negotiable)

1. Never read, create or use private keys, mnemonics, keystores (`~/.foundry/keystores`) or production `.env` files.
   Tests use anvil's public test keys only.
2. Mainnet is **read-only** for agents: `eth_call`, logs, fork tests. Never broadcast a transaction, never run
   `forge script --broadcast`, never `cast send`. Mainnet transactions are triggered by the human through `packages/relayer` signer.
3. Work only in your worktree/branch and only on the paths you own (`docs/interfaces.md` §1). Do not merge.
4. Do not change frozen interfaces (`packages/shared`, `packages/db/src/schema.ts`, `contracts/src/ICobraRouter.sol`)
   — if you must, explain why under "Interface changes" in your report.
5. Money is `bigint` / integer strings. The LLM never computes amounts; a deterministic parser does.
6. No secrets in code, logs, prompts or commits.

## Definition of done

Tests green (`pnpm test`, `pnpm typecheck`, `forge test` where relevant), committed on your branch, and a night
report at `docs/reports/<WS>-<yyyy-mm-dd>.md` with three sections: **Fait**, **À relire**, **Bloqué**
(+ **Interface changes** if any).

<!-- rtk-instructions v2 -->
# Command output

Command output here is condensed to save tokens, keeping every signal and
dropping costly noise. Treat it as the complete result: run commands
normally, and batch related commands into one call to avoid extra turns.
Truncated results state their recovery path in their own output. Re-run a
command as `rtk bypass <cmd>` only when its result is unusable: empty when
output was clearly expected, contradicting its exit code, or garbled.
<!-- /rtk-instructions -->
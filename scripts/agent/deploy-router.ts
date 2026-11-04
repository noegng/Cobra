/**
 * Tagged CobraRouter deployment from the agent wallet (ERC-8021: HACKATHON_ATTRIBUTION_CODE).
 * DRY RUN by default. Use instead of `forge script --broadcast`, which cannot add the attribution suffix.
 *   (cd contracts && forge build) && pnpm exec tsx scripts/agent/deploy-router.ts
 *   --v2       : CobraRouterV2 (Textile venue, constructor adds TEXTILE_REACTOR), e.g. `pnpm deploy:router --v2`
 *   --calldata : print the full tagged creation calldata (dry run)
 *   --execute : HUMAN ONLY, needs RELAYER_PRIVATE_KEY and RPC_URL in env (same wallet as the relayer / ERC-8004 agent).
 */
import { runDeployCli } from "../../packages/relayer/src/deploy-cli";

runDeployCli(process.argv.slice(2), process.env).catch((e) => {
  console.error(String((e as Error).message ?? e));
  process.exit(1);
});

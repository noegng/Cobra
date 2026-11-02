/**
 * ERC-8004 agent registration for the relayer wallet. DRY RUN by default (prints card JSON + calldata).
 *   pnpm exec tsx scripts/agent/register.ts --base-url https://<host> [--wallet 0x..] [--agent-id N] [--write]
 *   --execute : HUMAN ONLY, needs RELAYER_PRIVATE_KEY, RPC_URL, ATTRIBUTION_CODE in env.
 */
import { runRegisterCli } from "../../packages/relayer/src/agent-cli";

runRegisterCli(process.argv.slice(2), process.env).catch((e) => {
  console.error(String((e as Error).message ?? e));
  process.exit(1);
});

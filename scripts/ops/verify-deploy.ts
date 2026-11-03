/**
 * Post-deployment verification, READ-ONLY (no key, no transaction).
 *   pnpm verify:deploy                 # uses the current environment
 *   pnpm verify:deploy --env .env.prod # or loads a dotenv file
 * Env: RPC_URL, ROUTER_ADDRESS, ROUTER_DEPLOY_BLOCK, ROUTER_DEPLOY_TX, AGENT_ADDRESS, AGENT_ID,
 *      PUBLIC_BASE_URL, TELEGRAM_BOT_TOKEN, DATABASE_URL (each optional: missing => SKIP).
 */
import { runVerifyCli } from "../../packages/relayer/src/ops-verify-cli";

runVerifyCli(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(String((e as Error).message ?? e));
    process.exit(1);
  });

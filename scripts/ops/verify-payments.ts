/**
 * Lists every Cobrá payment on Celo mainnet and checks it, READ-ONLY (no key, no transaction).
 *   pnpm verify:payments
 * Env (all optional): RPC_URL (default https://forno.celo.org), AGENT_ADDRESS.
 * Exit code 1 if any payment FAILs.
 */
import { runPaymentProofCli } from "../../packages/relayer/src/payment-proof-cli";

runPaymentProofCli(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(String((e as Error).message ?? e));
    process.exit(1);
  });

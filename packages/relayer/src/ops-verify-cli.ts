/**
 * `pnpm verify:deploy [--env path/to/.env]` — read-only post-deployment checks (see ops-verify.ts).
 * Exit code 1 if any check FAILs.
 */
import { createPublicClient, http, type PublicClient } from "viem";
import { celo } from "viem/chains";
import { createDb } from "@cobra/db";
import { formatReport, runVerification, type VerifyEnv } from "./ops-verify";

export async function runVerifyCli(argv: string[]): Promise<number> {
  const i = argv.indexOf("--env");
  if (i >= 0) {
    const path = argv[i + 1];
    if (!path) throw new Error("--env needs a path");
    process.loadEnvFile(path);
  }
  const env = process.env as VerifyEnv;
  const publicClient = createPublicClient({ chain: celo, transport: http(env.RPC_URL ?? "https://forno.celo.org") }) as PublicClient;
  const db = env.DATABASE_URL ? createDb(env.DATABASE_URL) : undefined;
  const results = await runVerification(env, {
    publicClient,
    fetch,
    ...(db && { db }),
    nowSec: Math.floor(Date.now() / 1000),
  });
  console.log(formatReport(results));
  return results.some((r) => r.status === "FAIL") ? 1 : 0;
}

/**
 * VPS worker (systemd). Wires relayer, indexer, expiry, reminders and daily close.
 * Owner: WS3 (relayer) — other workstreams only expose start functions from their packages.
 * RELAYER_PRIVATE_KEY exists ONLY on the VPS.
 */
import { createPublicClient, http, type Address } from "viem";
import { celo } from "viem/chains";
import { createDb } from "@cobra/db";
import { startIndexer, expireInvoices } from "@cobra/indexer";
import { createTelegramNotifier, runDailyClose, runReminders } from "@cobra/bot";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

const db = createDb(env("DATABASE_URL"));
const publicClient = createPublicClient({ chain: celo, transport: http(env("RPC_URL")) });
const router = env("ROUTER_ADDRESS") as Address;
const notifier = createTelegramNotifier({ token: env("TELEGRAM_BOT_TOKEN"), db });
const log = (msg: string, extra?: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));

// TODO(WS3): build the attributed wallet client from RELAYER_PRIVATE_KEY + ATTRIBUTION_CODE via
// @cobra/relayer's signer module, then `startRelayer({ db, publicClient, walletClient, router, notifier, log })`.

const indexer = startIndexer({
  db,
  publicClient: publicClient as never,
  router,
  fromBlock: BigInt(env("ROUTER_DEPLOY_BLOCK")),
  notifier,
  log,
});

const minute = setInterval(async () => {
  const now = new Date();
  try {
    await expireInvoices(db, now);
    await runReminders({ db, notifier, now, publicBaseUrl: env("PUBLIC_BASE_URL") });
    await runDailyClose({ db, notifier, now });
  } catch (e) {
    log("scheduler_error", { error: String(e) });
  }
}, 60_000);

async function shutdown() {
  clearInterval(minute);
  await indexer.stop();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
log("worker_started", { router });

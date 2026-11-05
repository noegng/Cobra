/**
 * VPS worker (systemd). Wires relayer, indexer, expiry, reminders and daily close.
 * Owner: WS3 (relayer) — other workstreams only expose start functions from their packages.
 * RELAYER_PRIVATE_KEY exists ONLY on the VPS (systemd EnvironmentFile, see deploy/cobra-worker.service).
 * The key is only handed to @cobra/relayer's signer; this file never logs or stores it.
 */
import { BaseError, createPublicClient, formatEther, getAddress, http, parseAbi, type PublicClient } from "viem";
import { celo } from "viem/chains";
import { agentEventRecorder, createDb } from "@cobra/db";
import { startIndexer, expireInvoices } from "@cobra/indexer";
import { createTelegramNotifier, runDailyClose, runReminders, withOperatorChat } from "@cobra/bot";
import { createRelayerSigner, startRelayer, type Stoppable } from "@cobra/relayer";
import { createReferenceRateSource, createTextileClient } from "@cobra/solver";
import { TEXTILE_REACTOR_CELO } from "@cobra/shared";
import { createLogger, loadWorkerConfig, type WorkerConfig } from "./config";

const baseLog = createLogger();
function loadOrExit(): WorkerConfig {
  try {
    return loadWorkerConfig(process.env);
  } catch (e) {
    baseLog("worker_config_error", { level: "error", error: (e as Error).message });
    process.exit(78); // EX_CONFIG: systemd does not hot-loop thanks to RestartPreventExitStatus=78
  }
}
const cfg = loadOrExit();
// The key now lives only in cfg → signer; drop it from the process environment (child processes, crash dumps).
delete process.env.RELAYER_PRIVATE_KEY;
delete process.env.TEXTILE_API_KEY; // lives only in cfg.textileApiKey → textile client

const db = createDb(cfg.databaseUrl);
const publicClient = createPublicClient({ chain: celo, transport: http(cfg.rpcUrl) }) as PublicClient;
// Operator alerts (relayer low balance, indexer unmatched payments) use text(operatorChatId, …).
const notifier = withOperatorChat(createTelegramNotifier({ token: cfg.telegramBotToken, db }), {
  token: cfg.telegramBotToken,
  ...(cfg.operatorChatId && { operatorChatId: cfg.operatorChatId }),
});

// Forward `level: "alert"` logs (indexer_alert_merchant_paid_unmatched, indexer_notify_dead, …) to the operator.
const alertSentAt = new Map<string, number>();
const log = (msg: string, extra?: Record<string, unknown>) => {
  baseLog(msg, extra);
  const chat = cfg.operatorChatId;
  if (extra?.level !== "alert" || !chat) return;
  const key = `${msg}:${String(extra.txHash ?? extra.key ?? extra.invoiceId ?? "")}`;
  const now = Date.now();
  if (now - (alertSentAt.get(key) ?? 0) < 10 * 60_000) return;
  alertSentAt.set(key, now);
  const details = Object.entries(extra)
    .filter(([k]) => k !== "level")
    .map(([k, v]) => `${k}=${typeof v === "bigint" ? v.toString() : typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join("\n");
  notifier.text(chat, `[Cobrá alert] ${msg}\n${details}`).catch((e) =>
    baseLog("alert_forward_failed", { level: "warn", error: String(e) }),
  );
};

const fx = createReferenceRateSource({ staleTtlMs: 24 * 3600_000 });
const rates = async () => ({ ...(await fx()), ...cfg.refRatesOverride });

let relayer: Stoppable | null = null;
let indexer: Stoppable | null = null;
let minute: ReturnType<typeof setInterval> | null = null;
let shuttingDown = false;

const reactorAbi = parseAbi(["function TEXTILE_REACTOR() view returns (address)"]);
/** CobraRouterV2 exposes TEXTILE_REACTOR(); v1 has no such function (revert / empty return). Other errors propagate. */
async function probeTextileReactor(): Promise<string | null> {
  try {
    return getAddress(await publicClient.readContract({ address: cfg.router, abi: reactorAbi, functionName: "TEXTILE_REACTOR" }));
  } catch (e) {
    if (e instanceof BaseError && e.walk((x) => ["ContractFunctionZeroDataError", "ContractFunctionRevertedError"].includes((x as Error).name))) return null;
    throw e;
  }
}

async function main() {
  const chainId = await publicClient.getChainId();
  if (chainId !== cfg.expectedChainId) throw new Error(`RPC chain id ${chainId} != expected ${cfg.expectedChainId}`);

  // WS13: is ROUTER_ADDRESS a v2 router (exposes TEXTILE_REACTOR())? A revert / empty return means v1.
  const reactor = await probeTextileReactor();
  if (cfg.textileApiKey && (!reactor || reactor.toLowerCase() !== TEXTILE_REACTOR_CELO.toLowerCase())) {
    baseLog("worker_config_error", { level: "error", error: "TEXTILE_API_KEY is set but ROUTER_ADDRESS is not a v2 router bound to the Textile reactor" });
    process.exit(78);
  }
  const textile = cfg.textileApiKey ? createTextileClient({ apiKey: cfg.textileApiKey, log: (m, e) => log(m, { svc: "textile", ...e }) }) : null;

  const signer = createRelayerSigner({
    privateKey: cfg.relayerPrivateKey,
    rpcUrl: cfg.rpcUrl,
    attributionCode: cfg.attributionCode,
    ...(cfg.walletAttributionCode && { walletAttributionCode: cfg.walletAttributionCode }),
    router: cfg.router,
    db,
    rates,
  });

  relayer = startRelayer({
    db,
    publicClient,
    walletClient: signer.walletClient,
    router: cfg.router,
    allowTextile: !!reactor,
    ...(textile && { onTextileSent: ({ rfqId, txHash }: { rfqId: string; txHash: string }) => textile.submit(rfqId, txHash) }),
    notifier,
    ...(cfg.operatorChatId && { operatorChatId: cfg.operatorChatId }),
    pollIntervalMs: cfg.pollIntervalMs,
    log: (msg, extra) => log(msg, { svc: "relayer", ...extra }),
    recordEvent: agentEventRecorder(db, (msg, extra) => log(msg, { svc: "relayer", ...extra })),
    gasGrant: cfg.gasGrantWei > 0n && cfg.gasGrantDailyMax > 0 ? { amountWei: cfg.gasGrantWei, dailyMax: cfg.gasGrantDailyMax } : false,
  });

  indexer = startIndexer({
    db,
    publicClient,
    router: cfg.router,
    fromBlock: cfg.routerDeployBlock,
    ...(cfg.legacyRouter && { legacyRouter: { address: cfg.legacyRouter.address, fromBlock: cfg.legacyRouter.deployBlock } }),
    notifier,
    log: (msg, extra) => log(msg, { svc: "indexer", ...extra }),
  });

  let schedulerBusy = false;
  minute = setInterval(async () => {
    if (schedulerBusy || shuttingDown) return;
    schedulerBusy = true;
    const now = new Date();
    for (const [name, job] of [
      ["expire", () => expireInvoices(db, now)],
      ["reminders", () => runReminders({ db, notifier, now, publicBaseUrl: cfg.publicBaseUrl })],
      ["daily_close", () => runDailyClose({ db, notifier, now })],
    ] as const) {
      try {
        await job();
      } catch (e) {
        log("scheduler_error", { level: "error", job: name, error: String(e) });
      }
    }
    schedulerBusy = false;
  }, 60_000);

  log("worker_started", { router: cfg.router, legacyRouter: cfg.legacyRouter?.address ?? null, textile: !!textile, routerV2: !!reactor, relayer: signer.address, chainId, gasGrantCelo: formatEther(cfg.gasGrantWei), gasGrantDailyMax: cfg.gasGrantDailyMax });
}

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("worker_stopping", { signal });
  const force = setTimeout(() => {
    log("worker_shutdown_timeout", { level: "error" });
    process.exit(1);
  }, 20_000);
  force.unref();
  if (minute) clearInterval(minute);
  // relayer first: lets an in-flight send persist its txHash before we exit
  await Promise.allSettled([relayer?.stop(), indexer?.stop()]);
  log("worker_stopped");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (e) => log("unhandled_rejection", { level: "error", error: String(e) }));
process.on("uncaughtException", (e) => {
  log("uncaught_exception", { level: "error", error: String(e) });
  void shutdown("uncaughtException");
});

main().catch((e) => {
  log("worker_start_failed", { level: "error", error: String(e) });
  process.exit(1);
});

import { HACKATHON_ATTRIBUTION_CODE } from "@cobra/shared";
/**
 * Worker env validation. Errors name the variable but NEVER echo a secret value.
 */
import { getAddress, isAddress, parseEther, type Address, type Hex } from "viem";
import type { ReferenceRates } from "@cobra/shared";

export interface WorkerConfig {
  databaseUrl: string;
  rpcUrl: string;
  router: Address;
  routerDeployBlock: bigint;
  /** v1 router still followed by the indexer after the switch to v2 (LEGACY_ROUTER_ADDRESS + LEGACY_ROUTER_DEPLOY_BLOCK). */
  legacyRouter: { address: Address; deployBlock: bigint } | undefined;
  /** Textile partner API key (secret). undefined = Textile off on the worker (no RFQ submit reports). */
  textileApiKey: string | undefined;
  publicBaseUrl: string;
  telegramBotToken: string;
  operatorChatId: string | undefined;
  relayerPrivateKey: Hex; // secret
  attributionCode: string;
  walletAttributionCode: string | undefined;
  refRatesOverride: ReferenceRates | undefined;
  minBalanceWei: bigint;
  pollIntervalMs: number;
  /** CELO per gas grant for wFIAT payers without gas; 0n = disabled. Env GAS_GRANT_CELO (default 0.05). */
  gasGrantWei: bigint;
  /** Env GAS_GRANT_DAILY_MAX (default 20). */
  gasGrantDailyMax: number;
  /** Escape hatch for a dev chain; production refuses anything but Celo mainnet. */
  expectedChainId: number;
}

const CODE_RE = /^[a-z0-9_]{1,32}$/;

export function loadWorkerConfig(env: Record<string, string | undefined>): WorkerConfig {
  const errors: string[] = [];
  const req = (name: string): string => {
    const v = env[name]?.trim();
    if (!v) errors.push(`missing ${name}`);
    return v ?? "";
  };
  const opt = (name: string) => env[name]?.trim() || undefined;

  const databaseUrl = req("DATABASE_URL");
  const rpcUrl = req("RPC_URL");
  const routerRaw = req("ROUTER_ADDRESS");
  const deployBlock = req("ROUTER_DEPLOY_BLOCK");
  const publicBaseUrl = req("PUBLIC_BASE_URL");
  const telegramBotToken = req("TELEGRAM_BOT_TOKEN");
  const key = req("RELAYER_PRIVATE_KEY");
  const attributionCode = opt("ATTRIBUTION_CODE") ?? HACKATHON_ATTRIBUTION_CODE;
  const walletAttributionCode = opt("ATTRIBUTION_WALLET_CODE");

  if (routerRaw && !isAddress(routerRaw, { strict: false })) errors.push("ROUTER_ADDRESS is not an address");
  if (deployBlock && !/^\d+$/.test(deployBlock)) errors.push("ROUTER_DEPLOY_BLOCK must be an integer");
  // WS13: legacy (v1) router, both or neither; must differ from the active router.
  const legacyRaw = opt("LEGACY_ROUTER_ADDRESS");
  const legacyBlock = opt("LEGACY_ROUTER_DEPLOY_BLOCK");
  if (!!legacyRaw !== !!legacyBlock) errors.push("LEGACY_ROUTER_ADDRESS and LEGACY_ROUTER_DEPLOY_BLOCK must be set together");
  if (legacyRaw && !isAddress(legacyRaw, { strict: false })) errors.push("LEGACY_ROUTER_ADDRESS is not an address");
  if (legacyBlock && !/^\d+$/.test(legacyBlock)) errors.push("LEGACY_ROUTER_DEPLOY_BLOCK must be an integer");
  if (legacyRaw && routerRaw && isAddress(legacyRaw, { strict: false }) && isAddress(routerRaw, { strict: false }) && getAddress(legacyRaw) === getAddress(routerRaw)) {
    errors.push("LEGACY_ROUTER_ADDRESS must differ from ROUTER_ADDRESS");
  }
  // Textile only exists on router v2, i.e. after a switch: the previous (v1) router must be kept as legacy.
  const textileApiKey = opt("TEXTILE_API_KEY");
  const textileOn = !!textileApiKey && opt("TEXTILE_ENABLED") !== "false";
  if (textileOn && !legacyRaw) errors.push("TEXTILE_API_KEY needs the v2 router: set LEGACY_ROUTER_ADDRESS (+ _DEPLOY_BLOCK) to the v1 router, or unset TEXTILE_API_KEY");
  if (opt("TEXTILE_ENABLED") && !["true", "false"].includes(opt("TEXTILE_ENABLED")!)) errors.push("TEXTILE_ENABLED must be true or false");
  if (rpcUrl && !/^https?:\/\//.test(rpcUrl)) errors.push("RPC_URL must be http(s)");
  if (publicBaseUrl && !/^https:\/\//.test(publicBaseUrl)) errors.push("PUBLIC_BASE_URL must be https");
  if (key && !/^0x[0-9a-fA-F]{64}$/.test(key)) errors.push("RELAYER_PRIVATE_KEY must be 0x + 64 hex chars");
  if (attributionCode && !CODE_RE.test(attributionCode)) errors.push("ATTRIBUTION_CODE must match [a-z0-9_]{1,32}");
  if (walletAttributionCode && !CODE_RE.test(walletAttributionCode)) errors.push("ATTRIBUTION_WALLET_CODE must match [a-z0-9_]{1,32}");

  let refRatesOverride: ReferenceRates | undefined;
  const rr = opt("REF_RATES");
  if (rr) {
    try {
      const parsed = JSON.parse(rr) as Record<string, unknown>;
      if (!Object.values(parsed).every((v) => typeof v === "number" && v > 0)) throw new Error();
      refRatesOverride = parsed as ReferenceRates;
    } catch {
      errors.push('REF_RATES must be JSON like {"ARS":0.0006}');
    }
  }
  let minBalanceWei = parseEther("0.5");
  const mb = opt("RELAYER_MIN_BALANCE_CELO");
  if (mb) {
    try {
      minBalanceWei = parseEther(mb);
    } catch {
      errors.push("RELAYER_MIN_BALANCE_CELO must be a decimal");
    }
  }
  const pollIntervalMs = Number(opt("RELAYER_POLL_MS") ?? 2000);
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 200) errors.push("RELAYER_POLL_MS must be an integer >= 200");
  let gasGrantWei = parseEther("0.05");
  const gg = opt("GAS_GRANT_CELO");
  if (gg) {
    try {
      gasGrantWei = parseEther(gg);
      if (gasGrantWei < 0n || gasGrantWei > parseEther("0.1")) throw new Error();
    } catch {
      errors.push("GAS_GRANT_CELO must be a decimal between 0 and 0.1");
    }
  }
  const gasGrantDailyMax = Number(opt("GAS_GRANT_DAILY_MAX") ?? 20);
  if (!Number.isInteger(gasGrantDailyMax) || gasGrantDailyMax < 0 || gasGrantDailyMax > 500) errors.push("GAS_GRANT_DAILY_MAX must be an integer in [0, 500]");
  const expectedChainId = Number(opt("EXPECTED_CHAIN_ID") ?? 42220);

  if (errors.length) throw new Error(`invalid worker env: ${errors.join("; ")}`);
  return {
    databaseUrl,
    rpcUrl,
    router: getAddress(routerRaw),
    routerDeployBlock: BigInt(deployBlock),
    legacyRouter: legacyRaw && legacyBlock ? { address: getAddress(legacyRaw), deployBlock: BigInt(legacyBlock) } : undefined,
    textileApiKey: textileOn ? textileApiKey : undefined,
    publicBaseUrl,
    telegramBotToken,
    operatorChatId: opt("OPERATOR_TELEGRAM_CHAT_ID"),
    relayerPrivateKey: key as Hex,
    attributionCode,
    walletAttributionCode,
    refRatesOverride,
    minBalanceWei,
    pollIntervalMs,
    gasGrantWei,
    gasGrantDailyMax,
    expectedChainId,
  };
}

/** Structured JSON logger; `level: "alert"` entries are also forwarded to the operator (see main.ts). */
export function createLogger(write: (line: string) => void = (l) => process.stdout.write(l + "\n")) {
  return (msg: string, extra?: Record<string, unknown>) => {
    const line = JSON.stringify({ t: new Date().toISOString(), level: "info", msg, ...extra }, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    write(line);
  };
}

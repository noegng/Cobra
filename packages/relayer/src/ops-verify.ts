/**
 * Post-deployment verification (READ-ONLY: eth_call, HTTP GET, Telegram getters, SELECTs). No key, no tx.
 * Entry: scripts/ops/verify-deploy.ts (`pnpm verify:deploy`). Every check reports PASS / WARN / FAIL / SKIP.
 */
import { fromDataSuffix } from "@celo/attribution-tags";
import { and, count, eq, inArray, lt } from "drizzle-orm";
import {
  formatEther,
  getAddress,
  hashDomain,
  isAddressEqual,
  parseAbi,
  parseEther,
  type Address,
  type Hash,
  type PublicClient,
} from "viem";
import { CELO, CELO_CHAIN_ID, HACKATHON_ATTRIBUTION_CODE, ROUTER_DOMAIN } from "@cobra/shared";
import { chainCursor, isKillSwitchOn, merchants, submissions, type Db } from "@cobra/db";
import { REGISTRATION_TYPE, agentCardUrl } from "./agent";

export type Status = "PASS" | "WARN" | "FAIL" | "SKIP";
export interface CheckResult {
  group: string;
  name: string;
  status: Status;
  detail: string;
}

const routerViewAbi = parseAbi([
  "function PERMIT2() view returns (address)",
  "function SWAP_ROUTER() view returns (address)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
]);
const erc721Abi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function tokenURI(uint256 tokenId) view returns (string)",
]);

// ───────────── pure validators (unit-tested) ─────────────

/** Problems with the served ERC-8004 agent card; empty array = OK. */
export function validateAgentCard(
  card: unknown,
  o: { baseUrl: string; agentAddress?: Address; agentId?: number },
): string[] {
  const p: string[] = [];
  if (!card || typeof card !== "object") return ["card is not a JSON object"];
  const c = card as Record<string, unknown>;
  if (c.type !== REGISTRATION_TYPE) p.push(`type must be exactly ${REGISTRATION_TYPE}`);
  for (const k of ["name", "description", "image"]) if (typeof c[k] !== "string" || !(c[k] as string).trim()) p.push(`missing ${k}`);
  const text = JSON.stringify(c);
  if (/PLACEHOLDER|cobra\.example/i.test(text)) p.push("still contains placeholder text or cobra.example");
  if ("endpoints" in c) p.push("uses legacy `endpoints` (8004scan expects `services`)");
  const services = Array.isArray(c.services) ? (c.services as { name?: string; endpoint?: string }[]) : [];
  if (!services.length) p.push("no services");
  if (o.agentAddress) {
    const want = `eip155:${CELO_CHAIN_ID}:${getAddress(o.agentAddress)}`.toLowerCase();
    if (!services.some((s) => s.endpoint?.toLowerCase() === want)) p.push(`no agentWallet service ${want}`);
  }
  if (o.agentId !== undefined) {
    const regs = Array.isArray(c.registrations) ? (c.registrations as { agentId?: number; agentRegistry?: string }[]) : [];
    const registry = `eip155:${CELO_CHAIN_ID}:${CELO.erc8004.identityRegistry.address}`.toLowerCase();
    if (!regs.some((r) => r.agentId === o.agentId && r.agentRegistry?.toLowerCase() === registry)) {
      p.push(`registrations lacks agentId ${o.agentId} on ${registry}`);
    }
  }
  return p;
}

export interface WebhookInfo {
  url: string;
  pending_update_count: number;
  last_error_date?: number;
  last_error_message?: string;
}

/** Problems with Telegram's getWebhookInfo; `nowSec` injected for tests. */
export function validateWebhookInfo(info: WebhookInfo, baseUrl: string, nowSec: number): { fail: string[]; warn: string[] } {
  const fail: string[] = [];
  const warn: string[] = [];
  const want = `${baseUrl.replace(/\/$/, "")}/api/telegram`;
  if (info.url !== want) fail.push(`webhook url is "${info.url || "(none)"}", expected ${want}`);
  if (info.pending_update_count > 10) warn.push(`${info.pending_update_count} pending updates (webhook failing?)`);
  if (info.last_error_message && info.last_error_date && nowSec - info.last_error_date < 3600) {
    // Telegram keeps last_error_* after later successes: show its age and the backlog so a fixed webhook is recognisable.
    const mins = Math.max(0, Math.round((nowSec - info.last_error_date) / 60));
    warn.push(`last error ${mins} min ago: ${info.last_error_message} (${info.pending_update_count} pending update(s))`);
  }
  return { fail, warn };
}

// ───────────── runner ─────────────

export interface VerifyEnv {
  RPC_URL?: string;
  ROUTER_ADDRESS?: string;
  ROUTER_DEPLOY_BLOCK?: string;
  ROUTER_DEPLOY_TX?: string;
  AGENT_ADDRESS?: string;
  AGENT_ID?: string;
  PUBLIC_BASE_URL?: string;
  TELEGRAM_BOT_TOKEN?: string;
  DATABASE_URL?: string;
  RELAYER_MIN_BALANCE_CELO?: string;
  ATTRIBUTION_CODE?: string;
}

export interface VerifyDeps {
  publicClient: PublicClient;
  fetch: typeof fetch;
  db?: Db;
  nowSec: number;
}

export async function runVerification(env: VerifyEnv, deps: VerifyDeps): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const add = (group: string, name: string, status: Status, detail = "") => out.push({ group, name, status, detail });
  const guard = async (group: string, name: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      // Drizzle wraps driver errors ("Failed query: …"); the actionable reason is in `cause`.
      const err = e as Error & { cause?: unknown };
      const head = err.message?.split("\n")[0] ?? String(e);
      const cause = err.cause instanceof Error ? err.cause.message.split("\n")[0] : undefined;
      add(group, name, "FAIL", cause ? `${head} — cause: ${cause}` : head);
    }
  };
  const pc = deps.publicClient;
  const code = env.ATTRIBUTION_CODE ?? HACKATHON_ATTRIBUTION_CODE;
  const agent = env.AGENT_ADDRESS ? getAddress(env.AGENT_ADDRESS) : undefined;
  const agentId = env.AGENT_ID !== undefined && env.AGENT_ID !== "" ? Number(env.AGENT_ID) : undefined;
  const base = env.PUBLIC_BASE_URL?.replace(/\/$/, "");

  // ── chain
  await guard("chain", "RPC chain id", async () => {
    const id = await pc.getChainId();
    add("chain", "RPC chain id", id === CELO_CHAIN_ID ? "PASS" : "FAIL", `chainId=${id}`);
  });

  // ── router
  if (!env.ROUTER_ADDRESS) add("router", "ROUTER_ADDRESS", "SKIP", "not set");
  else {
    const router = getAddress(env.ROUTER_ADDRESS);
    await guard("router", "bytecode", async () => {
      const bc = await pc.getCode({ address: router });
      add("router", "bytecode", bc && bc !== "0x" ? "PASS" : "FAIL", bc ? `${(bc.length - 2) / 2} bytes` : "no code");
    });
    await guard("router", "immutables", async () => {
      const [p2, sr] = await Promise.all([
        pc.readContract({ address: router, abi: routerViewAbi, functionName: "PERMIT2" }),
        pc.readContract({ address: router, abi: routerViewAbi, functionName: "SWAP_ROUTER" }),
      ]);
      const ok = isAddressEqual(p2, CELO.permit2.address) && isAddressEqual(sr, CELO.uniswapV3.swapRouter.address);
      add("router", "immutables", ok ? "PASS" : "FAIL", `PERMIT2=${p2} SWAP_ROUTER=${sr}`);
    });
    await guard("router", "EIP-712 domain", async () => {
      const ds = await pc.readContract({ address: router, abi: routerViewAbi, functionName: "DOMAIN_SEPARATOR" });
      const want = hashDomain({
        domain: { ...ROUTER_DOMAIN, chainId: BigInt(CELO_CHAIN_ID), verifyingContract: router },
        types: { EIP712Domain: [
          { name: "name", type: "string" }, { name: "version", type: "string" },
          { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
        ] },
      });
      add("router", "EIP-712 domain", ds === want ? "PASS" : "FAIL", ds === want ? "matches packages/shared" : `got ${ds}, want ${want}`);
    });
    if (!env.ROUTER_DEPLOY_TX) add("router", "deployment tx tagged (ERC-8021)", "WARN", "ROUTER_DEPLOY_TX not set: tag not checked");
    else {
      await guard("router", "deployment tx tagged (ERC-8021)", async () => {
        const hash = env.ROUTER_DEPLOY_TX as Hash;
        const [tx, rc] = await Promise.all([pc.getTransaction({ hash }), pc.getTransactionReceipt({ hash })]);
        const p: string[] = [];
        if (!rc.contractAddress || !isAddressEqual(rc.contractAddress, router)) p.push(`created ${rc.contractAddress}, not the router`);
        if (agent && !isAddressEqual(tx.from, agent)) p.push(`sent by ${tx.from}, not AGENT_ADDRESS`);
        if (env.ROUTER_DEPLOY_BLOCK && BigInt(env.ROUTER_DEPLOY_BLOCK) !== rc.blockNumber) p.push(`ROUTER_DEPLOY_BLOCK=${env.ROUTER_DEPLOY_BLOCK} but tx is in block ${rc.blockNumber}`);
        let tagged = false;
        try {
          tagged = JSON.stringify(fromDataSuffix(tx.input)).includes(code);
        } catch {
          tagged = false;
        }
        if (!tagged) p.push(`no ERC-8021 suffix with ${code}`);
        add("router", "deployment tx tagged (ERC-8021)", p.length ? "FAIL" : "PASS", p.join("; ") || `block ${rc.blockNumber}, code ${code}`);
      });
    }
  }

  // ── agent wallet + ERC-8004
  if (!agent) add("agent", "AGENT_ADDRESS", "SKIP", "not set");
  else {
    await guard("agent", "gas balance", async () => {
      const bal = await pc.getBalance({ address: agent });
      const min = parseEther(env.RELAYER_MIN_BALANCE_CELO ?? "0.5");
      add("agent", "gas balance", bal >= min ? "PASS" : "WARN", `${formatEther(bal)} CELO (min ${formatEther(min)})`);
    });
    const registry = CELO.erc8004.identityRegistry.address;
    await guard("agent", "ERC-8004 registered", async () => {
      const n = await pc.readContract({ address: registry, abi: erc721Abi, functionName: "balanceOf", args: [agent] });
      add("agent", "ERC-8004 registered", n > 0n ? "PASS" : "FAIL", `${n} identity token(s) owned on ${registry}`);
    });
    if (agentId === undefined) add("agent", "ERC-8004 agentId", "WARN", "AGENT_ID not set: owner/URI not checked");
    else {
      await guard("agent", "ERC-8004 agentId", async () => {
        const [owner, uri] = await Promise.all([
          pc.readContract({ address: registry, abi: erc721Abi, functionName: "ownerOf", args: [BigInt(agentId)] }),
          pc.readContract({ address: registry, abi: erc721Abi, functionName: "tokenURI", args: [BigInt(agentId)] }),
        ]);
        const p: string[] = [];
        if (!isAddressEqual(owner, agent)) p.push(`owner ${owner} != AGENT_ADDRESS`);
        if (base && uri !== agentCardUrl(base)) p.push(`agentURI ${uri} != ${agentCardUrl(base)}`);
        add("agent", "ERC-8004 agentId", p.length ? "FAIL" : "PASS", p.join("; ") || `#${agentId} → ${uri}`);
      });
    }
  }

  // ── web (Vercel)
  if (!base) add("web", "PUBLIC_BASE_URL", "SKIP", "not set");
  else {
    if (!base.startsWith("https://")) add("web", "HTTPS", "FAIL", "PUBLIC_BASE_URL must be https://");
    await guard("web", "agent card", async () => {
      const r = await deps.fetch(agentCardUrl(base));
      if (!r.ok) return add("web", "agent card", "FAIL", `${agentCardUrl(base)} → HTTP ${r.status}`);
      const card: unknown = await r.json();
      const p = validateAgentCard(card, { baseUrl: base, ...(agent && { agentAddress: agent }), ...(agentId !== undefined && { agentId }) });
      add("web", "agent card", p.length ? "FAIL" : "PASS", p.join("; ") || agentCardUrl(base));
      const img = (card as { image?: unknown }).image;
      if (typeof img === "string" && img.startsWith("http")) {
        const ir = await deps.fetch(img, { method: "HEAD" });
        add("web", "agent card image", ir.ok ? "PASS" : "FAIL", `${img} → HTTP ${ir.status}`);
      }
    });
    await guard("web", "/proof page", async () => {
      const r = await deps.fetch(`${base}/proof`);
      add("web", "/proof page", r.ok ? "PASS" : "FAIL", `HTTP ${r.status}`);
    });
    await guard("web", "API + database", async () => {
      // An unknown invoice id must give 404 (API up AND database reachable); 5xx means misconfigured env/DB.
      const r = await deps.fetch(`${base}/api/invoices/0x${"00".repeat(32)}`);
      add("web", "API + database", r.status === 404 ? "PASS" : "FAIL", `unknown invoice → HTTP ${r.status} (want 404)`);
    });
  }

  // ── Telegram
  if (!env.TELEGRAM_BOT_TOKEN) add("telegram", "TELEGRAM_BOT_TOKEN", "SKIP", "not set");
  else {
    const tg = (m: string) => deps.fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${m}`).then((r) => r.json() as Promise<{ ok: boolean; result: unknown; description?: string }>);
    await guard("telegram", "bot token", async () => {
      const me = await tg("getMe");
      add("telegram", "bot token", me.ok ? "PASS" : "FAIL", me.ok ? `@${(me.result as { username: string }).username}` : (me.description ?? "invalid"));
    });
    if (base) {
      await guard("telegram", "webhook", async () => {
        const wi = await tg("getWebhookInfo");
        if (!wi.ok) return add("telegram", "webhook", "FAIL", wi.description ?? "getWebhookInfo failed");
        const v = validateWebhookInfo(wi.result as WebhookInfo, base, deps.nowSec);
        add("telegram", "webhook", v.fail.length ? "FAIL" : v.warn.length ? "WARN" : "PASS", [...v.fail, ...v.warn].join("; ") || "url OK, no recent error");
      });
    }
  }

  // ── database + worker liveness
  if (!deps.db) add("database", "DATABASE_URL", "SKIP", "not set");
  else {
    const db = deps.db;
    await guard("database", "migrations", async () => {
      const [r] = await db.select({ n: count() }).from(merchants);
      add("database", "migrations", "PASS", `${r?.n ?? 0} merchant(s)`);
    });
    await guard("database", "kill switch", async () => {
      const on = await isKillSwitchOn(db, {});
      add("database", "kill switch", on ? "WARN" : "PASS", on ? "ON in flags table: relaying is stopped" : "off (flags table)");
    });
    await guard("worker", "indexer cursor", async () => {
      const [c] = await db.select().from(chainCursor).where(eq(chainCursor.id, "router_paid"));
      if (!c) return add("worker", "indexer cursor", "FAIL", "no router_paid cursor: indexer never ran");
      const ageS = deps.nowSec - Math.floor(c.updatedAt.getTime() / 1000);
      const p: string[] = [];
      if (env.ROUTER_DEPLOY_BLOCK && c.blockNumber < BigInt(env.ROUTER_DEPLOY_BLOCK)) p.push(`cursor ${c.blockNumber} < deploy block`);
      add("worker", "indexer cursor", p.length ? "FAIL" : ageS > 600 ? "WARN" : "PASS", p.join("; ") || `block ${c.blockNumber}, updated ${ageS}s ago${ageS > 600 ? " (idle >10 min: worker down, or simply no new batch)" : ""}`);
    });
    await guard("worker", "relay queue", async () => {
      const cutoff = new Date((deps.nowSec - 300) * 1000);
      const [r] = await db
        .select({ n: count() })
        .from(submissions)
        .where(and(inArray(submissions.status, ["pending", "sending"]), lt(submissions.updatedAt, cutoff)));
      const n = r?.n ?? 0;
      add("worker", "relay queue", n === 0 ? "PASS" : "FAIL", n === 0 ? "no submission stuck >5 min" : `${n} submission(s) pending/sending for >5 min: relayer down?`);
    });
  }
  return out;
}

export function formatReport(results: CheckResult[]): string {
  const icon: Record<Status, string> = { PASS: "✅", WARN: "⚠️ ", FAIL: "❌", SKIP: "⏭️ " };
  const lines = results.map((r) => `${icon[r.status]} [${r.group}] ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  const n = (s: Status) => results.filter((r) => r.status === s).length;
  lines.push("", `PASS ${n("PASS")} · WARN ${n("WARN")} · FAIL ${n("FAIL")} · SKIP ${n("SKIP")}`);
  return lines.join("\n");
}

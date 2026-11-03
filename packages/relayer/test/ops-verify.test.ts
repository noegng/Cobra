import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { http, type Address, type Hash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { CELO, HACKATHON_ATTRIBUTION_CODE } from "@cobra/shared";
import { createTestDb } from "@cobra/db/testing";
import { chainCursor, submissions, invoices, merchants } from "@cobra/db";
import { ROUTER_ARTIFACT_PATH, createRouterDeployer, loadRouterArtifact } from "../src/deploy";
import { REGISTRATION_TYPE } from "../src/agent";
import { runVerification, validateAgentCard, validateWebhookInfo, type CheckResult } from "../src/ops-verify";
import { ANVIL_KEYS, hasAnvil, startAnvil, type Anvil } from "./helpers";

const BASE = "https://cobra.app";
const AGENT = privateKeyToAccount(ANVIL_KEYS.deployer).address;
const registry = `eip155:42220:${CELO.erc8004.identityRegistry.address}`;
const goodCard = {
  type: REGISTRATION_TYPE, name: "Cobrá", description: "LatAm checkout agent", image: `${BASE}/icon.svg`,
  services: [{ name: "web", endpoint: `${BASE}/` }, { name: "agentWallet", endpoint: `eip155:42220:${AGENT}` }],
  registrations: [{ agentId: 7, agentRegistry: registry }],
};
const status = (rs: CheckResult[], name: string) => rs.find((r) => r.name === name)?.status;

describe("validateAgentCard", () => {
  it("accepts a complete card", () => {
    expect(validateAgentCard(goodCard, { baseUrl: BASE, agentAddress: AGENT, agentId: 7 })).toEqual([]);
  });
  it("flags placeholder, wrong type, legacy endpoints, missing wallet and agentId", () => {
    const bad = { ...goodCard, type: "x", description: "PLACEHOLDER", endpoints: [], services: [{ name: "web", endpoint: "https://cobra.example/" }], registrations: [] };
    const p = validateAgentCard(bad, { baseUrl: BASE, agentAddress: AGENT, agentId: 7 }).join(" | ");
    for (const s of ["type must be", "placeholder", "legacy `endpoints`", "agentWallet", "agentId 7"]) expect(p).toContain(s);
  });
});

describe("validateWebhookInfo", () => {
  it("requires the /api/telegram url and warns on recent errors", () => {
    expect(validateWebhookInfo({ url: `${BASE}/api/telegram`, pending_update_count: 0 }, BASE, 1000)).toEqual({ fail: [], warn: [] });
    const v = validateWebhookInfo({ url: "", pending_update_count: 50, last_error_date: 900, last_error_message: "Wrong response: 401" }, BASE, 1000);
    expect(v.fail[0]).toContain("expected https://cobra.app/api/telegram");
    expect(v.warn.join()).toContain("401");
  });
});

describe("runVerification: database + worker liveness (PGlite)", () => {
  it("detects a missing indexer cursor and stuck submissions, passes when healthy", async () => {
    const db = await createTestDb();
    const nowSec = 1_800_000_000;
    const deps = { publicClient: { getChainId: async () => 42220 } as never, fetch: (async () => new Response("", { status: 500 })) as typeof fetch, db, nowSec };
    let rs = await runVerification({}, deps);
    expect(status(rs, "migrations")).toBe("PASS");
    expect(status(rs, "indexer cursor")).toBe("FAIL");
    expect(status(rs, "relay queue")).toBe("PASS");
    expect(status(rs, "PUBLIC_BASE_URL")).toBe("SKIP");

    const [m] = await db.insert(merchants).values({ telegramUserId: 1n, telegramChatId: 1n, country: "AR", currency: "ARS", settlementToken: CELO.permit2.address, payoutAddress: AGENT, staticSlug: "k" }).returning();
    const id = `0x${"11".repeat(32)}`;
    await db.insert(invoices).values({ id, merchantId: m!.id, amountLocal: "1", currency: "ARS", tokenOut: CELO.permit2.address, amountOut: "1", merchantAddress: AGENT, expiresAt: new Date((nowSec + 600) * 1000) });
    await db.insert(submissions).values({ invoiceId: id, payer: AGENT, legs: [], updatedAt: new Date((nowSec - 3600) * 1000) });
    await db.insert(chainCursor).values({ id: "router_paid", blockNumber: 100n, updatedAt: new Date((nowSec - 30) * 1000) });
    rs = await runVerification({}, deps);
    expect(status(rs, "indexer cursor")).toBe("PASS");
    expect(status(rs, "relay queue")).toBe("FAIL");
  });
});

const ready = hasAnvil && existsSync(ROUTER_ARTIFACT_PATH);
describe.skipIf(!ready)("runVerification: router checks against a tagged deployment (anvil, chain id 42220)", () => {
  let a: Anvil;
  beforeAll(async () => {
    a = await startAnvil(42220);
  });
  afterAll(async () => a?.stop());

  it("passes bytecode, immutables, EIP-712 domain and ERC-8021 tag; fails a wrong deploy block", async () => {
    const d = createRouterDeployer({
      privateKey: ANVIL_KEYS.deployer, rpcUrl: a.url, attributionCode: HACKATHON_ATTRIBUTION_CODE,
      artifact: loadRouterArtifact(), chain: { ...celo, rpcUrls: { default: { http: [a.url] } } }, transport: http(a.url),
    });
    const hash = await d.deploy(CELO.permit2.address, CELO.uniswapV3.swapRouter.address);
    const rc = await a.publicClient.waitForTransactionReceipt({ hash });
    const env = { ROUTER_ADDRESS: rc.contractAddress as Address, ROUTER_DEPLOY_TX: hash as Hash, ROUTER_DEPLOY_BLOCK: String(rc.blockNumber), AGENT_ADDRESS: AGENT };
    const deps = { publicClient: a.publicClient, fetch, nowSec: 0 };

    const rs = await runVerification(env, deps);
    for (const n of ["RPC chain id", "bytecode", "immutables", "EIP-712 domain", "deployment tx tagged (ERC-8021)"]) expect(status(rs, n), n).toBe("PASS");
    expect(status(rs, "ERC-8004 registered")).toBe("FAIL"); // no registry on a bare anvil

    const wrong = await runVerification({ ...env, ROUTER_DEPLOY_BLOCK: "999999" }, deps);
    expect(status(wrong, "deployment tx tagged (ERC-8021)")).toBe("FAIL");
  });
});

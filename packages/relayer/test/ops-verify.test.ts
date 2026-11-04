import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { http, type Address, type Hash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { CELO, HACKATHON_ATTRIBUTION_CODE, TEXTILE_REACTOR_CELO } from "@cobra/shared";
import { createTestDb } from "@cobra/db/testing";
import { chainCursor, submissions, invoices, merchants } from "@cobra/db";
import { ROUTER_ARTIFACT_PATH, ROUTER_V2_ARTIFACT_PATH, createRouterDeployer, loadRouterArtifact } from "../src/deploy";
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

describe("runVerification: legacy router pairing (no chain needed)", () => {
  const deps = { publicClient: { getChainId: async () => 42220 } as never, fetch: (async () => new Response("", { status: 500 })) as typeof fetch, nowSec: 0 };
  it("skips when unset, fails when only one of address / block is set", async () => {
    expect(status(await runVerification({}, deps), "LEGACY_ROUTER_ADDRESS")).toBe("SKIP");
    expect(status(await runVerification({ LEGACY_ROUTER_ADDRESS: AGENT }, deps), "LEGACY_ROUTER_ADDRESS")).toBe("FAIL");
    expect(status(await runVerification({ LEGACY_ROUTER_DEPLOY_BLOCK: "5" }, deps), "LEGACY_ROUTER_ADDRESS")).toBe("FAIL");
    expect(status(await runVerification({ LEGACY_ROUTER_ADDRESS: AGENT, LEGACY_ROUTER_DEPLOY_BLOCK: "x" }, deps), "LEGACY_ROUTER_ADDRESS")).toBe("FAIL");
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

const readyV2 = ready && existsSync(ROUTER_V2_ARTIFACT_PATH);
describe.skipIf(!readyV2)("runVerification: v1 / v2 detection and legacy router (anvil, chain id 42220)", () => {
  let a: Anvil;
  let v1: Address;
  let v2: Address;
  const deps = () => ({ publicClient: a.publicClient, fetch, nowSec: 0 });
  const find = (rs: CheckResult[], group: string, name: string) => rs.find((r) => r.group === group && r.name === name);
  beforeAll(async () => {
    a = await startAnvil(42220);
    const mk = (path: string) => createRouterDeployer({
      privateKey: ANVIL_KEYS.deployer, rpcUrl: a.url, attributionCode: HACKATHON_ATTRIBUTION_CODE,
      artifact: loadRouterArtifact(path), chain: { ...celo, rpcUrls: { default: { http: [a.url] } } }, transport: http(a.url),
    });
    const h1 = await mk(ROUTER_ARTIFACT_PATH).deploy(CELO.permit2.address, CELO.uniswapV3.swapRouter.address);
    v1 = (await a.publicClient.waitForTransactionReceipt({ hash: h1 })).contractAddress as Address;
    const h2 = await mk(ROUTER_V2_ARTIFACT_PATH).deployV2(CELO.permit2.address, CELO.uniswapV3.swapRouter.address, TEXTILE_REACTOR_CELO);
    v2 = (await a.publicClient.waitForTransactionReceipt({ hash: h2 })).contractAddress as Address;
  });
  afterAll(async () => a?.stop());

  it("v1 alone passes, but fails once Textile is configured", async () => {
    expect(find(await runVerification({ ROUTER_ADDRESS: v1 }, deps()), "router", "version (Textile reactor)")?.status).toBe("PASS");
    const r = find(await runVerification({ ROUTER_ADDRESS: v1, TEXTILE_API_KEY: "tk_fake_123" }, deps()), "router", "version (Textile reactor)");
    expect(r?.status).toBe("FAIL");
    expect(r?.detail).not.toContain("tk_fake_123"); // the key itself is never printed
    expect(find(await runVerification({ ROUTER_ADDRESS: v1, TEXTILE_API_KEY: "k", TEXTILE_ENABLED: "false" }, deps()), "router", "version (Textile reactor)")?.status).toBe("PASS");
  });

  it("v2 checks the reactor, warns without legacy, passes with the v1 as legacy", async () => {
    const alone = await runVerification({ ROUTER_ADDRESS: v2 }, deps());
    for (const n of ["bytecode", "immutables", "EIP-712 domain"]) expect(find(alone, "router", n)?.status, n).toBe("PASS");
    expect(find(alone, "router", "version (Textile reactor)")?.status).toBe("WARN");

    const rs = await runVerification({ ROUTER_ADDRESS: v2, TEXTILE_API_KEY: "k", LEGACY_ROUTER_ADDRESS: v1, LEGACY_ROUTER_DEPLOY_BLOCK: "1" }, deps());
    expect(find(rs, "router", "version (Textile reactor)")?.status).toBe("PASS");
    for (const n of ["LEGACY_ROUTER_ADDRESS", "bytecode", "immutables", "EIP-712 domain", "legacy is v1"]) expect(find(rs, "legacy router", n)?.status, n).toBe("PASS");
  });

  it("flags a legacy equal to the router, and a v2 given as legacy", async () => {
    const same = await runVerification({ ROUTER_ADDRESS: v2, LEGACY_ROUTER_ADDRESS: v2, LEGACY_ROUTER_DEPLOY_BLOCK: "1" }, deps());
    expect(find(same, "legacy router", "LEGACY_ROUTER_ADDRESS")?.status).toBe("FAIL");
    expect(find(same, "legacy router", "legacy is v1")?.status).toBe("WARN");
  });
});

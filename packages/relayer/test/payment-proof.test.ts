import { toDataSuffix } from "@celo/attribution-tags";
import { getAddress, pad, toHex, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { HACKATHON_ATTRIBUTION_CODE } from "@cobra/shared";
import { hasAttribution, isTeamWallet, judgePaymentTx, MAINNET_PROOF_DEFAULTS, TEAM_WALLETS, transferred } from "../src/payment-proof";
import { replaceUsageBlock, usageMarkdown, usageSummary } from "../src/payment-proof-cli";

const router = MAINNET_PROOF_DEFAULTS.routers[1].address;
const agent = MAINNET_PROOF_DEFAULTS.agent;
const payer = getAddress("0x00000000000000000000000000000000000000aa");
const merchant = getAddress("0x00000000000000000000000000000000000000bb");
const wARS = getAddress("0x0dc4f92879b7670e5f4e4e6e3c801d229129d90d");
const call = "0xdeadbeef" as const;
const tagged = `${call}${toDataSuffix(HACKATHON_ATTRIBUTION_CODE).slice(2)}` as Hex;
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as Hex;
const log = (token: Address, from: Address, to: Address, v: bigint) => ({ address: token, topics: [TRANSFER, pad(from), pad(to)] as Hex[], data: toHex(v, { size: 32 }) });
const paid = { merchant, payer, tokenOut: wARS, amountOut: 100n };
const ok = { status: "success" as const };

describe("payment proof", () => {
  it("detects the ERC-8021 code", () => {
    expect(hasAttribution(tagged)).toBe(true);
    expect(hasAttribution(call)).toBe(false);
    expect(hasAttribution(tagged, "celo_other")).toBe(false);
  });
  it("PASS when relayed by the agent to the router, tagged", () => {
    expect(judgePaymentTx({ from: agent, to: router, input: tagged }, ok, { router, agent }).status).toBe("PASS");
  });
  it("WARN when the payer sent it (fallback mode)", () => {
    expect(judgePaymentTx({ from: payer, to: router, input: tagged }, ok, { router, agent }).status).toBe("WARN");
  });
  it("FAIL when untagged, reverted or not calling the router", () => {
    expect(judgePaymentTx({ from: agent, to: router, input: call }, ok, { router, agent }).status).toBe("FAIL");
    expect(judgePaymentTx({ from: agent, to: router, input: tagged }, { status: "reverted" }, { router, agent }).status).toBe("FAIL");
    expect(judgePaymentTx({ from: agent, to: payer, input: tagged }, ok, { router, agent }).detail).toMatch(/not the router/);
  });
  it("checks the exact Transfer to the merchant and reports the refund", () => {
    const logs = [log(wARS, router, merchant, 100n), log(wARS, router, payer, 7n), log(wARS, payer, merchant, 999n)];
    const v = judgePaymentTx({ from: agent, to: router, input: tagged }, { ...ok, logs }, { router, agent, paid });
    expect(v).toMatchObject({ status: "PASS", refunded: 7n });
    expect(v.detail).toMatch(/exact amount/);
    const short = judgePaymentTx({ from: agent, to: router, input: tagged }, { ...ok, logs: [log(wARS, router, merchant, 99n)] }, { router, agent, paid });
    expect(short.status).toBe("FAIL");
    expect(short.detail).toMatch(/merchant received 99, Paid says 100/);
    expect(transferred(logs, wARS, payer, merchant)).toBe(999n);
  });
  it("labels team wallets and counts only distinct real merchants and payers", () => {
    expect(isTeamWallet(getAddress(TEAM_WALLETS[0]!))).toBe(true);
    expect(isTeamWallet(payer)).toBe(false);
    const row = (p: string, m: string, team: boolean, status: "PASS" | "FAIL" = "PASS") =>
      ({ router: "v2", txHash: `0x${"1".repeat(64)}`, blockNumber: 1n, invoiceId: "0x", merchant: m, payer: p, tokenOut: wARS, amountOut: 10n ** 20n, refunded: 0n, team, status, detail: "", date: "2026-11-06 12:00" }) as never;
    const rows = [row(TEAM_WALLETS[0]!, TEAM_WALLETS[1]!, true), row(payer, merchant, false), row(payer, merchant, false), row(merchant, payer, false), row(payer, payer, false, "FAIL")];
    expect(usageSummary(rows)).toEqual({ payments: 5, teamTests: 1, realPayments: 3, realMerchants: 2, realPayers: 2 });
    const md = usageMarkdown(rows);
    expect(md).toMatch(/^\*\*2 merchants, 2 distinct payer wallets, 3 real payments\*\* \(plus 1 team test/);
    expect(md).toContain("| 100 wARS |");
    expect(md).toContain("| team test |");
  });
  it("rewrites only the README block between the markers, idempotently", () => {
    const readme = "# T\n<!-- usage:start (x) -->\nold\n<!-- usage:end -->\nrest\n";
    const once = replaceUsageBlock(readme, "NEW");
    expect(once).toBe("# T\n<!-- usage:start (x) -->\nNEW\n<!-- usage:end -->\nrest\n");
    expect(replaceUsageBlock(once, "NEW")).toBe(once);
    expect(() => replaceUsageBlock("# no markers", "x")).toThrow(/markers/);
  });
});

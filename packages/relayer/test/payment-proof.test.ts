import { toDataSuffix } from "@celo/attribution-tags";
import { describe, expect, it } from "vitest";
import { HACKATHON_ATTRIBUTION_CODE } from "@cobra/shared";
import { hasAttribution, judgePaymentTx, MAINNET_PROOF_DEFAULTS } from "../src/payment-proof";

const router = MAINNET_PROOF_DEFAULTS.routers[1].address;
const agent = MAINNET_PROOF_DEFAULTS.agent;
const payer = "0x00000000000000000000000000000000000000aa";
const call = "0xdeadbeef" as const;
const tagged = `${call}${toDataSuffix(HACKATHON_ATTRIBUTION_CODE).slice(2)}` as `0x${string}`;
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
});

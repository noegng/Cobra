import { describe, expect, it } from "vitest";
import { signDashboardToken, verifyDashboardToken } from "../src/dashboard-token";

const SECRET = "x".repeat(40);
const MID = "3f1e7a52-8d3b-4a5e-9c1d-2b7f6e8a9c01";

describe("dashboard token", () => {
  it("round-trips, expires, rejects tampering and wrong secret", () => {
    const now = 1_800_000_000_000;
    const t = signDashboardToken({ merchantId: MID, now }, SECRET);
    expect(verifyDashboardToken(t, SECRET, now)).toEqual({ merchantId: MID, exp: now / 1000 + 900 });
    expect(verifyDashboardToken(t, SECRET, now + 901_000)).toBeNull();
    expect(verifyDashboardToken(t, "y".repeat(40), now)).toBeNull();
    const [, s] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ v: 1, m: MID, exp: now / 1000 + 80_000 })).toString("base64url");
    expect(verifyDashboardToken(`${forged}.${s}`, SECRET, now)).toBeNull();
    expect(verifyDashboardToken(null, SECRET, now)).toBeNull();
    expect(() => signDashboardToken({ merchantId: MID }, "short")).toThrow();
  });
});

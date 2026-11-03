import { describe, expect, it } from "vitest";
import { verifyMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { eq } from "drizzle-orm";
import { flags, merchants } from "@cobra/db";
import { VERIFY_NONCE_TTL_MS } from "../lib/verify-core";
import { checkSignature, issueNonce, isVerified, type VerifyDeps } from "../lib/server/verify-server";
import { OTHER_KEY, setup } from "./helpers";

// anvil public test key #2 = MERCHANT_PAYOUT (0x3C44...)
const MERCHANT_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as const;
const merchantAcc = privateKeyToAccount(MERCHANT_KEY);
const otherAcc = privateKeyToAccount(OTHER_KEY);
const DOMAIN = "cobra.example";

async function mk() {
  const f = await setup();
  const clock = { now: 1_800_000_000_000 };
  const deps: VerifyDeps = {
    db: f.db,
    now: () => clock.now,
    verifyMessage: (a) => verifyMessage({ ...a }),
  };
  return { f, deps, clock };
}

describe("wallet ownership proof", () => {
  it("accepts the payout address signature, once, and marks the merchant", async () => {
    const { f, deps } = await mk();
    const r = (await issueNonce(deps, "cafe-luna", DOMAIN))!;
    expect(r.message).toContain("cafe-luna");
    expect(r.message).toContain(r.payoutAddress);
    expect(r.message).toContain(DOMAIN);
    expect(r.message).toContain(r.nonce);
    const signature = await merchantAcc.signMessage({ message: r.message });
    expect(await checkSignature(deps, "cafe-luna", DOMAIN, r.nonce, signature)).toBe("ok");
    expect(await isVerified(f.db, f.merchantId, r.payoutAddress)).toBe(true);
    const [m] = await f.db.select().from(merchants).where(eq(merchants.id, f.merchantId));
    expect(m!.payoutAddressProven).toBe(1);
    // single use
    expect(await checkSignature(deps, "cafe-luna", DOMAIN, r.nonce, signature)).toBe("nonce_invalid");
  });

  it("rejects another signer and burns the nonce", async () => {
    const { f, deps } = await mk();
    const r = (await issueNonce(deps, "cafe-luna", DOMAIN))!;
    const bad = await otherAcc.signMessage({ message: r.message });
    expect(await checkSignature(deps, "cafe-luna", DOMAIN, r.nonce, bad)).toBe("bad_signature");
    expect(await isVerified(f.db, f.merchantId, r.payoutAddress)).toBe(false);
    const good = await merchantAcc.signMessage({ message: r.message });
    expect(await checkSignature(deps, "cafe-luna", DOMAIN, r.nonce, good)).toBe("nonce_invalid");
  });

  it("rejects an expired nonce, a wrong domain and malformed input", async () => {
    const { deps, clock } = await mk();
    const r = (await issueNonce(deps, "cafe-luna", DOMAIN))!;
    const sig = await merchantAcc.signMessage({ message: r.message });
    expect(await checkSignature(deps, "cafe-luna", "evil.example", r.nonce, sig)).toBe("bad_signature");

    const r2 = (await issueNonce(deps, "cafe-luna", DOMAIN))!;
    const sig2 = await merchantAcc.signMessage({ message: r2.message });
    clock.now += VERIFY_NONCE_TTL_MS + 1;
    expect(await checkSignature(deps, "cafe-luna", DOMAIN, r2.nonce, sig2)).toBe("nonce_invalid");

    expect(await checkSignature(deps, "cafe-luna", DOMAIN, "nope", sig2)).toBe("bad_request");
    expect(await checkSignature(deps, "cafe-luna", DOMAIN, r2.nonce, "zz")).toBe("bad_request");
    expect(await checkSignature(deps, "unknown", DOMAIN, r2.nonce, sig2)).toBe("not_found");
    expect(await issueNonce(deps, "unknown", DOMAIN)).toBeNull();
  });

  it("a smart-wallet style verifier (ERC-1271) is just the injected verifyMessage", async () => {
    const { f, deps } = await mk();
    const r = (await issueNonce(deps, "cafe-luna", DOMAIN))!;
    const seen: string[] = [];
    const d2: VerifyDeps = { ...deps, verifyMessage: async (a) => (seen.push(a.address), true) };
    expect(await checkSignature(d2, "cafe-luna", DOMAIN, r.nonce, "0x1234")).toBe("ok");
    expect(seen).toEqual([r.payoutAddress]);
    const rows = await f.db.select().from(flags);
    expect(rows.some((x) => x.key.startsWith("merchant_verified:"))).toBe(true);
    expect(rows.some((x) => x.key.startsWith("verify_nonce:"))).toBe(false);
  });
});

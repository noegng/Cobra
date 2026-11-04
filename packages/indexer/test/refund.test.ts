import { describe, expect, it } from "vitest";
import { pad, toEventSelector, type Address, type Hex } from "viem";
import { payments } from "@cobra/db";
import { applyBatch } from "../src/index";
import { fetchRefundedOut } from "../src/refund";
import { MERCHANT, OTHER, PAYER, WARS, freshDb, seedInvoice, seedMerchant } from "./helpers";

const ROUTER: Address = "0x00000000000000000000000000000000000000a1";
const TX: Hex = `0x${"cd".repeat(32)}`;
const TRANSFER = toEventSelector("Transfer(address,address,uint256)");
const t = (a: Address) => pad(a.toLowerCase() as Hex, { size: 32 });
const word = (n: bigint) => pad(`0x${n.toString(16)}` as Hex, { size: 32 });
const transfer = (token: Address, from: Address, to: Address, v: bigint) => ({ address: token, topics: [TRANSFER, t(from), t(to)], data: word(v) });
const P = { txHash: TX, tokenOut: WARS, router: ROUTER, payer: PAYER };
const clientWith = (r: unknown) => ({ getTransactionReceipt: async () => r }) as never;

describe("fetchRefundedOut", () => {
  it("sums router -> payer transfers of tokenOut only", async () => {
    const logs = [
      transfer(WARS, ROUTER, PAYER, 7n),
      transfer(WARS, ROUTER, PAYER, 5n),
      transfer(WARS, ROUTER, MERCHANT, 1000n), // the merchant payment, not a refund
      transfer(WARS, OTHER, PAYER, 99n), // not from the router
      transfer(OTHER, ROUTER, PAYER, 99n), // another token
    ];
    expect(await fetchRefundedOut(clientWith({ status: "success", logs }), P)).toBe(12n);
  });
  it("0 when there is no refund", async () => {
    expect(await fetchRefundedOut(clientWith({ status: "success", logs: [transfer(WARS, ROUTER, MERCHANT, 1n)] }), P)).toBe(0n);
  });
  it("null on receipt error or missing receipt", async () => {
    const boom = { getTransactionReceipt: async () => { throw new Error("rpc down"); } } as never;
    expect(await fetchRefundedOut(boom, P)).toBeNull();
    expect(await fetchRefundedOut(clientWith(null), P)).toBeNull();
  });
});

describe("refunded_out stored on the payment", () => {
  for (const [name, refunded, expected] of [["refund", 12n, "12"], ["none", 0n, "0"], ["unknown", null, null]] as const) {
    it(`${name} -> ${expected}`, async () => {
      const db = await freshDb();
      const m = await seedMerchant(db);
      const inv = await seedInvoice(db, m.id);
      const log = { invoiceId: inv.id as Hex, payer: PAYER, merchant: MERCHANT, tokenOut: WARS, amountOut: BigInt(inv.amountOut), txHash: TX, logIndex: 0, blockNumber: 1n, blockTimestamp: 1_800_000_000n, refundedOut: refunded };
      const res = await applyBatch(db, [log], 1n, 2n, () => {});
      expect(res.outcomes[0]!.kind).toBe("paid"); // never blocked by a missing refund
      const [p] = await db.select().from(payments);
      expect(p!.refundedOut).toBe(expected);
    });
  }
});

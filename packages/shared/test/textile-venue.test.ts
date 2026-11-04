import { describe, expect, it } from "vitest";
import { keccak256 } from "viem";
import { TOKENS } from "../src/tokens";
import { decodeTextileVenue, encodeTextileVenue, isTextileVenue, TEXTILE_VENUE_MAGIC } from "../src/textile-venue";
import { encodePath } from "../src/path";

const orders = [
  { order: "0x1234" as const, sig: "0xabcdef" as const },
  { order: "0x" as const, sig: "0x01" as const },
];

describe("textile venue codec", () => {
  it("round-trips and starts with the magic", () => {
    const p = encodeTextileVenue(orders);
    expect(p.slice(0, 10)).toBe(TEXTILE_VENUE_MAGIC);
    expect(isTextileVenue(p)).toBe(true);
    expect(decodeTextileVenue(p)).toEqual(orders);
    expect(keccak256(p)).not.toBe(keccak256(encodeTextileVenue([orders[0]!])));
  });

  it("is never confused with a Uniswap path or an empty path", () => {
    expect(isTextileVenue("0x")).toBe(false);
    for (const t of TOKENS) expect(t.address.slice(0, 10).toLowerCase()).not.toBe(TEXTILE_VENUE_MAGIC);
    const [a, b] = TOKENS;
    expect(isTextileVenue(encodePath([a!.address, b!.address], [100]))).toBe(false);
  });

  it("refuses an empty order list", () => {
    expect(() => encodeTextileVenue([])).toThrow();
  });
});

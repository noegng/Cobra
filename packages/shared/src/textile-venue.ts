/**
 * Textile FX RFQ venue for CobraRouter v2 (docs/interfaces.md §7).
 *
 * A Textile leg keeps the frozen `Leg` / `LegCommitment` shape. Only the `path` bytes change:
 *   path = TEXTILE_VENUE_MAGIC (4 bytes, "TXF1") ++ abi.encode((bytes order, bytes sig)[] signedOrders)
 * Each SignedOrder is one Textile maker order (UniswapX LimitOrder bytes + maker signature), exactly as returned in
 * `quote.orders[].encodedOrder` / `.signature` by POST /v2/rfq/request, with taker = the v2 router.
 * The payer's EIP-712 signature commits to keccak256(path), so it commits to these exact orders.
 * A Uniswap V3 path starts with a token address; no token in the registry starts with the magic bytes.
 */
import { concatHex, decodeAbiParameters, encodeAbiParameters, size, sliceHex, type Hex } from "viem";

export const TEXTILE_VENUE_MAGIC = "0x54584631" as const; // "TXF1"

/** Textile's UniswapX LimitOrderReactor on Celo mainnet (observed settling Textile quotes; confirm before deploy). */
export const TEXTILE_REACTOR_CELO = "0xa9aa0a64769cbed4d3b1ceb4df01cde915c235b3" as const;

export interface TextileSignedOrder {
  /** Encoded UniswapX LimitOrder (`encodedOrder` in the Textile quote). */
  order: Hex;
  /** Maker signature over the order (`signature` in the Textile quote). */
  sig: Hex;
}

const SIGNED_ORDERS = [
  {
    type: "tuple[]",
    components: [
      { name: "order", type: "bytes" },
      { name: "sig", type: "bytes" },
    ],
  },
] as const;

export function encodeTextileVenue(orders: readonly TextileSignedOrder[]): Hex {
  if (orders.length === 0) throw new Error("textile venue needs at least one order");
  return concatHex([TEXTILE_VENUE_MAGIC, encodeAbiParameters(SIGNED_ORDERS, [orders.map((o) => ({ order: o.order, sig: o.sig }))])]);
}

export function isTextileVenue(path: Hex): boolean {
  return size(path) > 4 && sliceHex(path, 0, 4).toLowerCase() === TEXTILE_VENUE_MAGIC;
}

export function decodeTextileVenue(path: Hex): TextileSignedOrder[] {
  if (!isTextileVenue(path)) throw new Error("not a textile venue");
  const [orders] = decodeAbiParameters(SIGNED_ORDERS, sliceHex(path, 4));
  if (orders.length === 0) throw new Error("textile venue needs at least one order");
  return orders.map((o) => ({ order: o.order, sig: o.sig }));
}

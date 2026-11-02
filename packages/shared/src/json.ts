/**
 * JSON (de)serialization for values stored in jsonb columns (bigint -> decimal string).
 * FROZEN: `submissions.legs`, `payments.legs` use SerializedLeg[]; `quotes.plan` uses SerializedPlan.
 */
import { getAddress, isHex, type Hex } from "viem";
import type { Leg, PaymentPlan, PlannedLeg, PullKind } from "./types";

export interface SerializedLeg {
  token: string;
  amountIn: string;
  kind: number;
  pullData: string;
  path: string;
}
export type SerializedPlannedLeg = Omit<SerializedLeg, "pullData"> & { quotedOut: string };
export type SerializedPlan = Omit<PaymentPlan, "legs" | "minOut"> & { legs: SerializedPlannedLeg[]; minOut: string };

const hex = (s: string): Hex => {
  if (!isHex(s)) throw new Error(`not hex: ${s}`);
  return s;
};
const kind = (k: number): PullKind => {
  if (k !== 0 && k !== 1 && k !== 2) throw new Error(`bad PullKind ${k}`);
  return k;
};

export const serializeLeg = (l: Leg): SerializedLeg => ({
  token: l.token, amountIn: l.amountIn.toString(), kind: l.kind, pullData: l.pullData, path: l.path,
});
export const deserializeLeg = (l: SerializedLeg): Leg => ({
  token: getAddress(l.token), amountIn: BigInt(l.amountIn), kind: kind(l.kind), pullData: hex(l.pullData), path: hex(l.path),
});

export const serializePlan = (p: PaymentPlan): SerializedPlan => ({
  ...p,
  minOut: p.minOut.toString(),
  legs: p.legs.map((l) => ({ token: l.token, amountIn: l.amountIn.toString(), kind: l.kind, path: l.path, quotedOut: l.quotedOut.toString() })),
});
export const deserializePlan = (p: SerializedPlan): PaymentPlan => ({
  ...p,
  tokenOut: getAddress(p.tokenOut),
  minOut: BigInt(p.minOut),
  legs: p.legs.map(
    (l): PlannedLeg => ({ token: getAddress(l.token), amountIn: BigInt(l.amountIn), kind: kind(l.kind), path: hex(l.path), quotedOut: BigInt(l.quotedOut) }),
  ),
});

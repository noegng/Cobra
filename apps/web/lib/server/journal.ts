/**
 * Agent decision journal (public). Derived ONLY from existing data: payments (+ the submission's quote plan),
 * gas-grant flags, reminder / daily-close / failed-submission counters. No schema change, no writer change.
 *
 * Privacy: never selects invoice descriptions, references, merchant names, Telegram ids or merchant addresses.
 * Money stays as base-unit integer strings; formatting is bigint-only (`formatUnits`).
 */
import { and, desc, eq, gte, inArray, isNotNull, like } from "drizzle-orm";
import { getAddress, isHex } from "viem";
import { decodePath, explorerAddress, isTextileVenue, explorerTx, tokenByAddress, type SerializedLeg, type SerializedPlan } from "@cobra/shared";
import { flags, invoices, payments, quotes, submissions, type Db } from "@cobra/db";
import { formatUnits } from "../amount";

/** The relayer wallet (ERC-8004 agent) and the ERC-8021 attribution tag its transactions carry. */
export const AGENT_WALLET = "0x9E828B877EFCdb79B507fF6234d841A8265Cccd5";
export const ERC8021_TAG = "celo_502e1bea2794";
const GAS_GRANT_PREFIX = "gas_grant:";
const DAILY_CLOSE_PREFIX = "daily_close:";

export type PullKindName = "eip3009" | "permit2" | "allowance";
const KIND_NAMES: PullKindName[] = ["eip3009", "permit2", "allowance"];

export interface JournalLeg {
  tokenIn: string;
  symbolIn: string;
  decimalsIn: number;
  amountIn: string;
  kind: PullKindName | null;
  /** Token symbols along the path, e.g. ["USDT","wARS"]. */
  hops: string[];
  /** Uniswap V3 fee tiers in hundredths of a bp (100 = 0.01 %). */
  fees: number[];
  quotedOut: string | null;
  /** Venue that settled the leg: Textile FX RFQ (path carries the signed orders) or Uniswap V3 (default). */
  venue: "textile" | "uniswap_v3";
}

export interface RouteEntry {
  type: "route";
  at: string;
  txHash: string;
  explorerUrl: string;
  payer: string;
  tokenOut: string;
  symbolOut: string;
  decimalsOut: number;
  /** Exact amount delivered to the merchant (base units). */
  amountOut: string;
  /** Fiat amount of the invoice (not private: amount + currency only). */
  amountLocal: string | null;
  currency: string | null;
  legs: JournalLeg[];
  /** "textile" when any leg was settled by a Textile RFQ, else "uniswap_v3". */
  venue: "textile" | "uniswap_v3";
  legCount: number;
  split: boolean;
  /** Sum of quoted leg outputs minus amountOut, when positive: what the quote expected to refund to the payer (estimate, not the on-chain refund). */
  quotedSurplus: string | null;
  costBps: number | null;
  savingsBps: number | null;
  relayed: boolean;
  sender: string | null;
  attributionTag: string | null;
}

export interface GasGrantEntry {
  type: "gas_grant";
  at: string;
  txHash: string;
  explorerUrl: string;
  to: string;
  /** Wei of CELO. */
  value: string;
  sender: string;
  attributionTag: string;
  purpose: "permit2_approval";
}

export type JournalEntry = RouteEntry | GasGrantEntry;

export interface JournalDay {
  date: string; // yyyy-mm-dd (UTC for failures/reminders, merchant-local for closes)
  remindersSent: number;
  dailyCloses: number;
  /** Submissions the agent refused or that failed (price guard, caps, self-payment, revert...). Reasons are not exposed. */
  failedSubmissions: number;
}

export interface Journal {
  agent: { address: string; attributionTag: string };
  entries: JournalEntry[];
  days: JournalDay[];
}

// ---------- pure helpers ----------

const tokenMeta = (addr: string) => {
  const t = tokenByAddress(addr);
  return { symbol: t?.symbol ?? `${addr.slice(0, 6)}…${addr.slice(-4)}`, decimals: t?.decimals ?? 18 };
};

export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** 100 -> "0.01", 500 -> "0.05", 3000 -> "0.3", 10000 -> "1" (percent), integer arithmetic only. */
export function feeTierLabel(fee: number): string {
  const whole = Math.floor(fee / 10_000);
  const frac = String(fee % 10_000).padStart(4, "0").replace(/0+$/, "");
  return frac === "" ? String(whole) : `${whole}.${frac}`;
}

/** 12 -> "0.12", 250 -> "2.50" (percent of output value), integer arithmetic only. */
export function bpsPercent(bps: number, locale = "en"): string {
  const sign = bps < 0 ? "-" : "";
  const a = Math.abs(Math.round(bps));
  const sep = (1.5).toLocaleString(locale).charAt(1) || ".";
  return `${sign}${Math.floor(a / 100)}${sep}${String(a % 100).padStart(2, "0")}`;
}

export function legsFromJson(raw: unknown, tokenOut?: string): JournalLeg[] {
  if (!Array.isArray(raw)) return [];
  const out: JournalLeg[] = [];
  for (const l of raw as (Partial<SerializedLeg> & { quotedOut?: string })[]) {
    if (!l || typeof l.token !== "string" || typeof l.amountIn !== "string" || !/^\d+$/.test(l.amountIn)) continue;
    let hops: string[] = [];
    let fees: number[] = [];
    let venue: JournalLeg["venue"] = "uniswap_v3";
    if (typeof l.path === "string" && isHex(l.path) && isTextileVenue(l.path)) {
      venue = "textile";
      hops = [tokenMeta(l.token).symbol, ...(tokenOut ? [tokenMeta(tokenOut).symbol] : [])];
    } else if (typeof l.path === "string" && isHex(l.path)) {
      try {
        const p = decodePath(l.path);
        hops = p.tokens.map((t) => tokenMeta(t).symbol);
        fees = p.fees;
      } catch {
        /* unknown path shape: show no hops */
      }
    }
    const m = tokenMeta(l.token);
    out.push({
      tokenIn: l.token,
      symbolIn: m.symbol,
      decimalsIn: m.decimals,
      amountIn: l.amountIn,
      kind: typeof l.kind === "number" ? (KIND_NAMES[l.kind] ?? null) : null,
      hops,
      fees,
      quotedOut: typeof l.quotedOut === "string" && /^\d+$/.test(l.quotedOut) ? l.quotedOut : null,
      venue,
    });
  }
  return out;
}

export interface PaymentRow {
  txHash: string;
  payer: string;
  tokenOut: string;
  amountOut: string;
  paidAt: Date;
  costBps: number | null;
  savingsBps: number | null;
  paymentLegs: unknown;
  plan: unknown;
  amountLocal: string | null;
  currency: string | null;
}

export function routeEntry(r: PaymentRow, agent = AGENT_WALLET): RouteEntry {
  const plan = (r.plan ?? null) as SerializedPlan | null;
  // Prefer the quote's plan (carries quotedOut); fall back to the legs copied onto the payment.
  let legs = legsFromJson(plan?.legs, r.tokenOut);
  if (legs.length === 0) legs = legsFromJson(r.paymentLegs, r.tokenOut);
  const relayed = r.paymentLegs != null;
  const quoted = legs.length > 0 && legs.every((l) => l.quotedOut != null) ? legs.reduce((s, l) => s + BigInt(l.quotedOut!), 0n) : null;
  const surplus = quoted != null && quoted > BigInt(r.amountOut) ? quoted - BigInt(r.amountOut) : null;
  const out = tokenMeta(r.tokenOut);
  return {
    type: "route",
    at: r.paidAt.toISOString(),
    txHash: r.txHash,
    explorerUrl: explorerTx(r.txHash),
    payer: r.payer,
    tokenOut: r.tokenOut,
    symbolOut: out.symbol,
    decimalsOut: out.decimals,
    amountOut: r.amountOut,
    amountLocal: r.amountLocal,
    currency: r.currency,
    legs,
    venue: legs.some((l) => l.venue === "textile") ? "textile" : "uniswap_v3",
    legCount: legs.length,
    split: legs.length > 1,
    quotedSurplus: surplus == null ? null : surplus.toString(),
    costBps: r.costBps,
    savingsBps: r.savingsBps,
    relayed,
    sender: relayed ? agent : null,
    attributionTag: relayed ? ERC8021_TAG : null,
  };
}

/** "USDT → wARS · Uniswap V3 0.01 %" (one hop-chain per leg, joined with " + " when split). */
export function describeRoute(legs: JournalLeg[]): string {
  return legs
    .map((l) => {
      const hops = l.hops.length ? l.hops.join(" → ") : l.symbolIn;
      if (l.venue === "textile") return `${hops} · Textile RFQ`;
      const fees = [...new Set(l.fees.map(feeTierLabel))].join("/");
      return fees ? `${hops} · Uniswap V3 ${fees} %` : hops;
    })
    .join(" + ");
}

export function fmtAmount(amount: string, decimals: number, locale: string, maxFraction = 6): string {
  const out = formatUnits(amount, decimals, locale, maxFraction);
  const sep = (1.5).toLocaleString(locale).charAt(1) || ".";
  return out.includes(sep) ? out.replace(/0+$/, "").replace(new RegExp(`\\${sep}$`), "") : out;
}

export function grantEntry(key: string, value: unknown, updatedAt: Date, agent = AGENT_WALLET): GasGrantEntry | null {
  const v = value as { status?: string; value?: string; txHash?: string } | null;
  if (!v || v.status !== "sent" || typeof v.txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(v.txHash)) return null;
  if (typeof v.value !== "string" || !/^\d+$/.test(v.value)) return null;
  let to: string;
  try {
    to = getAddress(key.slice(GAS_GRANT_PREFIX.length));
  } catch {
    return null;
  }
  return {
    type: "gas_grant",
    at: updatedAt.toISOString(),
    txHash: v.txHash,
    explorerUrl: explorerTx(v.txHash),
    to,
    value: v.value,
    sender: agent,
    attributionTag: ERC8021_TAG,
    purpose: "permit2_approval",
  };
}

const day = (d: Date) => d.toISOString().slice(0, 10);

// ---------- query ----------

export async function queryJournal(db: Db, opts: { now?: Date; limit?: number; days?: number; agentAddress?: string | null } = {}): Promise<Journal> {
  const now = opts.now ?? new Date();
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50) || 50, 1), 200);
  const nDays = Math.min(Math.max(opts.days ?? 14, 1), 60);
  const agent = opts.agentAddress ?? AGENT_WALLET;
  const since = new Date(now.getTime() - nDays * 86_400_000);

  const payRows = await db
    .select({
      txHash: payments.txHash,
      payer: payments.payer,
      tokenOut: payments.tokenOut,
      amountOut: payments.amountOut,
      paidAt: payments.paidAt,
      costBps: payments.costBps,
      savingsBps: payments.savingsBps,
      paymentLegs: payments.legs,
      plan: quotes.plan,
      amountLocal: invoices.amountLocal,
      currency: invoices.currency,
    })
    .from(payments)
    .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
    .leftJoin(
      submissions,
      and(eq(submissions.invoiceId, payments.invoiceId), inArray(submissions.status, ["pending", "sending", "sent", "confirmed"])),
    )
    .leftJoin(quotes, eq(quotes.id, submissions.quoteId))
    .orderBy(desc(payments.paidAt))
    .limit(limit);

  const grantRows = await db
    .select({ key: flags.key, value: flags.value, updatedAt: flags.updatedAt })
    .from(flags)
    .where(like(flags.key, `${GAS_GRANT_PREFIX}%`))
    .orderBy(desc(flags.updatedAt))
    .limit(limit);

  const entries: JournalEntry[] = [
    ...payRows.map((r) => routeEntry(r, agent)),
    ...grantRows.flatMap((g) => grantEntry(g.key, g.value, g.updatedAt, agent) ?? []),
  ]
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, limit);

  const days = new Map<string, JournalDay>();
  const bucket = (date: string) => {
    let d = days.get(date);
    if (!d) days.set(date, (d = { date, remindersSent: 0, dailyCloses: 0, failedSubmissions: 0 }));
    return d;
  };
  const sinceDate = day(since);
  for (const r of await db.select({ at: invoices.lastReminderAt }).from(invoices).where(and(isNotNull(invoices.lastReminderAt), gte(invoices.lastReminderAt, since)))) {
    if (r.at) bucket(day(r.at)).remindersSent++;
  }
  for (const r of await db.select({ at: submissions.updatedAt }).from(submissions).where(and(eq(submissions.status, "failed"), gte(submissions.updatedAt, since)))) {
    bucket(day(r.at)).failedSubmissions++;
  }
  for (const r of await db.select({ key: flags.key }).from(flags).where(like(flags.key, `${DAILY_CLOSE_PREFIX}%`))) {
    const date = r.key.slice(r.key.lastIndexOf(":") + 1); // key = daily_close:<merchantId>:<yyyy-mm-dd>; the merchant id is dropped
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && date >= sinceDate) bucket(date).dailyCloses++;
  }
  return {
    agent: { address: agent, attributionTag: ERC8021_TAG },
    entries,
    days: [...days.values()].sort((a, b) => (a.date < b.date ? 1 : -1)),
  };
}

export const agentExplorerUrl = (a: string) => explorerAddress(a);

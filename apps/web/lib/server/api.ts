/**
 * Route-handler logic for the public payment API (docs/interfaces.md §4), framework-free:
 * every handler takes a standard Request + injected deps and returns a Response, so tests run them
 * against PGlite with a fake solver / fake RPC. The Next.js route files are one-line adapters.
 */
import { and, desc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { getAddress, isAddress, parseSignature, type Address, type Hex } from "viem";
import {
  PullKind,
  QUOTE_TTL_MS,
  TOKENS,
  deserializePlan,
  explorerTx,
  serializeLeg,
  serializePlan,
  tokenByAddress,
  type ReferenceRates,
  type SerializedPlan,
  type SolveResult,
  isTextileVenue,
  type SolverInput,
} from "@cobra/shared";
import { getCaps, isKillSwitchOn, onchainInvoiceFromRow, payments, quotes, submissions, type Db } from "@cobra/db";
import { parseLocalAmount } from "../amount";
import { buildRipioOnrampUrl } from "../ramp";
import { toWire, type QuoteError, type QuoteOk, type StatusResponse, type ToSignEntry, type WireTypedData } from "../wire";
import { permit2ReadyTokens, type PayerChainState } from "./balances";
import { INVOICE_ID_RE, SLUG_RE, UUID_RE, apiError, clientIp, json, logEvent, readJsonBody } from "./http";
import { StaticInvoiceError, createStaticInvoice, effectiveStatus, loadInvoice, toPublicInvoice } from "./invoices";
import type { RateLimiter } from "./rate-limit";
import { PlanValidationError, buildLegSigning, buildSignedLegs, validatePlannedLegs } from "./signing";

/** Routing metadata attached to a stored plan (mirrors @cobra/solver PlanMeta; structural, no dependency). */
export interface PlanMeta {
  venue: "textile" | "uniswap_v3";
  textile?: { rfqId: string; expiresAt: number; takerPays: string };
}

export interface ApiDeps {
  db: Db;
  now: () => number;
  chainId: number;
  /** CobraRouter address; null = not deployed/configured yet → quote/submit answer 503. */
  router: Address | null;
  permit2: Address;
  readPayerState(payer: Address): Promise<PayerChainState>;
  /**
   * EIP-7702 delegated payer (code = 0xef0100 + delegate): USD₮ / USDC / Permit2 then verify the signature through
   * ERC-1271 on the account, so the outcome depends on the delegate. MetaMask's delegator accepts the EOA's plain
   * signature (fork-tested); "sweeper" delegates reject it. Checked at submit, per leg, against the exact digest:
   * `null` = not delegated (nothing to check), true/false = what the account's isValidSignature answers.
   * Optional: absent = not checked (the relayer's simulation still catches a reject, with a generic error).
   */
  delegatedAccountAccepts?(payer: Address, typedData: Record<string, unknown>, signature: Hex): Promise<boolean | null>;
  getReferenceRates(): Promise<ReferenceRates>;
  /** `permit2Ready`: tokens whose Permit2 allowance already covers the payer's balance (WS2 SolverOptions). */
  solve(input: SolverInput, opts: { capUsd: number; permit2Ready: Address[] }): Promise<SolveResult & { meta?: PlanMeta }>;
  /** Textile FX RFQ route enabled (TEXTILE_API_KEY + a v2 router configured). Default false. */
  textileEnabled?: boolean;
  /** Give back a Textile RFQ that will not be used (best effort, never throws). */
  cancelTextileRfq?(rfqId: string): Promise<void>;
  /** ERC-1271/6492-aware typed-data signature check (viem publicClient.verifyTypedData); EOAs use ecrecover. */
  verifyTypedData(args: Record<string, unknown> & { address: Address; signature: Hex }): Promise<boolean>;
  rateLimiter: RateLimiter;
  env: Record<string, string | undefined>;
}

/** An invoice must have at least this much life left to be quoted (signing + relaying time). */
export const MIN_REMAINING_MS = 20_000;
const SECP256K1_N_HALF = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

function limited(deps: ApiDeps, bucket: string, req: Request): Response | null {
  const wait = deps.rateLimiter.hit(bucket, clientIp(req), deps.now());
  return wait > 0 ? apiError(429, "rate_limited", { retryAfter: wait }) : null;
}

/** Rate limit on an explicit key (payer address, invoice id) rather than the client IP. */
function limitedBy(deps: ApiDeps, bucket: string, key: string): Response | null {
  const wait = deps.rateLimiter.hit(bucket, key.toLowerCase(), deps.now());
  return wait > 0 ? apiError(429, "rate_limited", { retryAfter: wait }) : null;
}

/** WS7-2: a payer whose submissions keep reverting is refused for a while (it burns relayer gas and caps). */
export const REVERT_BAN_THRESHOLD = 3;
export const REVERT_BAN_WINDOW_MS = 30 * 60_000;

export async function payerBanned(deps: ApiDeps, payer: Address): Promise<Response | null> {
  const nowMs = deps.now();
  const rows = await deps.db
    .select({ at: submissions.updatedAt })
    .from(submissions)
    .where(
      and(
        sql`lower(${submissions.payer}) = ${payer.toLowerCase()}`,
        eq(submissions.status, "failed"),
        or(sql`${submissions.error} like 'tx_reverted%'`, sql`${submissions.error} like 'simulation_reverted%'`),
        gt(submissions.updatedAt, new Date(nowMs - REVERT_BAN_WINDOW_MS)),
      ),
    )
    .orderBy(desc(submissions.updatedAt))
    .limit(REVERT_BAN_THRESHOLD);
  if (rows.length < REVERT_BAN_THRESHOLD) return null;
  // the ban lifts when the oldest of the last N reverts leaves the window
  const retryAfter = Math.max(1, Math.ceil((rows[rows.length - 1]!.at.getTime() + REVERT_BAN_WINDOW_MS - nowMs) / 1000));
  return apiError(429, "payer_blocked", { retryAfter });
}

function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    const o = e as { code?: unknown; message?: unknown; cause?: unknown };
    if (o.code === "23505") return true;
    if (typeof o.message === "string" && o.message.includes("submissions_one_live_per_invoice")) return true;
    e = o.cause;
  }
  return false;
}

/**
 * Solver outage markers (WS2 `detail`): "(7 failed quotes)" / ", 7 failed quotes" (QuoterV2 RPC down),
 * "no_ref_rate" / "missing reference rate" (FX sources down). Retry, don't push the payer to a fallback.
 */
export function isTransientSolverFailure(detail: string | undefined): boolean {
  return !!detail && /\b[1-9]\d* failed quotes?\b|no_ref_rate|missing reference rate/.test(detail);
}

/**
 * wFIAT (no EIP-3009) are always planned as PERMIT2 legs, even before the payer approved Permit2: one approval tx,
 * then every payment is a gasless signature relayed (and attributed) by the agent. The alternative, ALLOWANCE, needs
 * two payer txs per payment. `needsPermit2Approval` tells the page which approval is still missing, and the worker
 * sends a small CELO gas grant to payers who hold the wFIAT but no CELO for that approval.
 */
const PERMIT2_FIRST_TOKENS: Address[] = TOKENS.filter((t) => t.pullKinds[0] === PullKind.PERMIT2).map((t) => t.address);

const LIVE_SUBMISSION = ["pending", "sending", "sent", "confirmed"] as const;

// ---------------------------------------------------------------- GET /api/invoices/:id

export async function handleGetInvoice(req: Request, id: string, deps: ApiDeps): Promise<Response> {
  const rl = limited(deps, "read", req);
  if (rl) return rl;
  if (!INVOICE_ID_RE.test(id)) return apiError(404, "not_found");
  const loaded = await loadInvoice(deps.db, id);
  if (!loaded) return apiError(404, "not_found");
  return json(toPublicInvoice(loaded.invoice, loaded.merchant, deps.now()));
}

// ---------------------------------------------------------------- POST /api/invoices/:id/quote

export async function handleQuote(req: Request, id: string, deps: ApiDeps): Promise<Response> {
  const rl = limited(deps, "quote", req);
  if (rl) return rl;
  if (!INVOICE_ID_RE.test(id)) return apiError(404, "not_found");
  const body = await readJsonBody(req);
  const payerRaw = body?.payer;
  if (typeof payerRaw !== "string" || !isAddress(payerRaw, { strict: false })) return apiError(400, "invalid_payer");
  const payer = getAddress(payerRaw);
  const rlKeyed = limitedBy(deps, "quotePayer", payer) ?? limitedBy(deps, "quoteInvoice", id);
  if (rlKeyed) return rlKeyed;
  if (!deps.router) return apiError(503, "not_configured");
  if (await isKillSwitchOn(deps.db, deps.env)) return apiError(503, "paused");
  const banned = await payerBanned(deps, payer);
  if (banned) return banned;

  const loaded = await loadInvoice(deps.db, id);
  if (!loaded) return apiError(404, "not_found");
  const { invoice: row } = loaded;
  const now = deps.now();
  const status = effectiveStatus(row, now);
  if (status === "expired" || row.expiresAt.getTime() - now < MIN_REMAINING_MS) return apiError(410, "invoice_expired");
  if (status !== "open") return apiError(409, "invoice_not_open", { status });
  // WS7-1: self-payment moves no value but consumes the relayer's shared daily budget — refuse it.
  if (payer === getAddress(row.merchantAddress)) return apiError(400, "self_payment");

  const inv = onchainInvoiceFromRow(row);
  let state: PayerChainState;
  let refRates: ReferenceRates;
  try {
    [state, refRates] = await Promise.all([deps.readPayerState(payer), deps.getReferenceRates()]);
  } catch (e) {
    logEvent("quote.upstream_error", { invoiceId: id, kind: e instanceof Error ? e.name : "unknown" });
    return apiError(502, "upstream_unavailable");
  }
  const caps = await getCaps(deps.db);

  let result: SolveResult & { meta?: PlanMeta };
  try {
    result = await deps.solve(
      { invoice: { tokenOut: inv.tokenOut, amountOut: inv.amountOut, deadline: inv.deadline }, balances: state.balances, refRates },
      { capUsd: caps.perPaymentUsd, permit2Ready: [...permit2ReadyTokens(state), ...PERMIT2_FIRST_TOKENS] },
    );
  } catch (e) {
    logEvent("quote.solver_error", { invoiceId: id, kind: e instanceof Error ? e.name : "unknown" });
    return apiError(503, "solver_unavailable");
  }

  const outToken = tokenByAddress(inv.tokenOut);
  const directTransfer = {
    address: inv.merchant,
    token: inv.tokenOut,
    symbol: outToken?.symbol ?? "?",
    amount: inv.amountOut.toString(),
    decimals: outToken?.decimals ?? 18,
  };

  if (!result.ok) {
    // WS2: an RPC/quoter outage comes back as no_route / insufficient_balance with "(N failed quotes)" in
    // `detail`. That is not the payer's fault: offer a retry, never the Ripio / direct-transfer fallbacks.
    if (isTransientSolverFailure(result.detail)) {
      logEvent("quote.transient_failure", { invoiceId: id, reason: result.reason });
      return json({ error: "temporarily_unavailable", retryable: true } satisfies QuoteError, 503);
    }
    // Ripio on-ramp whenever buying the invoice's wFIAT in local currency solves it: no usable balance, no pool
    // to convert (wMXN, wCOP, ...), or the pool price is outside the guard. Not for over_cap (amount too large).
    const rampUrl =
      result.reason === "insufficient_balance" || result.reason === "no_route" || result.reason === "price_guard"
        ? buildRipioOnrampUrl({ symbol: directTransfer.symbol, amount: inv.amountOut, decimals: directTransfer.decimals, payer })
        : null;
    const out: QuoteError = { error: result.reason, fallback: result.fallback, rampUrl, directTransfer };
    logEvent("quote.no_plan", { invoiceId: id, reason: result.reason });
    return json(out, 422);
  }

  const plan = result.plan;
  try {
    if (getAddress(plan.tokenOut) !== inv.tokenOut || plan.minOut !== inv.amountOut) {
      throw new PlanValidationError("plan does not match invoice");
    }
    validatePlannedLegs(plan.legs, inv.tokenOut, { allowTextile: !!deps.textileEnabled });
    if (plan.legs.some((l) => isTextileVenue(l.path)) !== (result.meta?.venue === "textile")) throw new PlanValidationError("venue mismatch");
  } catch (e) {
    logEvent("quote.invalid_plan", { invoiceId: id, detail: e instanceof Error ? e.message : "unknown" });
    return json({ error: "no_route", directTransfer } satisfies QuoteError, 422);
  }

  const signing = buildLegSigning({ router: deps.router, chainId: deps.chainId, permit2: deps.permit2, invoice: inv, payer, legs: plan.legs });
  const expiresAt = Math.min(plan.expiresAt, now + QUOTE_TTL_MS, row.expiresAt.getTime());
  // Routing metadata rides in the (jsonb) plan: the journal shows the venue, the relayer reports the tx to Textile.
  const storedPlan = {
    ...serializePlan(plan),
    router: deps.router,
    venue: result.meta?.venue ?? "uniswap_v3",
    ...(result.meta?.textile && { textile: result.meta.textile }),
  };
  const [quote] = await deps.db
    .insert(quotes)
    .values({ invoiceId: row.id, payer, plan: storedPlan, expiresAt: new Date(expiresAt) })
    .returning({ id: quotes.id });
  if (deps.cancelTextileRfq) await supersedeTextileQuotes(deps, row.id, payer, quote!.id, now);

  const toSign: ToSignEntry[] = plan.legs.map((leg, i) => {
    const info = tokenByAddress(leg.token)!;
    const s = signing[i]!;
    return {
      index: i,
      kind: s.kind,
      token: leg.token,
      symbol: info.symbol,
      decimals: info.decimals,
      amountIn: leg.amountIn.toString(),
      typedData: s.typedData ? (toWire(s.typedData) as WireTypedData) : null,
    };
  });
  const needsPermit2Approval = plan.legs
    .filter((l, i) => signing[i]!.kind === "PERMIT2" && (state.permit2Allowances[getAddress(l.token)] ?? 0n) < l.amountIn)
    .map((l) => getAddress(l.token));

  const out: QuoteOk = {
    quoteId: quote!.id,
    quoteExpiresAt: new Date(expiresAt).toISOString(),
    plan: serializePlan(plan),
    invoice: toWire(inv) as QuoteOk["invoice"],
    router: deps.router,
    chainId: deps.chainId,
    permit2: deps.permit2,
    needsPermit2Approval,
    toSign,
  };
  logEvent("quote.ok", { invoiceId: id, quoteId: quote!.id, legs: plan.legs.length, costBps: plan.costBps });
  return json(out);
}

/**
 * A new quote for the same invoice and payer supersedes the previous ones: unused Textile RFQs are given back
 * (best effort, off the request path). Quotes already referenced by a submission are left alone.
 */
async function supersedeTextileQuotes(deps: ApiDeps, invoiceId: string, payer: Address, keepId: string, nowMs: number): Promise<void> {
  try {
    const prev = await deps.db
      .select({ id: quotes.id, plan: quotes.plan })
      .from(quotes)
      .where(and(eq(quotes.invoiceId, invoiceId), sql`lower(${quotes.payer}) = ${payer.toLowerCase()}`, gt(quotes.expiresAt, new Date(nowMs))));
    for (const q of prev) {
      const rfqId = (q.plan as { textile?: { rfqId?: unknown } } | null)?.textile?.rfqId;
      if (q.id === keepId || typeof rfqId !== "string") continue;
      const used = await deps.db.select({ id: submissions.id }).from(submissions).where(eq(submissions.quoteId, q.id)).limit(1);
      if (used.length > 0) continue;
      void deps.cancelTextileRfq!(rfqId).catch(() => undefined);
    }
  } catch (e) {
    logEvent("quote.supersede_error", { invoiceId, kind: e instanceof Error ? e.name : "unknown" });
  }
}

// ---------------------------------------------------------------- POST /api/invoices/:id/submit

function usdCents(legs: readonly { token: Address; amountIn: bigint }[]): bigint {
  let cents = 0n;
  for (const l of legs) {
    const info = tokenByAddress(l.token);
    if (info?.kind === "usd") cents += (l.amountIn * 100n) / 10n ** BigInt(info.decimals);
  }
  return cents;
}

export async function handleSubmit(req: Request, id: string, deps: ApiDeps): Promise<Response> {
  const rl = limited(deps, "submit", req);
  if (rl) return rl;
  if (!INVOICE_ID_RE.test(id)) return apiError(404, "not_found");
  const body = await readJsonBody(req);
  const quoteId = body?.quoteId;
  const signatures = body?.signatures;
  if (typeof quoteId !== "string" || !UUID_RE.test(quoteId)) return apiError(400, "invalid_quote_id");
  if (!Array.isArray(signatures) || signatures.length < 1 || signatures.length > 3) return apiError(400, "invalid_signatures");
  const rlInvoice = limitedBy(deps, "submitInvoice", id);
  if (rlInvoice) return rlInvoice;
  if (!deps.router) return apiError(503, "not_configured");
  if (await isKillSwitchOn(deps.db, deps.env)) return apiError(503, "paused");

  const [quote] = await deps.db.select().from(quotes).where(eq(quotes.id, quoteId));
  const loaded = await loadInvoice(deps.db, id);
  if (!quote || !loaded || quote.invoiceId !== loaded.invoice.id) return apiError(404, "quote_not_found");
  const row = loaded.invoice;
  const now = deps.now();
  if (quote.expiresAt.getTime() <= now) return apiError(410, "quote_expired");
  const status = effectiveStatus(row, now);
  if (status === "expired") return apiError(410, "invoice_expired");
  if (status !== "open") return apiError(409, "invoice_not_open", { status });

  // A quote built for another router (v1 -> v2 switch happened since) cannot be signed/verified against this one.
  const quotedRouter = (quote.plan as { router?: unknown }).router;
  if (typeof quotedRouter === "string" && getAddress(quotedRouter) !== getAddress(deps.router)) return apiError(410, "quote_expired");
  const plan = deserializePlan(quote.plan as SerializedPlan);
  if (signatures.length !== plan.legs.length) return apiError(400, "invalid_signatures");
  const payer = getAddress(quote.payer);
  if (payer === getAddress(row.merchantAddress)) return apiError(400, "self_payment");
  const rlPayer = limitedBy(deps, "submitPayer", payer);
  if (rlPayer) return rlPayer;
  const banned = await payerBanned(deps, payer);
  if (banned) return banned;
  const inv = onchainInvoiceFromRow(row);
  const signing = buildLegSigning({ router: deps.router, chainId: deps.chainId, permit2: deps.permit2, invoice: inv, payer, legs: plan.legs });
  if (signing.some((s) => s.kind === "ALLOWANCE")) return apiError(400, "allowance_requires_self_submit");

  const sigs: Hex[] = [];
  for (let i = 0; i < signing.length; i++) {
    const sig = signatures[i];
    const s = signing[i]!;
    // EOA signatures are 65 bytes; Permit2 legs may carry longer ERC-1271 / ERC-6492 contract-wallet signatures.
    const sigRe = s.kind === "PERMIT2" ? /^0x([0-9a-fA-F]{2}){1,8192}$/ : /^0x[0-9a-fA-F]{130}$/;
    if (typeof sig !== "string" || !sigRe.test(sig)) return apiError(400, "bad_signature", { leg: i });
    let valid: boolean;
    try {
      if (sig.length === 132) {
        const parsed = parseSignature(sig as Hex);
        if (BigInt(parsed.s) > SECP256K1_N_HALF) return apiError(400, "bad_signature", { leg: i });
      }
      // typedData is non-null here (ALLOWANCE rejected above)
      valid = await deps.verifyTypedData({ ...(s.typedData as NonNullable<typeof s.typedData>), address: payer, signature: sig as Hex });
    } catch {
      return apiError(400, "bad_signature", { leg: i });
    }
    if (!valid) return apiError(400, "bad_signature", { leg: i });
    if (deps.delegatedAccountAccepts) {
      // viem's verifyTypedData falls back to ecrecover, so a 7702 payer whose delegate rejects ERC-1271 passes above
      // and would only fail in the relayer's simulation. Ask the account itself, as the token / Permit2 will.
      let accepts: boolean | null;
      try {
        accepts = await deps.delegatedAccountAccepts(payer, s.typedData as NonNullable<typeof s.typedData>, sig as Hex);
      } catch {
        return apiError(502, "upstream_unavailable");
      }
      if (accepts === false) {
        logEvent("submit.delegate_rejects_signature", { invoiceId: id, leg: i });
        return apiError(422, "smart_account_unsupported");
      }
    }
    sigs.push(sig as Hex);
  }

  const caps = await getCaps(deps.db);
  if (usdCents(plan.legs) > BigInt(Math.round(caps.perPaymentUsd * 100))) return apiError(422, "over_cap");

  const live = await deps.db
    .select({ id: submissions.id })
    .from(submissions)
    .where(and(eq(submissions.invoiceId, row.id), inArray(submissions.status, [...LIVE_SUBMISSION])));
  if (live.length > 0) return apiError(409, "already_submitted");

  const legs = buildSignedLegs(plan.legs, signing, sigs);
  try {
    const [sub] = await deps.db
      .insert(submissions)
      .values({ invoiceId: row.id, quoteId: quote.id, payer, legs: legs.map(serializeLeg), status: "pending" })
      .returning({ id: submissions.id });
    logEvent("submit.ok", { invoiceId: id, submissionId: sub!.id, legs: legs.length });
    return json({ submissionId: sub!.id, status: "pending" }, 202);
  } catch (e) {
    if (isUniqueViolation(e)) return apiError(409, "already_submitted");
    throw e;
  }
}

// ---------------------------------------------------------------- GET /api/invoices/:id/status

export async function handleStatus(req: Request, id: string, deps: ApiDeps): Promise<Response> {
  const rl = limited(deps, "read", req);
  if (rl) return rl;
  if (!INVOICE_ID_RE.test(id)) return apiError(404, "not_found");
  const loaded = await loadInvoice(deps.db, id);
  if (!loaded) return apiError(404, "not_found");
  const row = loaded.invoice;
  const [sub] = await deps.db
    .select({ status: submissions.status, txHash: submissions.txHash })
    .from(submissions)
    .where(eq(submissions.invoiceId, row.id))
    .orderBy(desc(submissions.createdAt))
    .limit(1);
  const [payment] = await deps.db.select({ txHash: payments.txHash }).from(payments).where(eq(payments.invoiceId, row.id));
  const txHash = (payment?.txHash ?? sub?.txHash ?? null) as Hex | null;
  const out: StatusResponse = {
    status: effectiveStatus(row, deps.now()),
    submission: sub ? { status: sub.status, txHash: (sub.txHash ?? null) as Hex | null } : null,
    txHash,
    explorerUrl: txHash ? explorerTx(txHash) : null,
  };
  return json(out);
}

// ---------------------------------------------------------------- POST /api/m/:slug/invoice

export async function handleCreateStaticInvoice(req: Request, slug: string, deps: ApiDeps): Promise<Response> {
  const rl = limited(deps, "staticInvoice", req);
  if (rl) return rl;
  if (!SLUG_RE.test(slug)) return apiError(404, "merchant_not_found");
  const body = await readJsonBody(req);
  const parsed = parseLocalAmount(body?.amountLocal);
  if (!parsed.ok) return apiError(400, "invalid_amount", { reason: parsed.reason });
  try {
    const { id } = await createStaticInvoice(deps.db, { slug, amountLocal: parsed.value, now: deps.now() });
    logEvent("static_invoice.created", { invoiceId: id });
    return json({ id, url: `/pay/${id}` }, 201);
  } catch (e) {
    if (e instanceof StaticInvoiceError) return apiError(e.code === "merchant_not_found" ? 404 : 422, e.code);
    throw e;
  }
}

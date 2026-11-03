/**
 * Submission queue consumer (docs/interfaces.md §4). Single-worker design:
 *
 *   pending ──claim (conditional UPDATE … SKIP LOCKED)──▶ sending
 *     revalidate (invoice open & not expiring, quote valid & matching, kill switch, signatures → payer)
 *     simulate pay (eth_call)            ── revert ──▶ failed (decoded error), invoice untouched
 *     invoice open → submitted
 *     sign → persist (txHash, txNonce) → broadcast   ── refused/error before signing ──▶ failed, invoice → open
 *   sending(+txHash) ──broadcast ok──▶ sent
 *   watcher: receipt reverted / nonce consumed without isPaid ──▶ failed, invoice submitted → open
 *            pending too long / dropped ──▶ replacement on the SAME nonce with bumped fees
 *            success ──▶ left to the indexer (WS6) which marks confirmed + paid.
 *
 * Idempotent restarts: a `sending` row without txHash was never signed → back to pending (and its invoice to open);
 * a row with txHash is only ever re-sent on its stored nonce, never with a new one.
 */
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  BaseError,
  ContractFunctionRevertedError,
  encodeFunctionData,
  formatEther,
  getAddress,
  parseEther,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
} from "viem";
import {
  CELO,
  cobraRouterAbi,
  deserializeLeg,
  deserializePlan,
  hashInvoice,
  type Leg,
  type Notifier,
  type OnchainInvoice,
  type SerializedLeg,
  type SerializedPlan,
} from "@cobra/shared";
import {
  invoices,
  isKillSwitchOn,
  onchainInvoiceFromRow,
  quotes,
  submissions,
  transitionInvoice,
  type Db,
  type InvoiceRow,
} from "@cobra/db";
import { SignerRefusedError, signerOf, type RelayerSigner } from "./signer";
import { GAS_GRANT_DEFAULTS, findGasGrantCandidates, type GasGrantConfig } from "./gas-grant";
import { verifyLegs } from "./verify";

export type SubmissionRow = typeof submissions.$inferSelect;
type Log = (msg: string, extra?: Record<string, unknown>) => void;

export interface RelayerConfig {
  db: Db;
  publicClient: PublicClient;
  walletClient: unknown;
  router: Address;
  notifier?: Notifier;
  operatorChatId?: string;
  pollIntervalMs?: number;
  log?: Log;
  // ---- internals (not part of the frozen RelayerOptions; defaults are production values) ----
  signer?: RelayerSigner;
  now?: () => Date;
  env?: Record<string, string | undefined>;
  /** Replace a tx that is still pending after this long (default 45 s; Celo blocks are ~1 s). */
  stuckAfterMs?: number;
  /** Fee bump for replacements, percent (default 25; nodes require ≥ 10). */
  feeBumpPct?: number;
  /** Hard ceiling for maxFeePerGas (default 500 gwei). */
  maxFeePerGasCap?: bigint;
  /** Invoice must stay valid this long after we send (default 30 s). */
  deadlineMarginSec?: number;
  /** Transient-error retries before a submission is failed (default 5). */
  maxAttempts?: number;
  maxPerTick?: number;
  /** Operator alert below this native balance (default 0.5 CELO). */
  minBalanceWei?: bigint;
  balanceCheckEveryMs?: number;
  alertThrottleMs?: number;
  permit2?: Address;
  tokenDomain?: (token: Address) => { name: string; version: string } | null | undefined;
  /** Gas grants for wFIAT payers without CELO (see gas-grant.ts). `false` or amountWei 0n disables. */
  gasGrant?: GasGrantConfig | false;
}

interface Inflight {
  lastSentAt: number;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

class Transient extends Error {}

export function revertReason(err: unknown): string | null {
  if (!(err instanceof BaseError)) return null;
  const rev = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(rev instanceof ContractFunctionRevertedError)) return null;
  if (rev.data?.errorName) {
    const args = rev.data.args?.length ? `(${rev.data.args.map(String).join(",")})` : "";
    return `${rev.data.errorName}${args}`;
  }
  return rev.reason ?? rev.signature ?? "reverted";
}

function errMsg(err: unknown): string {
  if (err instanceof BaseError) return err.shortMessage;
  return err instanceof Error ? err.message : String(err);
}

const isNonceTooLow = (e: unknown) => /nonce too low|nonce has already been used|NonceTooLow/i.test(String((e as Error)?.message ?? e));
const isAlreadyKnown = (e: unknown) => /already known|known transaction|AlreadyKnown/i.test(String((e as Error)?.message ?? e));

/** Atomically claims the oldest pending submission (safe with several workers / concurrent ticks). */
export async function claimNext(db: Db, now: Date = new Date()): Promise<SubmissionRow | null> {
  const [row] = await db
    .update(submissions)
    .set({ status: "sending", attempts: sql`${submissions.attempts} + 1`, updatedAt: now })
    .where(
      and(
        eq(submissions.status, "pending"),
        eq(
          submissions.id,
          sql`(select s.id from submissions s where s.status = 'pending' order by s.created_at limit 1 for update skip locked)`,
        ),
      ),
    )
    .returning();
  return row ?? null;
}

export function payCalldata(inv: OnchainInvoice, payer: Address, legs: readonly Leg[]): Hex {
  return encodeFunctionData({ abi: cobraRouterAbi, functionName: "pay", args: [inv, payer, legs as Leg[]] });
}

export function createRelayer(cfg: RelayerConfig) {
  const signer = cfg.signer ?? signerOf(cfg.walletClient);
  if (!signer) throw new Error("startRelayer: walletClient must be created by createRelayerSigner (guarded signer)");
  const { db, publicClient } = cfg;
  const router = getAddress(cfg.router);
  const log: Log = cfg.log ?? (() => {});
  const now = cfg.now ?? (() => new Date());
  const env = cfg.env ?? process.env;
  const stuckAfterMs = cfg.stuckAfterMs ?? 45_000;
  const bumpPct = BigInt(cfg.feeBumpPct ?? 25);
  const feeCap = cfg.maxFeePerGasCap ?? 500n * 10n ** 9n;
  const marginSec = BigInt(cfg.deadlineMarginSec ?? 30);
  const maxAttempts = cfg.maxAttempts ?? 5;
  const maxPerTick = cfg.maxPerTick ?? 5;
  const minBalance = cfg.minBalanceWei ?? parseEther("0.5");
  const balanceEvery = cfg.balanceCheckEveryMs ?? 60_000;
  const alertThrottle = cfg.alertThrottleMs ?? 3600_000;
  const permit2 = cfg.permit2 ?? CELO.permit2.address;

  let nextNonce: number | null = null;
  let chainId: number | null = null;
  let recovered = false;
  let killLogged = false;
  let lastBalanceCheck = 0;
  const lastAlert = new Map<string, number>();
  const inflight = new Map<string, Inflight>();
  const minedOk = new Set<string>(); // submission ids whose tx succeeded: indexer finalises
  const grantCfg = cfg.gasGrant === false ? null : { ...GAS_GRANT_DEFAULTS, ...cfg.gasGrant };
  const grantSkip = new Map<string, number>(); // payer (lowercase) -> do not re-check before (ms)

  async function alert(kind: string, message: string) {
    // level "warn": the worker forwards `level: "alert"` logs itself; this path already notifies directly
    log("operator_alert", { level: "warn", kind, message });
    if (!cfg.notifier || !cfg.operatorChatId) return;
    const t = Date.now();
    if (t - (lastAlert.get(kind) ?? 0) < alertThrottle) return;
    lastAlert.set(kind, t);
    try {
      await cfg.notifier.text(cfg.operatorChatId, `[Cobrá relayer] ${message}`);
    } catch (e) {
      log("alert_failed", { error: errMsg(e) });
    }
  }

  async function getChainId() {
    chainId ??= await publicClient.getChainId();
    return chainId;
  }

  /**
   * Conditional: never overwrites a row the indexer already set to `confirmed` / `failed` (superseded).
   * Returns true only if THIS call moved the row to failed.
   */
  async function fail(id: string, error: string): Promise<boolean> {
    const rows = await db
      .update(submissions)
      .set({ status: "failed", error: error.slice(0, 500), updatedAt: now() })
      .where(and(eq(submissions.id, id), inArray(submissions.status, ["pending", "sending", "sent"])))
      .returning({ id: submissions.id });
    log("submission_failed", { submissionId: id, error, applied: rows.length > 0 });
    return rows.length > 0;
  }

  async function reopen(invoiceId: string) {
    await transitionInvoice(db, invoiceId, ["submitted"], "open");
  }

  async function reserveNonce(): Promise<number> {
    const chainPending = await publicClient.getTransactionCount({ address: signer!.address, blockTag: "pending" });
    nextNonce = Math.max(nextNonce ?? 0, chainPending);
    return nextNonce;
  }

  function bump(v: bigint | undefined, est: bigint): bigint {
    const bumped = v === undefined ? est : (v * (100n + bumpPct) + 99n) / 100n;
    return bumped > est ? bumped : est;
  }

  // ---------------------------------------------------------------- restart recovery
  async function recover() {
    const rows = await db.select().from(submissions).where(eq(submissions.status, "sending"));
    for (const r of rows) {
      if (!r.txHash) {
        // never signed (the hash is persisted before broadcast) → safe to redo from scratch
        const moved = await db
          .update(submissions)
          .set({ status: "pending", txNonce: null, updatedAt: now() })
          .where(and(eq(submissions.id, r.id), eq(submissions.status, "sending"), sql`${submissions.txHash} is null`))
          .returning({ id: submissions.id });
        if (moved.length === 0) continue;
        await reopen(r.invoiceId);
        log("recover_requeued", { submissionId: r.id });
      } else {
        log("recover_rewatch", { submissionId: r.id, txHash: r.txHash, nonce: r.txNonce });
      }
    }
    const live = await db
      .select({ n: sql<number | null>`max(${submissions.txNonce})` })
      .from(submissions)
      .where(and(inArray(submissions.status, ["sending", "sent"]), isNotNull(submissions.txHash)));
    const maxLive = live[0]?.n;
    const chainPending = await publicClient.getTransactionCount({ address: signer!.address, blockTag: "pending" });
    nextNonce = Math.max(chainPending, maxLive != null ? Number(maxLive) + 1 : 0);
    log("relayer_recovered", { nextNonce, address: signer!.address });
  }

  // ---------------------------------------------------------------- new submissions
  async function validate(row: SubmissionRow): Promise<
    { ok: true; invRow: InvoiceRow; inv: OnchainInvoice; payer: Address; legs: Leg[] } | { ok: false; reason: string }
  > {
    const [invRow] = await db.select().from(invoices).where(eq(invoices.id, row.invoiceId));
    if (!invRow) return { ok: false, reason: "invoice_not_found" };
    if (invRow.status !== "open") return { ok: false, reason: `invoice_not_open:${invRow.status}` };
    const nowMs = now().getTime();
    if (invRow.expiresAt.getTime() <= nowMs + Number(marginSec) * 1000) return { ok: false, reason: "invoice_expired" };

    let payer: Address;
    let legs: Leg[];
    try {
      payer = getAddress(row.payer);
      legs = (row.legs as SerializedLeg[]).map(deserializeLeg);
    } catch {
      return { ok: false, reason: "bad_legs" };
    }
    // WS7-1: a merchant paying its own invoice is free self-dealing that would burn the shared relay caps.
    if (payer === getAddress(invRow.merchantAddress)) return { ok: false, reason: "self_payment" };

    if (!row.quoteId) return { ok: false, reason: "missing_quote" };
    const [q] = await db.select().from(quotes).where(eq(quotes.id, row.quoteId));
    if (!q) return { ok: false, reason: "quote_not_found" };
    if (q.expiresAt.getTime() <= nowMs) return { ok: false, reason: "quote_expired" };
    if (q.invoiceId !== invRow.id || getAddress(q.payer) !== payer) return { ok: false, reason: "quote_mismatch" };
    try {
      const plan = deserializePlan(q.plan as SerializedPlan);
      const same =
        plan.legs.length === legs.length &&
        plan.legs.every(
          (p, i) =>
            p.token === legs[i]!.token &&
            p.amountIn === legs[i]!.amountIn &&
            p.kind === legs[i]!.kind &&
            p.path.toLowerCase() === legs[i]!.path.toLowerCase(),
        );
      if (!same) return { ok: false, reason: "legs_differ_from_quote" };
    } catch {
      return { ok: false, reason: "bad_quote_plan" };
    }

    const inv = onchainInvoiceFromRow(invRow);
    const res = await verifyLegs(
      {
        publicClient,
        router,
        chainId: await getChainId(),
        permit2,
        nowSec: BigInt(Math.floor(nowMs / 1000)),
        marginSec,
        ...(cfg.tokenDomain && { tokenDomain: cfg.tokenDomain }),
      },
      inv,
      payer,
      legs,
    );
    if (!res.ok) return res;
    return { ok: true, invRow, inv, payer, legs };
  }

  async function requeueOrFail(row: SubmissionRow, error: string) {
    if (row.attempts >= maxAttempts) {
      await fail(row.id, `gave_up:${error}`);
    } else {
      await db
        .update(submissions)
        .set({ status: "pending", error: `retry:${error}`.slice(0, 500), updatedAt: now() })
        .where(and(eq(submissions.id, row.id), eq(submissions.status, "sending"), sql`${submissions.txHash} is null`));
      log("submission_requeued", { submissionId: row.id, attempts: row.attempts, error });
    }
  }

  /**
   * WS7-3: a transient refusal before anything was signed (kill switch flipped between the tick check and the
   * signer check) must not lose the payer's signed submission: back to `pending`, and the claim's attempt is
   * given back so a long pause never exhausts `maxAttempts`. Only rows that never got a txHash move.
   */
  async function requeueNotBroadcast(row: SubmissionRow, error: string) {
    await db
      .update(submissions)
      .set({
        status: "pending",
        attempts: sql`greatest(${submissions.attempts} - 1, 0)`,
        error: `retry:${error}`.slice(0, 500),
        updatedAt: now(),
      })
      .where(and(eq(submissions.id, row.id), eq(submissions.status, "sending"), sql`${submissions.txHash} is null`));
    log("submission_requeued_not_broadcast", { submissionId: row.id, error });
  }

  /** Returns false when the tick should stop claiming (transient trouble). */
  async function processClaimed(row: SubmissionRow): Promise<boolean> {
    const v = await validate(row);
    if (!v.ok) {
      await fail(row.id, v.reason);
      return true;
    }
    const data = payCalldata(v.inv, v.payer, v.legs);

    // simulate exactly what will be sent (from the relayer address)
    let gas: bigint;
    try {
      await publicClient.simulateContract({
        account: signer!.address,
        address: router,
        abi: cobraRouterAbi,
        functionName: "pay",
        args: [v.inv, v.payer, v.legs],
      });
      gas = await publicClient.estimateGas({ account: signer!.address, to: router, data });
    } catch (e) {
      const reason = revertReason(e);
      if (reason) {
        await fail(row.id, `simulation_reverted:${reason}`);
        return true;
      }
      await requeueOrFail(row, `simulation_error:${errMsg(e)}`);
      return false;
    }

    // refuse early (no invoice transition) if the signer would refuse anyway
    try {
      await signer!.check({ to: router, data });
    } catch (e) {
      if (e instanceof SignerRefusedError) {
        if (e.code === "kill_switch") {
          await requeueNotBroadcast(row, e.message);
          return false;
        }
        await fail(row.id, e.message);
        return true;
      }
      await requeueOrFail(row, `check_error:${errMsg(e)}`);
      return false;
    }

    if (!(await transitionInvoice(db, v.invRow.id, ["open"], "submitted"))) {
      await fail(row.id, "invoice_not_open");
      return true;
    }

    let signed: { hash: Hash; nonce: number } | null = null;
    let fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
    try {
      const est = await publicClient.estimateFeesPerGas();
      fees = { maxFeePerGas: min(est.maxFeePerGas, feeCap), maxPriorityFeePerGas: min(est.maxPriorityFeePerGas, feeCap) };
      const nonce = await reserveNonce();
      const hash = await signer!.send({
        to: router,
        data,
        nonce,
        gas: (gas * 12n) / 10n + 10_000n,
        ...fees,
        onSigned: async (tx) => {
          const [u] = await db
            .update(submissions)
            .set({ txHash: tx.hash, txNonce: tx.nonce, updatedAt: now() })
            .where(and(eq(submissions.id, row.id), eq(submissions.status, "sending")))
            .returning({ id: submissions.id });
          if (!u) throw new Error("submission no longer sending; refusing to broadcast");
          signed = tx;
          nextNonce = tx.nonce + 1;
        },
      });
      await db
        .update(submissions)
        .set({ status: "sent", updatedAt: now() })
        .where(and(eq(submissions.id, row.id), eq(submissions.status, "sending")));
      inflight.set(row.id, { lastSentAt: Date.now(), ...fees });
      log("submission_sent", { submissionId: row.id, invoiceId: row.invoiceId, txHash: hash, nonce });
      return true;
    } catch (e) {
      const s = signed as { hash: Hash; nonce: number } | null;
      if (!s) {
        // nothing was signed → nothing can be mined
        await reopen(v.invRow.id);
        if (e instanceof SignerRefusedError) {
          if (e.code === "kill_switch") {
            await requeueNotBroadcast(row, e.message);
            return false;
          }
          await fail(row.id, e.message);
          return true;
        }
        await requeueOrFail(row, `send_error:${errMsg(e)}`);
        return false;
      }
      if (isAlreadyKnown(e)) {
        await db.update(submissions).set({ status: "sent", updatedAt: now() }).where(and(eq(submissions.id, row.id), eq(submissions.status, "sending")));
        inflight.set(row.id, { lastSentAt: Date.now() });
        return true;
      }
      if (isNonceTooLow(e)) {
        // our signed tx can never be mined (the nonce is taken by another tx) unless it IS that tx
        const mine = await publicClient.getTransaction({ hash: s.hash }).catch(() => null);
        if (!mine) {
          nextNonce = null;
          await db
            .update(submissions)
            .set({ status: "pending", txHash: null, txNonce: null, error: "retry:nonce_too_low", updatedAt: now() })
            .where(and(eq(submissions.id, row.id), eq(submissions.status, "sending")));
          await reopen(v.invRow.id);
          log("nonce_resync", { submissionId: row.id });
          return false;
        }
      }
      // broadcast outcome unknown: keep `sending` + txHash; the watcher re-broadcasts on the same nonce
      inflight.set(row.id, { lastSentAt: 0, ...fees! });
      log("broadcast_uncertain", { submissionId: row.id, txHash: s.hash, nonce: s.nonce, error: errMsg(e) });
      await alert("broadcast_error", `broadcast error for submission ${row.id}: ${errMsg(e)}`);
      return false;
    }
  }

  // ---------------------------------------------------------------- watcher
  async function replace(row: SubmissionRow, invRow: InvoiceRow, state: Inflight, reason: string) {
    if (row.txNonce == null) return;
    const inv = onchainInvoiceFromRow(invRow);
    const legs = (row.legs as SerializedLeg[]).map(deserializeLeg);
    const data = payCalldata(inv, getAddress(row.payer), legs);
    let prev: { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint } = state;
    if (prev.maxFeePerGas === undefined && row.txHash) {
      const old = await publicClient.getTransaction({ hash: row.txHash as Hash }).catch(() => null);
      if (old?.maxFeePerGas) prev = { maxFeePerGas: old.maxFeePerGas, maxPriorityFeePerGas: old.maxPriorityFeePerGas ?? undefined };
    }
    const est = await publicClient.estimateFeesPerGas();
    const maxFeePerGas = min(bump(prev.maxFeePerGas, est.maxFeePerGas), feeCap);
    const maxPriorityFeePerGas = min(bump(prev.maxPriorityFeePerGas, est.maxPriorityFeePerGas), maxFeePerGas);
    // No simulation: the nonce MUST be consumed (a revert still fills the gap and is then handled by the watcher).
    let gas: bigint;
    try {
      gas = ((await publicClient.estimateGas({ account: signer!.address, to: router, data })) * 12n) / 10n + 10_000n;
    } catch {
      gas = 1_500_000n;
    }
    try {
      const hash = await signer!.send({
        to: router,
        data,
        nonce: row.txNonce,
        gas,
        maxFeePerGas,
        maxPriorityFeePerGas,
        onSigned: async (tx) => {
          await db
            .update(submissions)
            .set({ txHash: tx.hash, updatedAt: now() })
            .where(and(eq(submissions.id, row.id), inArray(submissions.status, ["sending", "sent"])));
        },
      });
      await db.update(submissions).set({ status: "sent", updatedAt: now() }).where(and(eq(submissions.id, row.id), eq(submissions.status, "sending")));
      inflight.set(row.id, { lastSentAt: Date.now(), maxFeePerGas, maxPriorityFeePerGas });
      log("tx_replaced", { submissionId: row.id, reason, nonce: row.txNonce, txHash: hash, maxFeePerGas: String(maxFeePerGas) });
    } catch (e) {
      // keep the bumped fees so the next attempt bumps again (replacement underpriced, etc.)
      inflight.set(row.id, { lastSentAt: Date.now(), maxFeePerGas, maxPriorityFeePerGas });
      log("tx_replace_failed", { submissionId: row.id, reason, error: errMsg(e) });
      if (isNonceTooLow(e)) return; // nonce consumed meanwhile: next watch pass resolves it
    }
  }

  async function watchInflight() {
    const rows = await db
      .select({ s: submissions, i: invoices })
      .from(submissions)
      .innerJoin(invoices, eq(submissions.invoiceId, invoices.id))
      .where(and(inArray(submissions.status, ["sending", "sent"]), isNotNull(submissions.txHash)))
      .orderBy(asc(submissions.txNonce));
    if (rows.length === 0) return;
    let latestNonce: number | null = null;
    for (const { s: row, i: invRow } of rows) {
      if (minedOk.has(row.id)) continue;
      const hash = row.txHash as Hash;
      const receipt = await publicClient.getTransactionReceipt({ hash }).catch(() => null);
      if (receipt) {
        inflight.delete(row.id);
        if (receipt.status === "success") {
          minedOk.add(row.id);
          await db.update(submissions).set({ status: "sent", updatedAt: now() }).where(and(eq(submissions.id, row.id), eq(submissions.status, "sending")));
          log("tx_mined", { submissionId: row.id, txHash: hash, block: String(receipt.blockNumber) });
        } else {
          const reason = await decodeMinedRevert(row, invRow, receipt.blockNumber);
          if (await fail(row.id, `tx_reverted:${reason}`)) await reopen(row.invoiceId);
        }
        continue;
      }
      latestNonce ??= await publicClient.getTransactionCount({ address: signer!.address, blockTag: "latest" });
      if (row.txNonce != null && latestNonce > row.txNonce) {
        // nonce consumed by another tx with the same nonce (earlier replacement): did the invoice get paid?
        const paid = await publicClient.readContract({
          address: router,
          abi: cobraRouterAbi,
          functionName: "isPaid",
          args: [hashInvoice(onchainInvoiceFromRow(invRow))],
        });
        inflight.delete(row.id);
        if (paid) {
          minedOk.add(row.id);
          await db.update(submissions).set({ status: "sent", updatedAt: now() }).where(and(eq(submissions.id, row.id), eq(submissions.status, "sending")));
          log("tx_mined_other_hash", { submissionId: row.id });
        } else {
          if (await fail(row.id, "nonce_consumed_not_paid")) await reopen(row.invoiceId);
        }
        continue;
      }
      const tx = await publicClient.getTransaction({ hash }).catch(() => null);
      const state = inflight.get(row.id) ?? { lastSentAt: row.updatedAt.getTime() };
      inflight.set(row.id, state);
      if (!tx) {
        await replace(row, invRow, state, "dropped_or_unbroadcast");
      } else {
        if (row.status === "sending") {
          await db.update(submissions).set({ status: "sent", updatedAt: now() }).where(and(eq(submissions.id, row.id), eq(submissions.status, "sending")));
        }
        if (Date.now() - state.lastSentAt > stuckAfterMs) {
          await replace(row, invRow, { ...state, maxFeePerGas: tx.maxFeePerGas ?? state.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas ?? state.maxPriorityFeePerGas }, "stuck");
        }
      }
    }
  }

  async function decodeMinedRevert(row: SubmissionRow, invRow: InvoiceRow, blockNumber: bigint): Promise<string> {
    try {
      await publicClient.simulateContract({
        account: signer!.address,
        address: router,
        abi: cobraRouterAbi,
        functionName: "pay",
        args: [onchainInvoiceFromRow(invRow), getAddress(row.payer), (row.legs as SerializedLeg[]).map(deserializeLeg)],
        blockNumber,
      });
      return "reverted";
    } catch (e) {
      return revertReason(e) ?? "reverted";
    }
  }

  // ---------------------------------------------------------------- balance
  async function checkBalance() {
    if (Date.now() - lastBalanceCheck < balanceEvery) return;
    lastBalanceCheck = Date.now();
    const bal = await publicClient.getBalance({ address: signer!.address });
    if (bal < minBalance) {
      await alert("low_balance", `low gas balance on ${signer!.address}: ${formatEther(bal)} CELO (min ${formatEther(minBalance)})`);
    }
  }

  // ---------------------------------------------------------------- tick
  async function tick() {
    if (!recovered) {
      await recover();
      recovered = true;
    }
    await watchInflight();
    await checkBalance().catch((e) => log("balance_check_error", { error: errMsg(e) }));
    if (await isKillSwitchOn(db, env)) {
      if (!killLogged) log("kill_switch_on");
      killLogged = true;
      return;
    }
    killLogged = false;
    for (let i = 0; i < maxPerTick; i++) {
      const row = await claimNext(db, now());
      if (!row) break;
      log("submission_claimed", { submissionId: row.id, invoiceId: row.invoiceId, attempts: row.attempts });
      let cont: boolean;
      try {
        cont = await processClaimed(row);
      } catch (e) {
        // unexpected (DB/RPC) error before signing: put it back for a later retry
        log("process_error", { submissionId: row.id, error: errMsg(e) });
        const [cur] = await db.select().from(submissions).where(eq(submissions.id, row.id));
        if (cur && cur.status === "sending" && !cur.txHash) {
          await reopen(row.invoiceId);
          await requeueOrFail(row, `error:${errMsg(e)}`);
        }
        cont = false;
      }
      if (!cont) break;
    }
    await grantGasToPayers().catch((e) => log("gas_grant_error", { error: errMsg(e) }));
  }

  // ---------------------------------------------------------------- gas grants (after payments: they never wait)
  async function grantGasToPayers() {
    if (!grantCfg || grantCfg.amountWei <= 0n) return;
    const t = now();
    const cands = await findGasGrantCandidates({ db, publicClient, router, now: t, cfg: grantCfg, skip: grantSkip, permit2 });
    if (cands.length === 0) return;
    // Never let grants eat into the gas that keeps payments flowing.
    const bal = await publicClient.getBalance({ address: signer!.address });
    if (bal < minBalance + grantCfg.amountWei * 10n) {
      log("gas_grant_skipped_low_balance", { balance: formatEther(bal) });
      return;
    }
    for (const c of cands) {
      try {
        const est = await publicClient.estimateFeesPerGas();
        const nonce = await reserveNonce();
        const hash = await signer!.grantGas({
          to: c.payer,
          value: grantCfg.amountWei,
          nonce,
          maxFeePerGas: min(est.maxFeePerGas, feeCap),
          maxPriorityFeePerGas: min(est.maxPriorityFeePerGas, feeCap),
          dailyMax: grantCfg.dailyMax,
          reason: { invoiceId: c.invoiceId, quoteId: c.quoteId, token: c.token },
          onSigned: async (tx) => {
            nextNonce = tx.nonce + 1;
          },
        });
        log("gas_granted", { payer: c.payer, invoiceId: c.invoiceId, token: c.token, value: formatEther(grantCfg.amountWei), txHash: hash, nonce });
      } catch (e) {
        grantSkip.set(c.payer.toLowerCase(), t.getTime() + grantCfg.windowMs);
        if (isNonceTooLow(e)) nextNonce = null;
        log("gas_grant_refused", { payer: c.payer, error: e instanceof SignerRefusedError ? e.code : errMsg(e) });
        if (e instanceof SignerRefusedError && (e.code === "grant_daily_cap" || e.code === "kill_switch")) return;
      }
    }
  }

  return { tick, recover, signer, get nextNonce() { return nextNonce; } };
}

function min(a: bigint, b: bigint) {
  return a < b ? a : b;
}

export interface Stoppable {
  stop(): Promise<void>;
}

/** Poll loop around createRelayer().tick(). */
export function runRelayer(cfg: RelayerConfig): Stoppable {
  const relayer = createRelayer(cfg);
  const interval = cfg.pollIntervalMs ?? 2_000;
  const log: Log = cfg.log ?? (() => {});
  let stopped = false;
  let wake: (() => void) | null = null;
  const loop = (async () => {
    log("relayer_started", { address: relayer.signer.address, router: cfg.router });
    while (!stopped) {
      try {
        await relayer.tick();
      } catch (e) {
        log("relayer_tick_error", { error: errMsg(e) });
      }
      if (stopped) break;
      await new Promise<void>((r) => {
        const t = setTimeout(r, interval);
        wake = () => {
          clearTimeout(t);
          r();
        };
      });
      wake = null;
    }
    log("relayer_stopped");
  })();
  return {
    async stop() {
      stopped = true;
      (wake as (() => void) | null)?.();
      await loop;
    },
  };
}

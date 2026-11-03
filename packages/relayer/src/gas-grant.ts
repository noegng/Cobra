/**
 * Gas grants: the agent covers the one Permit2 approval a wFIAT payer must send themselves.
 *
 * wFIAT tokens have no EIP-3009, so a payer who bought wARS/wMXN/… (e.g. through Ripio's ramp) and holds no CELO
 * cannot send the Permit2 approval, and wFIAT are not Celo fee currencies. The relayer loop calls `findCandidates`
 * on recent quotes and the guarded `signer.grantGas` sends a tiny amount of CELO (one grant per address, ever).
 *
 * Candidate = a quote created in the last `windowMs`, not expired, for an invoice still `open` and not expired,
 * whose plan has a PERMIT2 or ALLOWANCE leg that the payer can fund (token balance ≥ leg amount) but has not approved
 * yet (Permit2 allowance, or router allowance for ALLOWANCE legs, < leg amount), and whose native balance is below
 * `minPayerBalanceWei`. The payer must not be the invoice's merchant. Every on-chain read is done by the worker, not
 * trusted from the web.
 */
import { and, desc, eq, gt, like } from "drizzle-orm";
import { erc20Abi, getAddress, isAddressEqual, parseEther, type Address, type PublicClient } from "viem";
import { CELO, PullKind, deserializePlan, type SerializedPlan } from "@cobra/shared";
import { flags, invoices, quotes, type Db } from "@cobra/db";
import { GAS_GRANT_FLAG_PREFIX } from "./signer";

export interface GasGrantConfig {
  /** CELO sent per grant (default 0.05: covers one approval even at 2x base fee). 0n disables grants. */
  amountWei?: bigint;
  /** Max grants per rolling 24 h (default 20). */
  dailyMax?: number;
  /** Payers at or above this native balance get nothing (default 0.02 CELO). */
  minPayerBalanceWei?: bigint;
  /** Only quotes younger than this are considered (default 15 min). */
  windowMs?: number;
  /** Max grants sent per relayer tick (default 2). */
  maxPerTick?: number;
}

export const GAS_GRANT_DEFAULTS = {
  amountWei: parseEther("0.05"),
  dailyMax: 20,
  minPayerBalanceWei: parseEther("0.02"),
  windowMs: 15 * 60_000,
  maxPerTick: 2,
} as const;

export interface GasGrantCandidate {
  payer: Address;
  invoiceId: string;
  quoteId: string;
  token: Address;
}

/** Payers to fund now. Pure reads (DB + chain); `skip` holds payers already rejected recently (in-memory). */
export async function findGasGrantCandidates(args: {
  db: Db;
  publicClient: PublicClient;
  router: Address;
  now: Date;
  cfg: Required<GasGrantConfig>;
  skip: Map<string, number>;
  permit2?: Address;
}): Promise<GasGrantCandidate[]> {
  const { db, publicClient, router, now, cfg, skip } = args;
  const permit2 = args.permit2 ?? CELO.permit2.address;
  const since = new Date(now.getTime() - cfg.windowMs);
  const rows = await db
    .select({ quoteId: quotes.id, payer: quotes.payer, plan: quotes.plan, invoiceId: quotes.invoiceId, merchant: invoices.merchantAddress })
    .from(quotes)
    .innerJoin(invoices, eq(quotes.invoiceId, invoices.id))
    .where(and(gt(quotes.createdAt, since), gt(quotes.expiresAt, now), eq(invoices.status, "open"), gt(invoices.expiresAt, now)))
    .orderBy(desc(quotes.createdAt))
    .limit(50);
  if (rows.length === 0) return [];

  const granted = new Set(
    (await db.select({ key: flags.key }).from(flags).where(like(flags.key, `${GAS_GRANT_FLAG_PREFIX}%`))).map((r) => r.key),
  );
  const seen = new Set<string>();
  const out: GasGrantCandidate[] = [];
  for (const r of rows) {
    if (out.length >= cfg.maxPerTick) break;
    let payer: Address;
    try {
      payer = getAddress(r.payer);
    } catch {
      continue;
    }
    const k = payer.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    if (granted.has(`${GAS_GRANT_FLAG_PREFIX}${k}`)) continue;
    if ((skip.get(k) ?? 0) > now.getTime()) continue;
    try {
      if (isAddressEqual(payer, getAddress(r.merchant))) continue;
    } catch {
      continue;
    }
    const legs = deserializePlan(r.plan as SerializedPlan).legs.filter((l) => l.kind === PullKind.PERMIT2 || l.kind === PullKind.ALLOWANCE);
    if (legs.length === 0) continue;

    const native = await publicClient.getBalance({ address: payer });
    if (native >= cfg.minPayerBalanceWei) {
      skip.set(k, now.getTime() + cfg.windowMs);
      continue;
    }
    let pick: Address | null = null;
    for (const l of legs) {
      const bal = await publicClient.readContract({ address: l.token, abi: erc20Abi, functionName: "balanceOf", args: [payer] });
      if (bal < l.amountIn) continue;
      // The transaction that needs gas is the ERC-20 approval: to Permit2 (PERMIT2 legs) or to the router (ALLOWANCE).
      const spender = l.kind === PullKind.PERMIT2 ? permit2 : router;
      const allowance = await publicClient.readContract({ address: l.token, abi: erc20Abi, functionName: "allowance", args: [payer, spender] });
      if (allowance < l.amountIn) {
        pick = l.token;
        break;
      }
    }
    if (!pick) {
      skip.set(k, now.getTime() + cfg.windowMs);
      continue;
    }
    out.push({ payer, invoiceId: r.invoiceId, quoteId: r.quoteId, token: pick });
  }
  return out;
}

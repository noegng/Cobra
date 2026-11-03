import { getAddress, verifyTypedData, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  PullKind,
  encodePath,
  randomInvoiceId,
  toBaseUnits,
  tokenBySymbol,
  type PaymentPlan,
  type PlannedLeg,
  type SolveResult,
  type SolverInput,
} from "@cobra/shared";
import { invoices, merchants, type Db } from "@cobra/db";
import { createTestDb } from "@cobra/db/testing";
import type { ApiDeps } from "../lib/server/api";
import { createMemoryRateLimiter } from "../lib/server/rate-limit";
import { hydrateTypedData, type ToSignEntry } from "../lib/wire";

// anvil public test keys — never funded on mainnet
export const PAYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
export const OTHER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
export const payer = privateKeyToAccount(PAYER_KEY);
export const other = privateKeyToAccount(OTHER_KEY);
export const MERCHANT_PAYOUT = getAddress("0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC");
export const ROUTER = getAddress("0x00000000000000000000000000000000c0b4a000");

export const USDC = tokenBySymbol("USDC")!;
export const USDT = tokenBySymbol("USDT")!;
export const WARS = tokenBySymbol("wARS")!;

export const T0 = Date.UTC(2026, 10, 2, 15, 0, 0);

export interface Fixture {
  db: Db;
  deps: ApiDeps;
  clock: { now: number };
  merchantId: string;
  invoiceId: Hex;
  solverCalls: SolverInput[];
  setSolver(fn: (input: SolverInput) => SolveResult): void;
}

export function planFor(input: SolverInput, now: number, legs?: PlannedLeg[]): PaymentPlan {
  return {
    legs: legs ?? [
      {
        token: USDC.address,
        amountIn: 1_470_000n,
        kind: PullKind.EIP3009,
        path: encodePath([USDC.address, USDT.address, WARS.address], [100, 100]),
        quotedOut: input.invoice.amountOut,
      },
    ],
    tokenOut: input.invoice.tokenOut,
    minOut: input.invoice.amountOut,
    costBps: 12,
    naiveCostBps: 40,
    savingsBps: 28,
    quotedAt: now,
    expiresAt: now + 60_000,
  };
}

export async function setup(opts: { amountLocal?: string; settlement?: Address; slug?: string } = {}): Promise<Fixture> {
  const db = await createTestDb();
  const clock = { now: T0 };
  const solverCalls: SolverInput[] = [];
  let solver: (input: SolverInput) => SolveResult = (input) => ({ ok: true, plan: planFor(input, clock.now) });

  const [m] = await db
    .insert(merchants)
    .values({
      telegramUserId: 1001n,
      telegramChatId: 1001n,
      displayName: "Café Luna",
      country: "AR",
      currency: "ARS",
      settlementToken: opts.settlement ?? WARS.address,
      payoutAddress: MERCHANT_PAYOUT,
      staticSlug: opts.slug ?? "cafe-luna",
      language: "es",
    })
    .returning();
  const amountLocal = opts.amountLocal ?? "2400";
  const invoiceId = randomInvoiceId();
  await db.insert(invoices).values({
    id: invoiceId,
    merchantId: m!.id,
    amountLocal,
    currency: "ARS",
    tokenOut: WARS.address,
    amountOut: toBaseUnits(amountLocal, WARS.decimals).toString(),
    merchantAddress: MERCHANT_PAYOUT,
    reference: "A-0001",
    status: "open",
    source: "chat",
    expiresAt: new Date(T0 + 10 * 60_000),
  });

  const deps: ApiDeps = {
    db,
    now: () => clock.now,
    chainId: 42220,
    router: ROUTER,
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    readPayerState: async () => ({
      balances: [{ token: USDC.address, amount: 5_000_000n }],
      permit2Allowances: { [USDC.address]: 0n, [WARS.address]: 10n ** 30n },
    }),
    verifyTypedData: (args) => verifyTypedData(args as never),
    getReferenceRates: async () => ({ USD: 1, ARS: 1 / 1650 }),
    solve: async (input) => {
      solverCalls.push(input);
      return solver(input);
    },
    rateLimiter: createMemoryRateLimiter(),
    env: {},
  };
  return {
    db,
    deps,
    clock,
    merchantId: m!.id,
    invoiceId,
    solverCalls,
    setSolver(fn) {
      solver = fn;
    },
  };
}

export function req(method: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/x", {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function signAll(entries: ToSignEntry[], account = payer): Promise<Hex[]> {
  const out: Hex[] = [];
  for (const e of entries) {
    const td = hydrateTypedData(e.typedData!);
    out.push(await account.signTypedData(td as Parameters<typeof account.signTypedData>[0]));
  }
  return out;
}

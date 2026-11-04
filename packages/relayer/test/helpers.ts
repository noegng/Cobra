/**
 * Test harness: a local anvil chain (public anvil test keys only), mock router/token, PGlite DB seeding.
 * Nothing here ever touches mainnet.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  custom,
  http,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
  type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import {
  CELO,
  encodeEip3009PullData,
  encodePath,
  encodePermit2PullData,
  eip3009TypedData,
  encodeTextileVenue,
  intentDigest,
  legNonce,
  permit2TypedData,
  PullKind,
  randomInvoiceId,
  serializeLeg,
  serializePlan,
  tokenBySymbol,
  type Leg,
  type OnchainInvoice,
  type PaymentPlan,
} from "@cobra/shared";
import { invoices, merchants, quotes, submissions, type Db } from "@cobra/db";
import { MOCK_EIP3009_TOKEN_BYTECODE, MOCK_ROUTER_BYTECODE } from "./fixtures/mocks";

// Well-known PUBLIC anvil dev keys (mnemonic "test test … junk"). Never used outside a local anvil.
export const ANVIL_KEYS = {
  relayer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  payer: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  other: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  deployer: "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
  relayer2: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
} as const satisfies Record<string, Hex>;

export const hasAnvil = spawnSync("anvil", ["--version"], { stdio: "ignore" }).status === 0;

export const WARS = tokenBySymbol("wARS")!.address;
export const USDT = tokenBySymbol("USDT")!.address;
export const MERCHANT: Address = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
export const ATTRIBUTION_CODE = "cobra_test";
export const RATES = { ARS: 1 / 1650, USD: 1 };

export const routerExtraAbi = parseAbi(["function payCount() view returns (uint256)", "function isPaid(bytes32) view returns (bool)"]);

export interface Anvil {
  url: string;
  proc: ChildProcess;
  publicClient: PublicClient;
  test: ReturnType<typeof createTestClient>;
  stop(): Promise<void>;
}

export async function startAnvil(chainId: number = foundry.id): Promise<Anvil> {
  const port = 20_000 + Math.floor(Math.random() * 30_000);
  const proc = spawn("anvil", ["--port", String(port), "--silent", "--chain-id", String(chainId)], { stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  const publicClient = createPublicClient({ chain: foundry, transport: http(url), pollingInterval: 50 }) as PublicClient;
  for (let i = 0; ; i++) {
    try {
      await publicClient.getChainId();
      break;
    } catch {
      if (i > 100) throw new Error("anvil did not start");
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const test = createTestClient({ chain: foundry, mode: "anvil", transport: http(url) });
  return {
    url,
    proc,
    publicClient,
    test,
    async stop() {
      proc.kill("SIGKILL");
    },
  };
}

export async function deployMocks(a: Anvil): Promise<{ router: Address; token3009: Address }> {
  const wallet = createWalletClient({ account: privateKeyToAccount(ANVIL_KEYS.deployer), chain: foundry, transport: http(a.url) });
  const deploy = async (bytecode: Hex, abi: readonly unknown[] = [], args: unknown[] = []) => {
    const hash = await wallet.deployContract({ abi: abi as never, bytecode, args: args as never });
    const r = await a.publicClient.waitForTransactionReceipt({ hash });
    return r.contractAddress!;
  };
  const router = await deploy(MOCK_ROUTER_BYTECODE);
  const token3009 = await deploy(
    MOCK_EIP3009_TOKEN_BYTECODE,
    parseAbi(["constructor(string name, string version)"]),
    ["USDC", "2"],
  );
  return { router, token3009 };
}

/** Transport that fails every eth_sendRawTransaction AFTER signing (simulates a crash / network loss at broadcast). */
export function droppingTransport(url: string): Transport {
  const inner = http(url)({ chain: foundry });
  return custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      if (method === "eth_sendRawTransaction") throw new Error("simulated network failure at broadcast");
      return inner.request({ method, params } as never);
    },
  });
}

let merchantSeq = 0;
export async function seedMerchant(db: Db) {
  merchantSeq++;
  const [m] = await db
    .insert(merchants)
    .values({
      telegramUserId: BigInt(1000 + merchantSeq),
      telegramChatId: BigInt(1000 + merchantSeq),
      country: "AR",
      currency: "ARS",
      settlementToken: WARS,
      payoutAddress: MERCHANT,
      staticSlug: `m-${merchantSeq}-${Math.random().toString(36).slice(2)}`,
    })
    .returning();
  return m!;
}

export interface SeedOpts {
  router: Address;
  token3009: Address;
  chainId?: number;
  /** wARS base units. Default 4500 wARS (~2.7 USD at RATES). */
  amountOut?: bigint;
  expiresInSec?: number;
  quoteExpiresInMs?: number;
  kinds?: ("eip3009" | "permit2")[];
  signerKey?: Hex; // who signs the legs (default payer)
  merchant?: Address; // invoice merchant payout address (default MERCHANT)
  /** WS13: make the (single) eip3009 leg a Textile RFQ leg and record the rfqId in the stored quote plan. */
  textile?: { rfqId: string };
}

export async function seedSubmission(db: Db, o: SeedOpts) {
  const chainId = o.chainId ?? foundry.id;
  const m = await seedMerchant(db);
  const id = randomInvoiceId();
  const expiresAt = new Date((Math.floor(Date.now() / 1000) + (o.expiresInSec ?? 600)) * 1000);
  const amountOut = o.amountOut ?? 4500n * 10n ** 18n;
  await db.insert(invoices).values({
    id,
    merchantId: m.id,
    amountLocal: "4500",
    currency: "ARS",
    tokenOut: WARS,
    amountOut: amountOut.toString(),
    merchantAddress: o.merchant ?? MERCHANT,
    expiresAt,
  });
  const inv: OnchainInvoice = {
    id,
    merchant: o.merchant ?? MERCHANT,
    tokenOut: WARS,
    amountOut,
    deadline: BigInt(Math.floor(expiresAt.getTime() / 1000)),
  };
  const payerAcc = privateKeyToAccount(ANVIL_KEYS.payer);
  const signAcc = privateKeyToAccount(o.signerKey ?? ANVIL_KEYS.payer);
  const kinds = o.kinds ?? ["eip3009"];
  const planned = kinds.map((k) =>
    k === "eip3009"
      ? {
          token: o.token3009,
          amountIn: 3_000_000n,
          kind: PullKind.EIP3009,
          path: o.textile ? encodeTextileVenue([{ order: "0xabcd", sig: "0x1234" }]) : encodePath([o.token3009, WARS], [100]),
        }
      : { token: USDT, amountIn: 1_000_000n, kind: PullKind.PERMIT2, path: encodePath([USDT, WARS], [100]) },
  );
  const digest = intentDigest(o.router, chainId, inv, payerAcc.address, planned);
  const legs: Leg[] = [];
  for (const [i, p] of planned.entries()) {
    if (p.kind === PullKind.EIP3009) {
      const validAfter = 0n;
      const validBefore = inv.deadline;
      const sig = await signAcc.signTypedData(
        eip3009TypedData({
          token: p.token,
          tokenDomain: { name: "USDC", version: "2" },
          chainId,
          from: payerAcc.address,
          router: o.router,
          value: p.amountIn,
          validAfter,
          validBefore,
          nonce: legNonce(digest, i),
        }) as never,
      );
      legs.push({ ...p, pullData: encodeEip3009PullData(validAfter, validBefore, sig) });
    } else {
      const nonce = BigInt(legNonce(digest, i));
      const sig = await signAcc.signTypedData(
        permit2TypedData({
          permit2: CELO.permit2.address,
          chainId,
          token: p.token,
          amount: p.amountIn,
          router: o.router,
          nonce,
          deadline: inv.deadline,
          invoice: inv,
          payer: payerAcc.address,
          legs: planned,
        }) as never,
      );
      legs.push({ ...p, pullData: encodePermit2PullData(nonce, inv.deadline, sig) });
    }
  }
  const plan: PaymentPlan = {
    legs: planned.map((p) => ({ ...p, quotedOut: amountOut })),
    tokenOut: WARS,
    minOut: amountOut,
    costBps: 10,
    naiveCostBps: null,
    savingsBps: 0,
    quotedAt: Date.now(),
    expiresAt: Date.now() + (o.quoteExpiresInMs ?? 60_000),
  };
  const [q] = await db
    .insert(quotes)
    .values({
      invoiceId: id,
      payer: payerAcc.address,
      plan: o.textile ? { ...serializePlan(plan), venue: "textile", textile: { rfqId: o.textile.rfqId } } : serializePlan(plan),
      expiresAt: new Date(Date.now() + (o.quoteExpiresInMs ?? 60_000)),
    })
    .returning();
  const [s] = await db
    .insert(submissions)
    .values({ invoiceId: id, quoteId: q!.id, payer: payerAcc.address, legs: legs.map(serializeLeg) })
    .returning();
  return { invoiceId: id, submissionId: s!.id, inv, legs, payer: payerAcc.address };
}

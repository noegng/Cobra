/**
 * Test harness: a local anvil chain (spawned per test file), the PaidEmitter fixture contract,
 * a PGlite DB with seeded merchant/invoices, and a recording Notifier.
 * Uses anvil's PUBLIC test account #0 only — never a real key.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  custom,
  getAddress,
  http,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { createTestDb } from "@cobra/db/testing";
import { invoices, merchants, type Db } from "@cobra/db";
import type { Notifier } from "@cobra/shared";

/** Anvil default account #0 — publicly known test key, holds only local test ETH. */
const ANVIL_KEY_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
export const account = privateKeyToAccount(ANVIL_KEY_0);

export const MERCHANT = getAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
export const PAYER = getAddress("0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC");
export const OTHER = getAddress("0x90F79bf6EB2c4F870365E3c3a09F92FB4b6b5f84");
export const WARS = getAddress("0x0dc4f92879b7670e5f4e4e6e3c801d229129d90d");
export const WBRL = getAddress("0xd76f5faf6888e24d9f04bf92a0c8b921fe4390e0");

const emitterAbi = parseAbi([
  "function emitPaid(bytes32 invoiceId, address payer, address merchant, address tokenOut, uint256 amountOut)",
]);
const emitterBytecode = readFileSync(resolve(import.meta.dirname, "fixtures/PaidEmitter.bin"), "utf8").trim() as Hex;

export interface Anvil {
  url: string;
  stop(): Promise<void>;
}

function anvilBin(): string {
  return process.env.ANVIL_BIN ?? join(homedir(), ".foundry/bin/anvil");
}

export async function startAnvil(): Promise<Anvil> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = 20_000 + Math.floor(Math.random() * 30_000);
    const proc: ChildProcess = spawn(anvilBin(), ["--port", String(port), "--silent", "--chain-id", "31337"], { stdio: "ignore" });
    let exited = false;
    proc.once("exit", () => (exited = true));
    const url = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 10_000;
    while (!exited && Date.now() < deadline) {
      try {
        const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
        if (r.ok) {
          return {
            url,
            stop: () =>
              new Promise<void>((res) => {
                if (exited) return res();
                proc.once("exit", () => res());
                proc.kill("SIGTERM");
              }),
          };
        }
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    proc.kill("SIGKILL");
  }
  throw new Error("could not start anvil");
}

export interface RpcCall {
  method: string;
  params: unknown;
}

/**
 * Public client over a custom transport so tests can observe and sabotage RPC calls.
 * `maxLogsRange`: eth_getLogs over more blocks than this fails like a real provider would.
 * `faults`: the next `remaining` calls to `method` fail with a generic internal error.
 */
export function makeClients(url: string, opts: { maxLogsRange?: number; calls?: RpcCall[]; faults?: { method: string; remaining: number } } = {}) {
  let id = 0;
  const transport = custom(
    {
      async request({ method, params }: { method: string; params?: unknown }) {
        opts.calls?.push({ method, params });
        if (opts.faults && opts.faults.method === method && opts.faults.remaining > 0) {
          opts.faults.remaining--;
          throw Object.assign(new Error("upstream connect error"), { code: -32603 });
        }
        if (method === "eth_getLogs" && opts.maxLogsRange !== undefined) {
          const [f] = params as [{ fromBlock: Hex; toBlock: Hex }];
          const span = BigInt(f.toBlock) - BigInt(f.fromBlock) + 1n;
          if (span > BigInt(opts.maxLogsRange)) {
            throw Object.assign(new Error(`block range is too wide (max ${opts.maxLogsRange})`), { code: -32000 });
          }
        }
        const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: params ?? [] }) });
        const j = (await r.json()) as { result?: unknown; error?: { code: number; message: string } };
        if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code });
        return j.result;
      },
    },
    { retryCount: 0 },
  );
  const publicClient = createPublicClient({ chain: foundry, transport }) as PublicClient;
  return { publicClient };
}

export function chainClients(url: string) {
  const transport = http(url, { retryCount: 0 });
  const publicClient = createPublicClient({ chain: foundry, transport });
  const wallet = createWalletClient({ account, chain: foundry, transport });
  const testClient = createTestClient({ mode: "anvil", chain: foundry, transport });
  return {
    publicClient,
    testClient,
    async deployEmitter(): Promise<{ address: Address; block: bigint }> {
      const hash = await wallet.deployContract({ abi: emitterAbi, bytecode: emitterBytecode });
      const rcpt = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 20 });
      if (!rcpt.contractAddress) throw new Error("deploy failed");
      return { address: rcpt.contractAddress, block: rcpt.blockNumber };
    },
    async emitPaid(
      router: Address,
      p: { invoiceId: Hex; payer?: Address; merchant?: Address; tokenOut?: Address; amountOut: bigint },
    ): Promise<{ txHash: Hex; block: bigint; logIndex: number; timestamp: bigint }> {
      const hash = await wallet.writeContract({
        address: router,
        abi: emitterAbi,
        functionName: "emitPaid",
        args: [p.invoiceId, p.payer ?? PAYER, p.merchant ?? MERCHANT, p.tokenOut ?? WARS, p.amountOut],
      });
      const rcpt = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 20 });
      const block = await publicClient.getBlock({ blockNumber: rcpt.blockNumber });
      return { txHash: hash, block: rcpt.blockNumber, logIndex: rcpt.logs[0]!.logIndex, timestamp: block.timestamp };
    },
  };
}

let seq = 0;
export function randomInvoiceId(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Buffer.from(bytes).toString("hex")}` as Hex;
}

export async function seedMerchant(db: Db, over: Partial<typeof merchants.$inferInsert> = {}) {
  seq++;
  const [m] = await db
    .insert(merchants)
    .values({
      telegramUserId: BigInt(1000 + seq),
      telegramChatId: BigInt(1000 + seq),
      country: "AR",
      currency: "ARS",
      settlementToken: WARS,
      payoutAddress: MERCHANT,
      staticSlug: `kiosco-${seq}`,
      ...over,
    })
    .returning();
  return m!;
}

export async function seedInvoice(db: Db, merchantId: string, over: Partial<typeof invoices.$inferInsert> = {}) {
  const [inv] = await db
    .insert(invoices)
    .values({
      id: randomInvoiceId(),
      merchantId,
      amountLocal: "4500",
      currency: "ARS",
      tokenOut: WARS,
      amountOut: (4500n * 10n ** 18n).toString(),
      merchantAddress: MERCHANT,
      reference: "A-0042",
      expiresAt: new Date(Date.now() + 600_000),
      ...over,
    })
    .returning();
  return inv!;
}

export async function freshDb(): Promise<Db> {
  return createTestDb();
}

export class RecordingNotifier implements Notifier {
  paid: Parameters<Notifier["invoicePaid"]>[0][] = [];
  texts: { merchantId: string; message: string }[] = [];
  attempts = 0;
  /** Number of upcoming calls that should throw. */
  failNext = 0;
  async invoicePaid(args: Parameters<Notifier["invoicePaid"]>[0]): Promise<void> {
    this.attempts++;
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("telegram down");
    }
    this.paid.push(args);
  }
  async text(merchantId: string, message: string): Promise<void> {
    this.attempts++;
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("telegram down");
    }
    this.texts.push({ merchantId, message });
  }
}

export async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, timeoutMs = 10_000, label = "condition"): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

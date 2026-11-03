/**
 * End-to-end harness: an anvil FORK of Celo mainnet + the real packages wired the way apps/worker/src/main.ts and
 * the Next.js routes wire them. Everything that writes goes to 127.0.0.1 anvil. Only anvil's public test keys are used.
 *
 *   bot (grammY, Telegram API intercepted)  ->  PGlite  <-  web handlers (quote/submit/status, injected deps)
 *   relayer (+ gas grant) + indexer + notifier -> anvil fork -> the deployed CobraRouter
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import {
  concatHex,
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  erc20Abi,
  getAddress,
  http,
  keccak256,
  maxUint256,
  numberToHex,
  pad,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { CELO, CELO_CHAIN_ID, HACKATHON_ATTRIBUTION_CODE, TOKENS, encodePath, tokenBySymbol, type ReferenceRates, type TokenInfo } from "@cobra/shared";
import { invoices, payments, submissions, type Db } from "@cobra/db";
import { createTestDb } from "@cobra/db/testing";
import { buildBot, createNotifierWithApi, type CobraBot } from "@cobra/bot";
import { createRelayerSigner, startRelayer, type Stoppable } from "@cobra/relayer";
import { startIndexer } from "@cobra/indexer";
import { createUniswapQuoter, solve } from "@cobra/solver";
import { handleGetInvoice, handleQuote, handleStatus, handleSubmit, type ApiDeps } from "../../../web/lib/server/api";
import { readPayerState, type MulticallClient } from "../../../web/lib/server/balances";
import { createMemoryRateLimiter } from "../../../web/lib/server/rate-limit";
import { approveCalldata, attributionSuffix } from "../../../web/lib/allowance";
import { hydrateTypedData, type QuoteError, type QuoteOk, type StatusResponse } from "../../../web/lib/wire";

// grammY is not a dependency of this package: derive its types from the bot's own signatures.
type Update = Parameters<CobraBot["handleUpdate"]>[0];
type Api = CobraBot["api"];
type BotInfo = NonNullable<NonNullable<Parameters<typeof buildBot>[1]>["botInfo"]>;

/** The deployed router on Celo mainnet (docs/research/onchain-verification.md). */
export const DEPLOYED_ROUTER: Address = getAddress("0xfe38683105fa36ee664acefe7e714ba93492e458");
export const PUBLIC_RPC = process.env.E2E_FORK_URL || "https://forno.celo.org";
export const ATTRIBUTION_CODE = HACKATHON_ATTRIBUTION_CODE;

// Well-known PUBLIC anvil dev keys (mnemonic "test test ... junk"). Never used outside a local anvil.
const KEYS = {
  relayer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // #0
  merchant: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // #2
  payerUsdt: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", // #3
  payerWars: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a", // #4
  payerSplit: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba", // #5
  payerBrl: "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e", // #6
  attacker: "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356", // #7
} as const satisfies Record<string, Hex>;
const EXPECTED_ADDRESSES: Record<keyof typeof KEYS, Address> = {
  relayer: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  merchant: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  payerUsdt: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
  payerWars: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
  payerSplit: "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
  payerBrl: "0x976EA74026E726554dB657fA54763abd0C3a0aa9",
  attacker: "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955",
};
export const accounts = Object.fromEntries(
  (Object.keys(KEYS) as (keyof typeof KEYS)[]).map((k) => {
    const a = privateKeyToAccount(KEYS[k]);
    if (a.address !== EXPECTED_ADDRESSES[k]) throw new Error(`unexpected anvil key for ${k}`); // guards against a typo'd key
    return [k, a];
  }),
) as Record<keyof typeof KEYS, PrivateKeyAccount>;

// ---------------------------------------------------------------------------------------------- anvil

/** Payout address of the Brazilian merchant: anvil #8 (address only, no key). */
export const BR_MERCHANT: Address = "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f";

export const hasAnvil = spawnSync("anvil", ["--version"], { stdio: "ignore" }).status === 0;

async function rpc<T>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(8_000),
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result as T;
}

/** Latest block of the public RPC, or null when the fork source is unreachable (the suite then skips). */
export async function probeForkSource(): Promise<bigint | null> {
  try {
    const chainId = await rpc<string>(PUBLIC_RPC, "eth_chainId");
    if (Number(chainId) !== CELO_CHAIN_ID) return null;
    return BigInt(await rpc<string>(PUBLIC_RPC, "eth_blockNumber"));
  } catch {
    return null;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

export interface Anvil {
  url: string;
  forkBlock: bigint;
  proc: ChildProcess;
  publicClient: PublicClient;
  test: ReturnType<typeof createTestClient>;
  stop(): Promise<void>;
}

export async function startForkedAnvil(headBlock: bigint): Promise<Anvil> {
  const port = await freePort();
  const forkBlock = process.env.E2E_FORK_BLOCK ? BigInt(process.env.E2E_FORK_BLOCK) : headBlock - 20n;
  const proc = spawn(
    "anvil",
    ["--fork-url", PUBLIC_RPC, "--fork-block-number", String(forkBlock), "--port", String(port), "--chain-id", String(CELO_CHAIN_ID), "--silent"],
    { stdio: "ignore" },
  );
  const url = `http://127.0.0.1:${port}`;
  const publicClient = createPublicClient({ chain: celo, transport: http(url), pollingInterval: 50 }) as PublicClient;
  for (let i = 0; ; i++) {
    try {
      await publicClient.getChainId();
      break;
    } catch {
      if (i > 300) {
        proc.kill("SIGKILL");
        throw new Error("anvil did not start");
      }
      await sleep(100);
    }
  }
  const test = createTestClient({ chain: celo, mode: "anvil", transport: http(url) });
  // anvil's public keys are EIP-7702-delegated to sweeper contracts on Celo mainnet: tokens would then verify
  // signatures through ERC-1271 ("TetherToken: invalid signature"). Make them plain EOAs again, on the fork only.
  for (const a of [...Object.values(accounts).map((x) => x.address), BR_MERCHANT]) await test.setCode({ address: a, bytecode: "0x" });
  return {
    url,
    forkBlock,
    proc,
    publicClient,
    test,
    async stop() {
      proc.kill("SIGKILL");
    },
  };
}

// ---------------------------------------------------------------------------------------------- funding

/** ERC-7201 namespaced ERC20 storage base used by the wFIAT proxies (balances mapping at offset 0). */
const OZ_ERC20_STORAGE = 0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00n;

function balanceSlot(token: TokenInfo, holder: Address): Hex {
  const base = token.symbol === "USDC" ? 9n : token.symbol === "USDT" || token.symbol === "USAT" ? 51n : OZ_ERC20_STORAGE;
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [holder, base]));
}

/** Sets an ERC-20 balance on the LOCAL anvil by writing storage (impossible on mainnet; this is the fork only). */
export async function setTokenBalance(a: Anvil, symbol: string, holder: Address, amount: bigint): Promise<void> {
  const token = tokenBySymbol(symbol)!;
  await a.test.setStorageAt({ address: token.address, index: balanceSlot(token, holder), value: pad(numberToHex(amount), { size: 32 }) });
  const got = await a.publicClient.readContract({ address: token.address, abi: erc20Abi, functionName: "balanceOf", args: [holder] });
  if (got !== amount) throw new Error(`could not fund ${symbol}: storage layout changed (balance ${got})`);
}

export const balanceOf = (a: Anvil, symbol: string, who: Address) =>
  a.publicClient.readContract({ address: tokenBySymbol(symbol)!.address, abi: erc20Abi, functionName: "balanceOf", args: [who] });

// ---------------------------------------------------------------------------------------------- misc

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 60_000, everyMs = 150): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(everyMs);
  }
}

/** Reference rates (USD per unit) taken from the fork's own Uniswap pools: the price guard then tests plumbing, not FX data. */
async function poolRates(a: Anvil): Promise<ReferenceRates> {
  const quoter = createUniswapQuoter(a.publicClient, CELO.uniswapV3.quoterV2.address);
  const usdt = tokenBySymbol("USDT")!;
  const out: ReferenceRates = {};
  for (const [sym, ccy] of [["wARS", "ARS"], ["wBRL", "BRL"]] as const) {
    const w = tokenBySymbol(sym)!;
    const wholeOut = 1000n;
    const { amountIn } = await quoter.quoteExactOutput(encodePath([usdt.address, w.address], [100]), wholeOut * 10n ** BigInt(w.decimals));
    out[ccy] = Number(amountIn) / 10 ** usdt.decimals / Number(wholeOut);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- telegram

export const BOT_TOKEN = "123456:E2E-TOKEN";
export const BASE_URL = "https://cobra.e2e.test";
const BOT_INFO: BotInfo = {
  id: 999,
  is_bot: true,
  first_name: "Cobra",
  username: "cobra_e2e_bot",
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

export interface TgCall {
  method: string;
  payload: Record<string, unknown>;
}

/** Nothing leaves the machine: every Telegram Bot API call is recorded and answered with a canned success. */
function interceptTelegram(api: Api): TgCall[] {
  const calls: TgCall[] = [];
  let msgId = 100;
  api.config.use(async (_prev, method, payload) => {
    const p = (payload ?? {}) as Record<string, unknown>;
    calls.push({ method, payload: p });
    const result = method.startsWith("send") ? { message_id: ++msgId, date: 0, chat: { id: p.chat_id, type: "private", first_name: "x" }, text: p.text } : true;
    return { ok: true, result } as never;
  });
  return calls;
}

let updateSeq = 1000;
export const textUpdate = (userId: number, text: string): Update =>
  ({
    update_id: updateSeq++,
    message: {
      message_id: updateSeq,
      date: 0,
      chat: { id: userId, type: "private", first_name: "Ana" },
      from: { id: userId, is_bot: false, first_name: "Ana", language_code: "es" },
      text,
      ...(text.startsWith("/") ? { entities: [{ type: "bot_command", offset: 0, length: text.split(/\s/)[0]!.length }] } : {}),
    },
  }) as Update;

export const callbackUpdate = (userId: number, data: string): Update =>
  ({
    update_id: updateSeq++,
    callback_query: {
      id: `cb${updateSeq}`,
      from: { id: userId, is_bot: false, first_name: "Ana", language_code: "es" },
      chat_instance: "ci",
      data,
      message: { message_id: 1, date: 0, chat: { id: userId, type: "private", first_name: "Ana" }, text: "..." },
    },
  }) as Update;

// ---------------------------------------------------------------------------------------------- the stack

export interface Stack {
  anvil: Anvil;
  db: Db;
  bot: CobraBot;
  tg: TgCall[];
  deps: ApiDeps;
  /** Relayer-side log lines (info/warn/alert), for diagnostics on failure. */
  logs: string[];
  rates: ReferenceRates;
  /** Messages sent through the Telegram API to a chat. */
  messagesTo(chatId: number): string[];
  stop(): Promise<void>;
}

export interface StackOptions {
  gasGrantWei?: bigint;
}

export async function startStack(anvil: Anvil, opts: StackOptions = {}): Promise<Stack> {
  const db = await createTestDb();
  const logs: string[] = [];
  const log = (svc: string) => (msg: string, extra?: Record<string, unknown>) =>
    logs.push(`${svc} ${msg} ${JSON.stringify(extra ?? {}, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);

  const rates = await poolRates(anvil);

  // --- bot + Telegram interception (the notifier shares the intercepted Api, like production shares one token)
  const bot = buildBot(
    { token: BOT_TOKEN, db, anthropicApiKey: "", publicBaseUrl: BASE_URL },
    { botInfo: BOT_INFO, model: null, env: {}, log: log("bot") },
  );
  const tg = interceptTelegram(bot.api);
  const notifier = createNotifierWithApi(bot.api, db);

  // --- web API deps, as apps/web/lib/server/deps.ts builds them but pointed at anvil
  const quoter = createUniswapQuoter(anvil.publicClient, CELO.uniswapV3.quoterV2.address);
  const deps: ApiDeps = {
    db,
    now: () => Date.now(),
    chainId: CELO_CHAIN_ID,
    router: DEPLOYED_ROUTER,
    permit2: CELO.permit2.address,
    readPayerState: (payer) => readPayerState(anvil.publicClient as unknown as MulticallClient, payer, CELO.permit2.address),
    getReferenceRates: async () => rates,
    solve: (input, o) => solve(input, { quoter, capUsd: o.capUsd, permit2Ready: o.permit2Ready, feeTiers: [100] }),
    verifyTypedData: (args) => anvil.publicClient.verifyTypedData(args as Parameters<typeof anvil.publicClient.verifyTypedData>[0]),
    rateLimiter: createMemoryRateLimiter(),
    env: {},
  };

  // --- worker wiring, as apps/worker/src/main.ts (relayer signer is guarded + ERC-8021 attributed)
  const signer = createRelayerSigner({
    privateKey: KEYS.relayer,
    rpcUrl: anvil.url,
    attributionCode: ATTRIBUTION_CODE,
    router: DEPLOYED_ROUTER,
    db,
    rates,
    env: {},
  });
  const relayer: Stoppable = startRelayer({
    db,
    publicClient: anvil.publicClient,
    walletClient: signer.walletClient,
    router: DEPLOYED_ROUTER,
    notifier,
    pollIntervalMs: 200,
    log: log("relayer"),
    gasGrant: { amountWei: opts.gasGrantWei ?? 50_000_000_000_000_000n, dailyMax: 20 },
  });
  const indexer: Stoppable = startIndexer({
    db,
    publicClient: anvil.publicClient,
    router: DEPLOYED_ROUTER,
    fromBlock: anvil.forkBlock + 1n,
    confirmations: 0, // anvil automines: there is nothing to wait for
    pollIntervalMs: 200,
    notifier,
    log: log("indexer"),
  });

  return {
    anvil,
    db,
    bot,
    tg,
    deps,
    logs,
    rates,
    messagesTo: (chatId) => tg.filter((c) => (c.method === "sendMessage" || c.method === "sendPhoto") && c.payload.chat_id === chatId).map((c) => String(c.payload.text ?? c.payload.caption ?? "")),
    async stop() {
      await Promise.allSettled([relayer.stop(), indexer.stop()]);
    },
  };
}

// ---------------------------------------------------------------------------------------------- merchant (bot)

export const MERCHANT_TG_ID = 4242;

export async function onboardMerchant(s: Stack, country: "AR" | "BR" = "AR", tgId = MERCHANT_TG_ID, payout: Address = accounts.merchant.address) {
  await s.bot.handleUpdate(textUpdate(tgId, "/start"));
  if (country === "BR") await s.bot.handleUpdate(callbackUpdate(tgId, "lang:pt"));
  await s.bot.handleUpdate(callbackUpdate(tgId, `country:${country}`));
  await s.bot.handleUpdate(textUpdate(tgId, payout));
}

/** `cobrar <amount> <description>` through the bot; returns the new invoice row and the caption of the QR message. */
export async function charge(s: Stack, text: string, tgId = MERCHANT_TG_ID) {
  const known = new Set((await s.db.select().from(invoices)).map((r) => r.id));
  const before = s.tg.length;
  await s.bot.handleUpdate(textUpdate(tgId, text));
  const row = (await s.db.select().from(invoices)).find((r) => !known.has(r.id));
  if (!row) throw new Error(`bot created no invoice for "${text}"`);
  const caption = s.tg
    .slice(before)
    .filter((c) => c.method === "sendPhoto")
    .map((c) => String(c.payload.caption))
    .at(-1);
  return { invoice: row, caption: caption ?? "" };
}

// ---------------------------------------------------------------------------------------------- payer (what the pay page does)

const post = (path: string, body: unknown) =>
  new Request(`${BASE_URL}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.7" }, body: JSON.stringify(body) });

export async function apiQuote(s: Stack, invoiceId: string, payer: Address): Promise<{ status: number; body: QuoteOk & QuoteError }> {
  const res = await handleQuote(post(`/api/invoices/${invoiceId}/quote`, { payer }), invoiceId, s.deps);
  return { status: res.status, body: (await res.json()) as QuoteOk & QuoteError };
}

export async function apiSubmit(s: Stack, invoiceId: string, quoteId: string, signatures: Hex[]) {
  const res = await handleSubmit(post(`/api/invoices/${invoiceId}/submit`, { quoteId, signatures }), invoiceId, s.deps);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

export async function apiStatus(s: Stack, invoiceId: string): Promise<StatusResponse> {
  const res = await handleStatus(new Request(`${BASE_URL}/api/invoices/${invoiceId}/status`, { headers: { "x-forwarded-for": "198.51.100.7" } }), invoiceId, s.deps);
  return (await res.json()) as StatusResponse;
}

export async function apiInvoice(s: Stack, invoiceId: string) {
  const res = await handleGetInvoice(new Request(`${BASE_URL}/api/invoices/${invoiceId}`, { headers: { "x-forwarded-for": "198.51.100.7" } }), invoiceId, s.deps);
  return (await res.json()) as { status: string; amountOut: string; payoutAddress: Address };
}

/** Signs every leg exactly like pay-page.tsx: hydrate the wire typed data, then signTypedData with the payer's account. */
export async function signQuote(account: PrivateKeyAccount, quote: QuoteOk): Promise<Hex[]> {
  const sigs: Hex[] = [];
  for (const entry of quote.toSign) {
    if (!entry.typedData) throw new Error("allowance leg cannot be relayed");
    sigs.push(await account.signTypedData(hydrateTypedData(entry.typedData) as Parameters<typeof account.signTypedData>[0]));
  }
  return sigs;
}

/** The one-time Permit2 approval a wFIAT payer sends themselves (ERC-8021 tagged, as the page does). */
export async function sendPermit2Approval(a: Anvil, account: PrivateKeyAccount, token: Address): Promise<Hex> {
  const wallet = createWalletClient({ account, chain: celo, transport: http(a.url) });
  const hash = await wallet.sendTransaction({
    to: token,
    data: approveCalldata(CELO.permit2.address, maxUint256, attributionSuffix(ATTRIBUTION_CODE)),
  });
  const r = await a.publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error("approval reverted");
  return hash;
}

// ---------------------------------------------------------------------------------------------- DB readers

export async function paymentOf(s: Stack, invoiceId: string) {
  return (await s.db.select().from(payments)).find((p) => p.invoiceId === invoiceId) ?? null;
}

export async function submissionsOf(s: Stack, invoiceId: string) {
  return (await s.db.select().from(submissions)).filter((r) => r.invoiceId === invoiceId);
}

export async function invoiceRow(s: Stack, invoiceId: string) {
  return (await s.db.select().from(invoices)).find((r) => r.id === invoiceId)!;
}

export const suffixOf = (code: string): Hex => concatHex([attributionSuffix(code)!]);
export { TOKENS };

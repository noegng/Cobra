/**
 * The ONLY code path in Cobrá that turns a private key into signed transactions.
 *
 * Guards applied to EVERY send, in this order (fail closed):
 *   1. `to` must be the configured router (no contract creation, no other target), value must be 0;
 *   2. calldata must decode as `CobraRouter.pay(...)` (selector + full ABI decode);
 *   3. kill switch (env KILL_SWITCH or flags.kill_switch) must be off;
 *   4. USD caps (flags.caps): invoice amountOut × reference rate ≤ perPaymentUsd, and the rolling-24h total of
 *      relayed invoices (+ this one) ≤ perDayUsd, and the same total restricted to this merchant payout address
 *      (≤ perMerchantDayUsd) and to this payer (≤ perPayerDayUsd), so one actor cannot exhaust the shared
 *      budget. payer == invoice.merchant (self-payment) is refused outright. Unknown token / missing rate => refused;
 *   5. the ERC-8021 attribution suffix is appended by `withAttribution(code)` from @celo/attribution-tags.
 *
 * The key never leaves this module and is never logged. The exposed `walletClient` holds only the address
 * (json-rpc style account); every signing action on it is either guarded or blocked.
 *
 * `onSigned` lets the caller persist (hash, nonce) BEFORE the raw tx is broadcast — the basis of idempotent restarts.
 *
 * Gas grant (`grantGas`): the only other transaction shape this signer allows. A payer who holds wFIAT but no CELO
 * cannot send the one Permit2 approval wFIAT needs (no EIP-3009), so the agent sends them a tiny amount of CELO.
 * Guards, fail closed: kill switch off; 0 < value ≤ GAS_GRANT_MAX_WEI; target is not the router / zero / self and has
 * no contract code (an EIP-7702 delegation designator is accepted); at most ONE grant per address, ever (row
 * `flags.gas_grant:<address>` reserved before signing); at most `dailyMax` grants per rolling 24 h; calldata is
 * exactly the ERC-8021 suffix (checked again at signTransaction).
 */
import {
  createPublicClient,
  createWalletClient,
  parseEther,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  http,
  isAddressEqual,
  keccak256,
  parseAbi,
  toFunctionSelector,
  type Address,
  type Chain,
  type Hash,
  type Hex,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, toAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { and, count, eq, gte, inArray, isNotNull, like, ne } from "drizzle-orm";
import { toDataSuffix, toRoleDataSuffix, withAttribution } from "@celo/attribution-tags";
import { CELO, cobraRouterAbi, tokenByAddress, type Currency, type Leg, type OnchainInvoice } from "@cobra/shared";
import { DEFAULT_CAPS, flags, getCaps, invoices, isKillSwitchOn, submissions, type Db } from "@cobra/db";
import { resolveRates, scaledToUsd, usdToScaled, usdValueScaled, type RatesSource } from "./rates";

export type RefusalCode =
  | "wrong_target"
  | "wrong_selector"
  | "value_not_zero"
  | "kill_switch"
  | "cap_per_payment"
  | "cap_per_day"
  | "cap_per_merchant_day"
  | "cap_per_payer_day"
  | "self_payment"
  | "zero_amount"
  | "unknown_token"
  | "missing_rate"
  | "blocked_method"
  | "grant_value"
  | "grant_target"
  | "grant_already_given"
  | "grant_daily_cap";

export class SignerRefusedError extends Error {
  constructor(
    readonly code: RefusalCode,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "SignerRefusedError";
  }
}

export const PAY_SELECTOR: Hex = toFunctionSelector(
  "pay((bytes32,address,address,uint256,uint256),address,(address,uint256,uint8,bytes,bytes)[])",
);

export interface TokenMeta {
  decimals: number;
  currency: Currency;
}

export interface RelayerSignerOptions {
  /** 0x-prefixed 32-byte hex, from the VPS EnvironmentFile only. Never logged. */
  privateKey: Hex;
  rpcUrl: string;
  /** ERC-8021 code (Schema 0), e.g. codeFromHostname("cobra.example"). [a-z0-9_]{1,32} */
  attributionCode: string;
  /**
   * Optional ERC-8021 Schema 2 "wallet" role code for this relayer. When set, every tx carries
   * toRoleDataSuffix({ app: attributionCode, wallet: walletCode }) instead of the Schema 0 tag
   * (withAttribution leaves an existing Schema 2 tag untouched).
   */
  walletAttributionCode?: string;
  router: Address;
  db: Db;
  rates: RatesSource;
  /** Default: viem `celo` (42220). Tests pass a local anvil chain. */
  chain?: Chain;
  /** Override the transport (tests). Default http(rpcUrl). */
  transport?: Transport;
  /** Token metadata for caps. Default: shared TOKENS registry (unknown token => refused). */
  tokenMeta?: (token: Address) => TokenMeta | undefined;
  /** Env used for the kill switch (default process.env). */
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

export interface SendRequest {
  to: Address;
  data: Hex;
  value?: bigint;
  nonce?: number;
  gas?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  /** Awaited after signing and BEFORE broadcast. If it throws, nothing is broadcast. */
  onSigned?: (tx: { hash: Hash; nonce: number }) => Promise<void>;
}

/** Hard ceiling of a single gas grant, whatever the caller asks (0.1 CELO ≈ 0.007 USD on 2026-11-03). */
export const GAS_GRANT_MAX_WEI = parseEther("0.1");
export const GAS_GRANT_FLAG_PREFIX = "gas_grant:";

export interface GasGrantRequest {
  to: Address;
  value: bigint;
  nonce?: number;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  /** Max grants per rolling 24 h (global). */
  dailyMax: number;
  /** Stored with the grant record (audit). */
  reason?: Record<string, string>;
  onSigned?: (tx: { hash: Hash; nonce: number }) => Promise<void>;
}

export interface RelayerSigner {
  readonly address: Address;
  readonly chain: Chain;
  /** Guarded, attributed client to hand to `startRelayer`. */
  readonly walletClient: WalletClient;
  send(req: SendRequest): Promise<Hash>;
  /** Sends a tiny CELO amount to a payer who needs gas for their approval (see header for the guards). */
  grantGas(req: GasGrantRequest): Promise<Hash>;
  /** Run every guard without signing. Resolves to the invoice's USD value (for logs). */
  check(req: Pick<SendRequest, "to" | "data" | "value">): Promise<{ usd: number }>;
}

const signers = new WeakMap<object, RelayerSigner>();

/** The RelayerSigner behind a walletClient built by createRelayerSigner, if any. */
export function signerOf(client: unknown): RelayerSigner | undefined {
  return typeof client === "object" && client !== null ? signers.get(client) : undefined;
}

function defaultTokenMeta(token: Address): TokenMeta | undefined {
  const t = tokenByAddress(token);
  return t ? { decimals: t.decimals, currency: t.currency } : undefined;
}

function decodePay(data: Hex): { inv: OnchainInvoice; payer: Address; legs: readonly Leg[] } {
  if (data.slice(0, 10).toLowerCase() !== PAY_SELECTOR) throw new SignerRefusedError("wrong_selector");
  try {
    const { functionName, args } = decodeFunctionData({ abi: cobraRouterAbi, data });
    if (functionName !== "pay") throw new Error(functionName);
    return { inv: args[0] as OnchainInvoice, payer: args[1] as Address, legs: args[2] as readonly Leg[] };
  } catch {
    throw new SignerRefusedError("wrong_selector", "calldata is not a valid pay()");
  }
}

function sameAddress(a: string, b: Address): boolean {
  try {
    return isAddressEqual(getAddress(a), b);
  } catch {
    return false;
  }
}

function assertKey(pk: string): asserts pk is Hex {
  // Never echo the value.
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error("RELAYER_PRIVATE_KEY must be 0x + 64 hex chars");
}

/** Simple async mutex: one signature/broadcast at a time (nonce safety + per-call hook routing). */
function mutex() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

export function createRelayerSigner(opts: RelayerSignerOptions): RelayerSigner {
  assertKey(opts.privateKey);
  const chain = opts.chain ?? celo;
  const transport = opts.transport ?? http(opts.rpcUrl);
  const router = getAddress(opts.router);
  const tokenMeta = opts.tokenMeta ?? defaultTokenMeta;
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => new Date());
  const roleSuffix = opts.walletAttributionCode
    ? toRoleDataSuffix({ app: opts.attributionCode, wallet: opts.walletAttributionCode })
    : undefined;

  const keyAccount = privateKeyToAccount(opts.privateKey);
  const address = keyAccount.address;
  let onSignedHook: SendRequest["onSigned"] | undefined;
  /** Set only inside the lock while a guarded gas grant is being signed. */
  let grantInFlight: { to: Address; value: bigint } | null = null;
  const grantData = (roleSuffix ?? toDataSuffix(opts.attributionCode)).toLowerCase();
  const reader = createPublicClient({ chain, transport });

  // Local account wrapper: signTransaction is the single choke point before eth_sendRawTransaction.
  const hookedAccount = toAccount({
    address,
    async signMessage() {
      throw new SignerRefusedError("blocked_method", "signMessage");
    },
    async signTypedData() {
      throw new SignerRefusedError("blocked_method", "signTypedData");
    },
    async signTransaction(tx, options) {
      const g = grantInFlight;
      if (g) {
        // Gas grant: exactly the target and value checked by grantGas, calldata = the attribution suffix only.
        if (!tx.to || !isAddressEqual(tx.to, g.to) || tx.value !== g.value) throw new SignerRefusedError("grant_target");
        if ((tx.data ?? "0x").toLowerCase() !== grantData) throw new SignerRefusedError("wrong_selector", "grant calldata");
      } else {
        if (!tx.to || !isAddressEqual(tx.to, router)) throw new SignerRefusedError("wrong_target");
        if (!tx.data || tx.data.slice(0, 10).toLowerCase() !== PAY_SELECTOR) throw new SignerRefusedError("wrong_selector");
        if (tx.value && tx.value !== 0n) throw new SignerRefusedError("value_not_zero");
      }
      const raw = await keyAccount.signTransaction(tx, options);
      if (onSignedHook) await onSignedHook({ hash: keccak256(raw), nonce: Number(tx.nonce) });
      return raw;
    },
  });

  const inner = createWalletClient({ account: hookedAccount, chain, transport }).extend(
    withAttribution(opts.attributionCode),
  );

  /** Rolling-24h relayed USD totals (excluding this invoice): global, for `merchant`, and for `payer`. */
  async function dayTotalsScaled(
    excludeInvoiceId: string,
    merchant: Address,
    payer: Address,
  ): Promise<{ all: bigint; merchant: bigint; payer: bigint }> {
    const since = new Date(now().getTime() - 24 * 3600_000);
    const rows = await opts.db
      .select({
        id: invoices.id,
        tokenOut: invoices.tokenOut,
        amountOut: invoices.amountOut,
        merchantAddress: invoices.merchantAddress,
        payer: submissions.payer,
      })
      .from(submissions)
      .innerJoin(invoices, eq(submissions.invoiceId, invoices.id))
      .where(
        and(
          isNotNull(submissions.txHash),
          inArray(submissions.status, ["sending", "sent", "confirmed"]),
          gte(submissions.createdAt, since),
          ne(submissions.invoiceId, excludeInvoiceId),
        ),
      );
    const rates = await resolveRates(opts.rates);
    const seen = new Set<string>();
    const totals = { all: 0n, merchant: 0n, payer: 0n };
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      const meta = tokenMeta(getAddress(r.tokenOut));
      if (!meta) throw new SignerRefusedError("unknown_token", r.tokenOut);
      const usd = usdValueScaled(BigInt(r.amountOut), meta.decimals, meta.currency, rates);
      totals.all += usd;
      if (sameAddress(r.merchantAddress, merchant)) totals.merchant += usd;
      if (sameAddress(r.payer, payer)) totals.payer += usd;
    }
    return totals;
  }

  async function check(req: Pick<SendRequest, "to" | "data" | "value">): Promise<{ usd: number }> {
    if (!req.to || !isAddressEqual(req.to, router)) throw new SignerRefusedError("wrong_target");
    if (req.value !== undefined && req.value !== 0n) throw new SignerRefusedError("value_not_zero");
    const { inv, payer, legs } = decodePay(req.data);
    // WS7-7: a zero amount (invoice or any leg) is never a real payment; refuse before any other guard.
    if (inv.amountOut === 0n) throw new SignerRefusedError("zero_amount", "invoice amountOut is 0");
    if (legs.length === 0 || legs.some((l) => l.amountIn === 0n)) throw new SignerRefusedError("zero_amount", "leg amountIn is 0");
    if (await isKillSwitchOn(opts.db, env)) throw new SignerRefusedError("kill_switch");
    // Self-dealing: the merchant paying its own invoice moves no value but would burn the shared relay budget.
    if (isAddressEqual(payer, inv.merchant)) throw new SignerRefusedError("self_payment");

    const meta = tokenMeta(getAddress(inv.tokenOut));
    if (!meta) throw new SignerRefusedError("unknown_token", inv.tokenOut);
    let usd: bigint;
    try {
      usd = usdValueScaled(inv.amountOut, meta.decimals, meta.currency, await resolveRates(opts.rates));
    } catch (e) {
      throw new SignerRefusedError("missing_rate", String((e as Error).message));
    }
    const caps = await getCaps(opts.db);
    if (usd > usdToScaled(caps.perPaymentUsd)) {
      throw new SignerRefusedError("cap_per_payment", `${scaledToUsd(usd)} USD > ${caps.perPaymentUsd}`);
    }
    let day: { all: bigint; merchant: bigint; payer: bigint };
    try {
      day = await dayTotalsScaled(inv.id, inv.merchant, payer);
    } catch (e) {
      if (e instanceof SignerRefusedError) throw e;
      throw new SignerRefusedError("missing_rate", String((e as Error).message));
    }
    const perMerchant = caps.perMerchantDayUsd ?? DEFAULT_CAPS.perMerchantDayUsd;
    if (day.merchant + usd > usdToScaled(perMerchant)) {
      throw new SignerRefusedError("cap_per_merchant_day", `${scaledToUsd(day.merchant + usd)} USD > ${perMerchant}`);
    }
    const perPayer = caps.perPayerDayUsd ?? DEFAULT_CAPS.perPayerDayUsd;
    if (day.payer + usd > usdToScaled(perPayer)) {
      throw new SignerRefusedError("cap_per_payer_day", `${scaledToUsd(day.payer + usd)} USD > ${perPayer}`);
    }
    if (day.all + usd > usdToScaled(caps.perDayUsd)) {
      throw new SignerRefusedError("cap_per_day", `${scaledToUsd(day.all + usd)} USD > ${caps.perDayUsd}`);
    }
    return { usd: scaledToUsd(usd) };
  }

  const lock = mutex();
  async function send(req: SendRequest): Promise<Hash> {
    return lock(async () => {
      await check(req);
      onSignedHook = req.onSigned;
      try {
        return await inner.sendTransaction({
          account: hookedAccount,
          chain,
          to: router,
          data: req.data,
          value: 0n,
          ...(req.nonce !== undefined && { nonce: req.nonce }),
          ...(req.gas !== undefined && { gas: req.gas }),
          ...(req.maxFeePerGas !== undefined && { maxFeePerGas: req.maxFeePerGas }),
          ...(req.maxPriorityFeePerGas !== undefined && { maxPriorityFeePerGas: req.maxPriorityFeePerGas }),
          ...(roleSuffix && { dataSuffix: roleSuffix }),
        } as never);
      } finally {
        onSignedHook = undefined;
      }
    });
  }

  async function grantGas(req: GasGrantRequest): Promise<Hash> {
    return lock(async () => {
      if (await isKillSwitchOn(opts.db, env)) throw new SignerRefusedError("kill_switch");
      if (!(req.value > 0n && req.value <= GAS_GRANT_MAX_WEI)) throw new SignerRefusedError("grant_value", String(req.value));
      let to: Address;
      try {
        to = getAddress(req.to);
      } catch {
        throw new SignerRefusedError("grant_target", "invalid address");
      }
      if (isAddressEqual(to, router) || isAddressEqual(to, address) || /^0x0{40}$/i.test(to)) throw new SignerRefusedError("grant_target");
      const code = await reader.getCode({ address: to });
      // EOAs only; an EIP-7702 delegated EOA carries the 0xef0100 designator and is still a person's wallet.
      if (code && code !== "0x" && !code.toLowerCase().startsWith("0xef0100")) throw new SignerRefusedError("grant_target", "contract");
      const since = new Date(now().getTime() - 24 * 3600_000);
      const [row] = await opts.db
        .select({ n: count() })
        .from(flags)
        .where(and(like(flags.key, `${GAS_GRANT_FLAG_PREFIX}%`), gte(flags.updatedAt, since)));
      const n = Number(row?.n ?? 0);
      if (n >= req.dailyMax) throw new SignerRefusedError("grant_daily_cap", `${n} >= ${req.dailyMax}`);
      // Reserve the one-grant-per-address slot BEFORE signing: a crash after this point never grants twice.
      const key = `${GAS_GRANT_FLAG_PREFIX}${to.toLowerCase()}`;
      const reserved = await opts.db
        .insert(flags)
        .values({ key, value: { status: "signing", value: req.value.toString(), ...req.reason } })
        .onConflictDoNothing()
        .returning({ key: flags.key });
      if (reserved.length === 0) throw new SignerRefusedError("grant_already_given");

      grantInFlight = { to, value: req.value };
      onSignedHook = async (tx) => {
        await opts.db
          .update(flags)
          .set({ value: { status: "sent", value: req.value.toString(), txHash: tx.hash, ...req.reason }, updatedAt: now() })
          .where(eq(flags.key, key));
        await req.onSigned?.(tx);
      };
      try {
        return await inner.sendTransaction({
          account: hookedAccount,
          chain,
          to,
          value: req.value,
          data: "0x",
          gas: 50_000n,
          ...(req.nonce !== undefined && { nonce: req.nonce }),
          ...(req.maxFeePerGas !== undefined && { maxFeePerGas: req.maxFeePerGas }),
          ...(req.maxPriorityFeePerGas !== undefined && { maxPriorityFeePerGas: req.maxPriorityFeePerGas }),
          ...(roleSuffix && { dataSuffix: roleSuffix }),
        } as never);
      } finally {
        grantInFlight = null;
        onSignedHook = undefined;
      }
    });
  }

  const blocked = (name: string) => async () => {
    throw new SignerRefusedError("blocked_method", name);
  };
  // Address-only client: anything not overridden below cannot reach the key.
  const overrides: Record<string, (args: never) => Promise<unknown>> = {
    sendTransaction: (args: { to?: Address | null; data?: Hex; value?: bigint; nonce?: number; gas?: bigint; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }) => {
      if (!args.to) return Promise.reject(new SignerRefusedError("wrong_target"));
      return send({ ...args, to: args.to, data: args.data ?? "0x" });
    },
    writeContract: (args: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[]; value?: bigint; nonce?: number; gas?: bigint }) =>
      send({
        to: args.address,
        data: encodeFunctionData({ abi: args.abi, functionName: args.functionName, args: args.args } as Parameters<typeof encodeFunctionData>[0]),
        ...(args.value !== undefined && { value: args.value }),
        ...(args.nonce !== undefined && { nonce: args.nonce }),
        ...(args.gas !== undefined && { gas: args.gas }),
      }),
    sendTransactionSync: blocked("sendTransactionSync"),
    writeContractSync: blocked("writeContractSync"),
    deployContract: blocked("deployContract"),
    sendRawTransaction: blocked("sendRawTransaction"),
    sendRawTransactionSync: blocked("sendRawTransactionSync"),
    signTransaction: blocked("signTransaction"),
    signMessage: blocked("signMessage"),
    signTypedData: blocked("signTypedData"),
    signAuthorization: blocked("signAuthorization"),
    sendCalls: blocked("sendCalls"),
  };
  const walletClient = createWalletClient({ account: address, chain, transport }).extend(
    () => overrides as never,
  ) as unknown as WalletClient;

  const signer: RelayerSigner = { address, chain, walletClient, send, check, grantGas };
  signers.set(walletClient, signer);
  return signer;
}

// ---------------------------------------------------------------------------------------------------------------
// ERC-8004 identity registration — the only other transaction this key may ever sign.
// Used exclusively by scripts/agent/register.ts with an explicit --execute flag run by the human.
// ---------------------------------------------------------------------------------------------------------------

export const identityRegistryAbi = parseAbi([
  "function register(string agentURI) returns (uint256 agentId)",
  "function setAgentURI(uint256 agentId, string newURI)",
  "function tokenURI(uint256 agentId) view returns (string)",
  "function ownerOf(uint256 agentId) view returns (address)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
]);

export const REGISTER_SELECTOR: Hex = toFunctionSelector("register(string)");

export interface RegistrationSenderOptions {
  privateKey: Hex;
  rpcUrl: string;
  attributionCode: string;
  registry?: Address;
  chain?: Chain;
  transport?: Transport;
}

/** Narrow sender: only `register(string)` on the ERC-8004 IdentityRegistry. */
export function createRegistrationSender(opts: RegistrationSenderOptions) {
  assertKey(opts.privateKey);
  const chain = opts.chain ?? celo;
  const registry = getAddress(opts.registry ?? CELO.erc8004.identityRegistry.address);
  const key = privateKeyToAccount(opts.privateKey);
  const account = toAccount({
    address: key.address,
    signMessage: blocked1("signMessage"),
    signTypedData: blocked1("signTypedData"),
    async signTransaction(tx, options) {
      if (!tx.to || !isAddressEqual(tx.to, registry)) throw new SignerRefusedError("wrong_target");
      if (!tx.data || tx.data.slice(0, 10).toLowerCase() !== REGISTER_SELECTOR) throw new SignerRefusedError("wrong_selector");
      if (tx.value && tx.value !== 0n) throw new SignerRefusedError("value_not_zero");
      return key.signTransaction(tx, options);
    },
  });
  const client = createWalletClient({ account, chain, transport: opts.transport ?? http(opts.rpcUrl) }).extend(
    withAttribution(opts.attributionCode),
  );
  return {
    address: key.address,
    registry,
    register(agentURI: string): Promise<Hash> {
      return client.writeContract({
        account,
        chain,
        address: registry,
        abi: identityRegistryAbi,
        functionName: "register",
        args: [agentURI],
      } as never);
    },
  };
}

function blocked1(name: string) {
  return async (): Promise<never> => {
    throw new SignerRefusedError("blocked_method", name);
  };
}

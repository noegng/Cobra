/**
 * Textile FX RFQ API v2 client (docs/interfaces.md §7). Server-side only: the partner (aggregator) API key must never
 * reach a browser or a log line.
 *
 * Fail closed: any transport error, timeout, non-2xx, or response that does not match the zod schemas yields
 * `{ ok: false }` and the caller falls back to Uniswap. Nothing here throws. No API key => `enabled === false` and no
 * request is ever made. `fetch` is injectable for tests.
 */
import { z } from "zod";

export const TEXTILE_BASE_URL = "https://api.textilecredit.com";
export const TEXTILE_PREVIEW_TIMEOUT_MS = 3_000;
/**
 * Firm request: makers answer within ~750 ms, but Textile documents that a cold corridor can hold the call for an
 * on-chain decimals preflight (up to ~70 s). A payer cannot wait that long: past 8 s we fall back to Uniswap; the
 * corridor warms up after the first calls.
 */
export const TEXTILE_REQUEST_TIMEOUT_MS = 8_000;
export const TEXTILE_ACTION_TIMEOUT_MS = 3_000;

const hexStr = z.string().regex(/^0x([0-9a-fA-F]{2})*$/);
const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
/** Integer amounts arrive as decimal strings (or JSON integers); anything else is rejected. */
const amount = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative().safe()]).transform((v) => BigInt(v));
/** `expiresAt`: ISO-8601 string, unix seconds or unix milliseconds. */
const timestampMs = z.union([z.string(), z.number()]).transform((v, ctx) => {
  let ms: number;
  if (typeof v === "number") ms = v < 1e12 ? v * 1000 : v;
  else if (/^\d+$/.test(v)) ms = Number(v) < 1e12 ? Number(v) * 1000 : Number(v);
  else ms = Date.parse(v);
  if (!Number.isFinite(ms) || ms <= 0) {
    ctx.addIssue({ code: "custom", message: "bad timestamp" });
    return z.NEVER;
  }
  return ms;
});

const previewSchema = z.object({
  data: z.object({
    status: z.literal("preview"),
    sellAmount: amount,
    buyAmount: amount,
    feeAmount: amount.optional(),
    takerPays: amount,
    rateRay: z.union([z.string(), z.number()]).optional(),
    availableSellAmount: amount.optional(),
  }),
});

const orderSchema = z.object({
  encodedOrder: hexStr,
  signature: hexStr,
  sellAmount: amount.optional(),
  buyAmount: amount.optional(),
  feeAmount: amount.optional(),
  maker: addr.optional(),
});

const quoteSchema = z.object({
  sellAmount: amount,
  buyAmount: amount,
  feeAmount: amount.optional(),
  takerPays: amount,
  rateRay: z.union([z.string(), z.number()]).optional(),
  expiresAt: timestampMs,
  orderDeadline: timestampMs.optional(),
  latestOrderDeadline: timestampMs.optional(),
  reactor: addr,
  taker: addr,
  orders: z.array(orderSchema).min(1).max(16),
});

const requestSchema = z.object({
  data: z.discriminatedUnion("status", [
    z.object({ status: z.literal("quoted"), rfqId: z.string().min(1).max(200), claimToken: z.string().optional(), quote: quoteSchema }),
    z.object({ status: z.literal("no_quote"), rfqId: z.string().max(200).optional() }),
  ]),
});

export type TextilePreview = z.infer<typeof previewSchema>["data"];
export type TextileQuote = z.infer<typeof quoteSchema>;
export interface TextileFirmQuote {
  rfqId: string;
  quote: TextileQuote;
}

export type TextileFail = "disabled" | "timeout" | "network" | "http" | "malformed" | "no_quote";
export type TextileResult<T> = { ok: true; value: T } | { ok: false; reason: TextileFail; status?: number };

export interface TextileSwapRequest {
  chainId: number;
  sellToken: string;
  buyToken: string;
  /** Exact output (the only mode the router uses). */
  buyAmount: bigint;
}

export interface TextileClientOptions {
  /** Partner API key. Empty/undefined => disabled. Never logged. */
  apiKey?: string | undefined;
  baseUrl?: string;
  fetch?: typeof fetch;
  previewTimeoutMs?: number;
  requestTimeoutMs?: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface TextileClient {
  readonly enabled: boolean;
  preview(req: TextileSwapRequest): Promise<TextileResult<TextilePreview>>;
  request(req: TextileSwapRequest & { taker: string }): Promise<TextileResult<TextileFirmQuote>>;
  /** Tell Textile the tx hash that consumes the quote (best effort for the caller). */
  submit(rfqId: string, txHash: string): Promise<TextileResult<null>>;
  status(rfqId: string): Promise<TextileResult<Record<string, unknown>>>;
  /** Give back a quote that will not be used. */
  cancel(rfqId: string): Promise<TextileResult<null>>;
}

export function createTextileClient(opts: TextileClientOptions = {}): TextileClient {
  const key = opts.apiKey?.trim();
  const base = (opts.baseUrl ?? TEXTILE_BASE_URL).replace(/\/+$/, "");
  const doFetch = opts.fetch ?? globalThis.fetch;
  const log = opts.log ?? (() => {});
  const disabled = !key;

  async function call(method: "GET" | "POST", path: string, body: unknown, timeoutMs: number): Promise<TextileResult<unknown>> {
    if (disabled) return { ok: false, reason: "disabled" };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await doFetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: ctl.signal,
      });
      if (!res.ok) {
        log("textile_http_error", { kind: path.split("/").slice(0, 4).join("/"), status: res.status });
        return { ok: false, reason: "http", status: res.status };
      }
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        return { ok: false, reason: "malformed" };
      }
      return { ok: true, value: json };
    } catch (e) {
      const aborted = ctl.signal.aborted || (e instanceof Error && e.name === "AbortError");
      return { ok: false, reason: aborted ? "timeout" : "network" };
    } finally {
      clearTimeout(timer);
    }
  }

  const swapBody = (r: TextileSwapRequest) => ({
    chainId: r.chainId,
    sellToken: r.sellToken,
    buyToken: r.buyToken,
    buyAmount: r.buyAmount.toString(),
  });

  return {
    enabled: !disabled,
    async preview(req) {
      const r = await call("POST", "/v2/rfq/preview", swapBody(req), opts.previewTimeoutMs ?? TEXTILE_PREVIEW_TIMEOUT_MS);
      if (!r.ok) return r;
      const p = previewSchema.safeParse(r.value);
      if (!p.success) return { ok: false, reason: "malformed" };
      return { ok: true, value: p.data.data };
    },
    async request(req) {
      const r = await call("POST", "/v2/rfq/request", { ...swapBody(req), taker: req.taker }, opts.requestTimeoutMs ?? TEXTILE_REQUEST_TIMEOUT_MS);
      if (!r.ok) return r;
      const p = requestSchema.safeParse(r.value);
      if (!p.success) return { ok: false, reason: "malformed" };
      if (p.data.data.status === "no_quote") return { ok: false, reason: "no_quote" };
      return { ok: true, value: { rfqId: p.data.data.rfqId, quote: p.data.data.quote } };
    },
    async submit(rfqId, txHash) {
      const r = await call("POST", `/v2/rfq/${encodeURIComponent(rfqId)}/submit`, { txHash }, TEXTILE_ACTION_TIMEOUT_MS);
      return r.ok ? { ok: true, value: null } : r;
    },
    async status(rfqId) {
      const r = await call("GET", `/v2/rfq/${encodeURIComponent(rfqId)}`, undefined, TEXTILE_ACTION_TIMEOUT_MS);
      if (!r.ok) return r;
      const o = z.object({ data: z.record(z.string(), z.unknown()) }).safeParse(r.value);
      return o.success ? { ok: true, value: o.data.data } : { ok: false, reason: "malformed" };
    },
    async cancel(rfqId) {
      const r = await call("POST", `/v2/rfq/${encodeURIComponent(rfqId)}/cancel`, {}, TEXTILE_ACTION_TIMEOUT_MS);
      return r.ok ? { ok: true, value: null } : r;
    },
  };
}

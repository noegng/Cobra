/** Small HTTP helpers for route handlers. Responses never echo env values or stack traces. */

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export function apiError(status: number, error: string, extra: Record<string, unknown> = {}): Response {
  return json({ error, ...extra }, status);
}

/** Best-effort client IP (Vercel sets x-forwarded-for / x-real-ip). */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

const MAX_BODY_BYTES = 16 * 1024;

/** Parses a small JSON object body; returns null on anything else. */
export async function readJsonBody(req: Request): Promise<Record<string, unknown> | null> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY_BYTES) return null;
  let text: string;
  try {
    text = await req.text();
  } catch {
    return null;
  }
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Server-side log without secrets: only event name + whitelisted scalar fields. */
export function logEvent(event: string, fields: Record<string, string | number | boolean | null | undefined> = {}): void {
  console.info(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));
}

export const INVOICE_ID_RE = /^0x[0-9a-fA-F]{64}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SLUG_RE = /^[A-Za-z0-9_-]{3,64}$/;

/**
 * Structured agent refusals (WS15). Fire-and-forget: a failure here must never change a response or the money path.
 * Only a closed (kind, code) pair is stored: no address, amount, invoice id, IP or free text.
 */
import { agentEvents, AGENT_EVENT_CODES, type AgentEventCode, type AgentEventKind } from "./schema";
import type { Db } from "./client";

export type RecordAgentEvent = (kind: AgentEventKind, code: AgentEventCode) => void;

/** Inserts the event; resolves (never rejects). Returns true when written. Unknown codes are dropped. */
export async function writeAgentEvent(
  db: Db,
  kind: AgentEventKind,
  code: AgentEventCode,
  log: (msg: string, extra?: Record<string, unknown>) => void = () => {},
): Promise<boolean> {
  try {
    if (!(AGENT_EVENT_CODES as readonly string[]).includes(code)) return false;
    await db.insert(agentEvents).values({ kind, code });
    return true;
  } catch (e) {
    log("agent_event_write_failed", { level: "warn", kind, code, error: e instanceof Error ? e.name : "unknown" });
    return false;
  }
}

/** Sync fire-and-forget recorder bound to a db (the promise is detached; it cannot reject). */
export function agentEventRecorder(db: Db, log?: (msg: string, extra?: Record<string, unknown>) => void): RecordAgentEvent {
  return (kind, code) => {
    void writeAgentEvent(db, kind, code, log);
  };
}

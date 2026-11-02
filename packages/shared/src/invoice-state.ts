import { InvoiceStatus } from "./types";

/** Allowed invoice transitions (plan §9). DB layer must enforce these atomically. */
export const INVOICE_TRANSITIONS: Record<InvoiceStatus, readonly InvoiceStatus[]> = {
  open: ["submitted", "expired", "cancelled", "paid"], // open->paid: self-submitted ALLOWANCE payment seen by indexer
  submitted: ["paid", "open"], // -> open when the tx failed
  paid: [],
  // The router enforces block.timestamp <= deadline, so a matching Paid event on an expired row is an
  // on-time payment indexed after the expiry job ran: it must still be recorded as paid.
  expired: ["paid"],
  cancelled: [],
};

export function canTransition(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return INVOICE_TRANSITIONS[from].includes(to);
}

export const INVOICE_TTL_SECONDS = 10 * 60;
export const QUOTE_TTL_MS = 60_000;
export const MAX_LEGS = 3;

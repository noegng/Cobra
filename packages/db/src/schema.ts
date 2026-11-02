/**
 * FROZEN schema (WS0). Changes require a new drizzle migration AND a note in the night report.
 * Conventions: on-chain amounts are base-unit integer strings (text) — never JS numbers.
 * Local (fiat) amounts are decimal strings ("4500.50"). Addresses are checksummed hex.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const invoiceStatus = pgEnum("invoice_status", ["open", "submitted", "paid", "expired", "cancelled"]);
export const submissionStatus = pgEnum("submission_status", ["pending", "sending", "sent", "confirmed", "failed"]);
export const invoiceSource = pgEnum("invoice_source", ["chat", "static_qr", "dashboard"]);

export const merchants = pgTable("merchants", {
  id: uuid("id").primaryKey().defaultRandom(),
  telegramUserId: bigint("telegram_user_id", { mode: "bigint" }).notNull().unique(),
  telegramChatId: bigint("telegram_chat_id", { mode: "bigint" }).notNull(),
  displayName: text("display_name"),
  country: text("country").notNull(), // CountryCode
  currency: text("currency").notNull(), // FiatCurrency
  settlementToken: text("settlement_token").notNull(), // token address (wFIAT or USD stable)
  payoutAddress: text("payout_address").notNull(),
  payoutAddressProven: integer("payout_address_proven").notNull().default(0), // 1 = proven by signature
  language: text("language").notNull().default("es"), // Language
  /** Public slug for the static checkout QR: /pay/m/<slug> */
  staticSlug: text("static_slug").notNull().unique(),
  dailyCloseHour: integer("daily_close_hour").notNull().default(21),
  timezone: text("timezone").notNull().default("America/Argentina/Buenos_Aires"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const invoices = pgTable(
  "invoices",
  {
    id: text("id").primaryKey(), // bytes32 hex, random — also the on-chain invoice id
    merchantId: uuid("merchant_id").notNull().references(() => merchants.id),
    amountLocal: text("amount_local").notNull(), // decimal string in `currency`
    currency: text("currency").notNull(), // Currency
    tokenOut: text("token_out").notNull(),
    amountOut: text("amount_out").notNull(), // base units of tokenOut, frozen at creation
    /** Merchant payout address copied at creation; the on-chain Invoice.merchant. */
    merchantAddress: text("merchant_address").notNull(),
    reference: text("reference"), // short human ref, e.g. "A-0042"
    description: text("description"),
    status: invoiceStatus("status").notNull().default("open"),
    source: invoiceSource("source").notNull().default("chat"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(), // == on-chain deadline
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    lastReminderAt: timestamp("last_reminder_at", { withTimezone: true }),
  },
  (t) => [index("invoices_merchant_status_idx").on(t.merchantId, t.status), index("invoices_expires_idx").on(t.expiresAt)],
);

export const quotes = pgTable(
  "quotes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invoiceId: text("invoice_id").notNull().references(() => invoices.id),
    payer: text("payer").notNull(),
    plan: jsonb("plan").notNull(), // PaymentPlan, bigints serialized as strings
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("quotes_invoice_idx").on(t.invoiceId)],
);

/** Relay queue: web API inserts `pending`, the VPS relayer consumes. No HTTP between Vercel and VPS. */
export const submissions = pgTable(
  "submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invoiceId: text("invoice_id").notNull().references(() => invoices.id),
    quoteId: uuid("quote_id").references(() => quotes.id),
    payer: text("payer").notNull(),
    legs: jsonb("legs").notNull(), // Leg[] with signed pullData, bigints as strings
    status: submissionStatus("status").notNull().default("pending"),
    txHash: text("tx_hash"),
    txNonce: integer("tx_nonce"),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // at most one live submission per invoice
    uniqueIndex("submissions_one_live_per_invoice")
      .on(t.invoiceId)
      .where(sql`status in ('pending','sending','sent','confirmed')`),
    index("submissions_status_idx").on(t.status),
  ],
);

export const payments = pgTable("payments", {
  id: uuid("id").primaryKey().defaultRandom(),
  invoiceId: text("invoice_id").notNull().unique().references(() => invoices.id),
  txHash: text("tx_hash").notNull(),
  logIndex: integer("log_index").notNull(),
  payer: text("payer").notNull(),
  tokenOut: text("token_out").notNull(),
  amountOut: text("amount_out").notNull(),
  legs: jsonb("legs"), // copied from the submission when known (null for self-submitted)
  costBps: integer("cost_bps"),
  savingsBps: integer("savings_bps"),
  blockNumber: bigint("block_number", { mode: "bigint" }).notNull(),
  paidAt: timestamp("paid_at", { withTimezone: true }).notNull(),
});

/** Paid events that did not match a DB invoice's terms (griefing / bugs) — never auto-applied. */
export const unmatchedEvents = pgTable("unmatched_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  txHash: text("tx_hash").notNull(),
  logIndex: integer("log_index").notNull(),
  payload: jsonb("payload").notNull(),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const chainCursor = pgTable("chain_cursor", {
  id: text("id").primaryKey(), // e.g. "router_paid"
  blockNumber: bigint("block_number", { mode: "bigint" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Operational flags: kill_switch, caps. value is JSON. */
export const flags = pgTable("flags", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const FLAG_KEYS = {
  killSwitch: "kill_switch", // { enabled: boolean }
  caps: "caps", // { perPaymentUsd: number, perDayUsd: number }
} as const;

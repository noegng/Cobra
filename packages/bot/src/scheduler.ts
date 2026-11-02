/** Minute-tick jobs run by apps/worker: reminders and daily close. Both are idempotent. */
import { merchants, type Db } from "@cobra/db";
import type { Notifier } from "@cobra/shared";
import { t } from "./i18n";
import { dailySummary, dueReminders, markReminded, REMINDER_LEAD_MS } from "./invoices";
import { payUrl } from "./links";
import { getMerchant } from "./merchants";
import { isBotNotifier } from "./notifier";
import { merchantLang, money, shareLink } from "./present";
import { claimOnce, stateKeys } from "./state";
import { localDate, zonedParts } from "./time";

/**
 * One reminder per open chat/dashboard invoice, when it enters the last REMINDER_LEAD_MS before expiry.
 * The `lastReminderAt` column is claimed atomically before sending (at-most-once).
 */
export async function runRemindersImpl(opts: {
  db: Db;
  notifier: Notifier;
  now: Date;
  publicBaseUrl: string;
  leadMs?: number;
}): Promise<number> {
  const due = await dueReminders(opts.db, opts.now, opts.leadMs ?? REMINDER_LEAD_MS);
  let sent = 0;
  for (const inv of due) {
    if (!(await markReminded(opts.db, inv.id, opts.now))) continue;
    const m = await getMerchant(opts.db, inv.merchantId);
    if (!m) continue;
    const minutes = Math.max(1, Math.round((inv.expiresAt.getTime() - opts.now.getTime()) / 60_000));
    await opts.notifier.text(
      m.id,
      t(merchantLang(m), "reminder", {
        ref: inv.reference ?? "",
        amount: money(m, inv.amountLocal, inv.currency),
        minutes,
        url: payUrl(opts.publicBaseUrl, inv.id),
        wa: shareLink(m, inv, opts.publicBaseUrl),
      }),
    );
    sent++;
  }
  return sent;
}

/**
 * Daily close at the merchant's `dailyCloseHour` (local time, its timezone). Fires on the first tick at or after that
 * hour, once per merchant and local day: marker `daily_close:<merchantId>:<yyyy-mm-dd>` in `flags`, claimed before
 * sending (at-most-once). Days without any activity are marked but not messaged.
 */
export async function runDailyCloseImpl(opts: { db: Db; notifier: Notifier; now: Date }): Promise<number> {
  const all = await opts.db.select().from(merchants);
  let sent = 0;
  for (const m of all) {
    const local = zonedParts(opts.now, m.timezone);
    if (local.hour < m.dailyCloseHour) continue;
    const date = localDate(opts.now, m.timezone);
    if (!(await claimOnce(opts.db, stateKeys.dailyClose(m.id, date), { at: opts.now.toISOString() }))) continue;
    const s = await dailySummary(opts.db, m, date);
    if (s.rows.length === 0) continue;
    const lang = merchantLang(m);
    const text = [
      t(lang, "close_header", { date }),
      t(lang, "close_body", {
        paidTotal: money(m, s.paidTotal, s.currency),
        paidCount: s.paidCount,
        open: s.open,
        expired: s.expired,
        cancelled: s.cancelled,
        created: s.created,
      }),
    ].join("\n");
    await opts.notifier.text(m.id, text);
    if (isBotNotifier(opts.notifier)) {
      await opts.notifier.document(m.id, { filename: `cobra-${date}.csv`, content: s.csv }, t(lang, "close_csv_caption", { date }));
    }
    sent++;
  }
  return sent;
}

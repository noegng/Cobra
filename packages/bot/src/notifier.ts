import { Api, InputFile } from "grammy";
import { and, eq } from "drizzle-orm";
import { invoices, type Db } from "@cobra/db";
import { explorerTx, fromBaseUnits, tokenByAddress, type Notifier } from "@cobra/shared";
import { amountStyleFor, formatAmount } from "./amount";
import { t } from "./i18n";
import { getMerchant } from "./merchants";
import { merchantLang, money } from "./present";
import { displaySymbol } from "./usd";

/** Notifier + file sending (used for the daily-close CSV). Still assignable to the frozen `Notifier`. */
export interface BotNotifier extends Notifier {
  document(merchantId: string, file: { filename: string; content: string | Uint8Array }, caption?: string): Promise<void>;
}

export function isBotNotifier(n: Notifier): n is BotNotifier {
  return typeof (n as Partial<BotNotifier>).document === "function";
}

/** Same as createTelegramNotifier but with an injectable grammY `Api` (tests use an API transformer). */
export function createNotifierWithApi(api: Api, db: Db): BotNotifier {
  async function chatOf(merchantId: string) {
    const m = await getMerchant(db, merchantId);
    if (!m) throw new Error(`unknown merchant ${merchantId}`);
    return { m, chatId: Number(m.telegramChatId) };
  }
  return {
    async invoicePaid({ merchantId, invoiceId, amountLocal, currency, reference, txHash }) {
      const { m, chatId } = await chatOf(merchantId);
      const lang = merchantLang(m);
      // money() writes the currency out ("$ 100" alone reads as dollars); add what actually landed in the wallet, read from the
      // invoice's own tokenOut / amountOut (wFIAT 1:1 or USD₮ at the rate frozen at creation), never assumed.
      const [inv] = await db
        .select({ tokenOut: invoices.tokenOut, amountOut: invoices.amountOut })
        .from(invoices)
        .where(and(eq(invoices.id, invoiceId), eq(invoices.merchantId, merchantId)));
      const style = amountStyleFor(m.country, m.language);
      let received = "";
      const token = inv ? tokenByAddress(inv.tokenOut) : tokenByAddress(m.settlementToken);
      if (inv && token) {
        received = t(lang, "paid_received", {
          amount: formatAmount(fromBaseUnits(BigInt(inv.amountOut), token.decimals), "", style).trim(),
          token: displaySymbol(inv.tokenOut),
        });
      } else if (token && token.currency === currency) {
        received = t(lang, "paid_received", { amount: formatAmount(amountLocal, "", style).trim(), token: token.symbol });
      }
      await api.sendMessage(
        chatId,
        t(lang, "paid", { ref: reference ?? "", amount: money(m, amountLocal, currency), received, url: explorerTx(txHash) }),
        { link_preview_options: { is_disabled: true } },
      );
    },
    async text(merchantId, message) {
      const { chatId } = await chatOf(merchantId);
      await api.sendMessage(chatId, message, { link_preview_options: { is_disabled: true } });
    },
    async document(merchantId, file, caption) {
      const { chatId } = await chatOf(merchantId);
      const bytes = typeof file.content === "string" ? new TextEncoder().encode(file.content) : file.content;
      await api.sendDocument(chatId, new InputFile(bytes, file.filename), caption ? { caption } : {});
    },
  };
}

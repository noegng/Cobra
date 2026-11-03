/**
 * grammY bot: onboarding (~60 s), commands, fast path, LLM agent, voice notes.
 * Stateless per update (state lives in Postgres `flags`), so it runs on serverless webhooks.
 */
import { Api, Bot, InlineKeyboard, InputFile, type Context } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import type { LanguageModel } from "ai";
import type { Db, InvoiceRow } from "@cobra/db";
import { COUNTRIES, countryConfig, tokenByAddress, type CountryCode, type Language } from "@cobra/shared";
import { modelFromEnv, runAgent, type ToolContext } from "./agent";
import { amountStyleFor, parseAmount } from "./amount";
import { matchCharge } from "./fastpath";
import { amountErrorMessage, COUNTRY_LABEL, LANGUAGE_LABEL, LANGUAGES, languageFromTelegram, t } from "./i18n";
import { cancelInvoice, createInvoice, dailySummary, listInvoices } from "./invoices";
import { signDashboardToken } from "@cobra/shared/dashboard-token";
import { buildRipioOfframpLink, payUrl, proofUrl, qrPng, staticPayUrl } from "./links";
import {
  checkPayoutAddress,
  createMerchant,
  findMerchantByTelegramId,
  looksLikeSecret,
  settlementTokenFor,
  updateMerchant,
  type MerchantRow,
} from "./merchants";
import { invoiceCaption, invoiceLine, merchantLang, merchantName, money, shareLink } from "./present";
import { claimUpdate, deleteState, readState, stateKeys, writeState, type OnboardingState, type PendingPayout } from "./state";
import { localDate } from "./time";

export interface BotOptions {
  token: string;
  db: Db;
  anthropicApiKey: string;
  /** Public base URL of the web app, e.g. https://cobra.example — used for /pay/<id> links. */
  publicBaseUrl: string;
  /** Optional speech-to-text for voice notes. */
  transcribe?: (audio: ArrayBuffer, mime: string) => Promise<string>;
}

/** Test / wiring seams. All optional; production uses the defaults. */
export interface BotDeps {
  /** LLM. Default: Anthropic `COBRA_MODEL` (claude-haiku-5-5) when anthropicApiKey is set. `null` disables the LLM. */
  model?: LanguageModel | null;
  /** Skips getMe (tests, or a cached value on serverless cold starts). */
  botInfo?: UserFromGetMe;
  now?: () => Date;
  /** Downloads a Telegram file (voice notes). Default: global fetch. */
  fetchFile?: (url: string) => Promise<ArrayBuffer>;
  env?: Record<string, string | undefined>;
  /** Max LLM calls per merchant per minute (in-memory, best effort). Default 15. */
  llmPerMinute?: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface CobraFlavor {
  cobra: { merchant: MerchantRow | null; lang: Language; onboarding: OnboardingState | null };
}
export type CobraContext = Context & CobraFlavor;
export type CobraBot = Bot<CobraContext>;

const MAX_VOICE_SECONDS = 60;

export const COMMANDS = {
  start: ["start"],
  charge: ["cobrar", "charge"],
  invoices: ["facturas", "faturas", "invoices"],
  close: ["cierre", "fechamento", "close"],
  withdraw: ["retirar", "sacar", "withdraw"],
  panel: ["panel", "painel", "dashboard"],
  language: ["idioma", "language"],
  help: ["ayuda", "ajuda", "help"],
} as const;

/** Command menus per language, for `setMyCommands` (run once at deploy: `registerBotCommands(new Api(token))`). */
export async function registerBotCommands(api: Api): Promise<void> {
  const menus: Record<Language, Array<[string, string]>> = {
    es: [["cobrar", "Crear un cobro"], ["facturas", "Últimos cobros"], ["cierre", "Cierre del día"], ["retirar", "Pasar a tu banco"], ["idioma", "Idioma"], ["ayuda", "Ayuda"]],
    pt: [["cobrar", "Criar cobrança"], ["faturas", "Últimas cobranças"], ["fechamento", "Fechamento do dia"], ["sacar", "Levar para o banco"], ["idioma", "Idioma"], ["ajuda", "Ajuda"]],
    en: [["charge", "Create a payment request"], ["invoices", "Latest requests"], ["close", "Daily close"], ["withdraw", "Cash out"], ["language", "Language"], ["help", "Help"]],
  };
  for (const lang of LANGUAGES) {
    const commands = menus[lang].map(([command, description]) => ({ command, description }));
    await api.setMyCommands(commands, lang === "es" ? {} : { language_code: lang });
  }
}

export function buildBot(opts: BotOptions, deps: BotDeps = {}): CobraBot {
  const db = opts.db;
  const now = deps.now ?? (() => new Date());
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((msg, extra) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra })));
  const model: LanguageModel | null =
    deps.model !== undefined ? deps.model : opts.anthropicApiKey ? modelFromEnv(opts.anthropicApiKey, env) : null;
  const fetchFile =
    deps.fetchFile ??
    (async (url: string) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`file download failed: HTTP ${res.status}`);
      return res.arrayBuffer();
    });
  const llmPerMinute = deps.llmPerMinute ?? 15;
  const llmCalls = new Map<string, number[]>();

  const bot = new Bot<CobraContext>(opts.token, deps.botInfo ? { botInfo: deps.botInfo } : {});

  bot.catch((err) => {
    log("bot_error", { update_id: err.ctx.update.update_id, error: err.error instanceof Error ? err.error.message : String(err.error) });
  });

  // At-least-once delivery: handle each Telegram update_id once (a resent update would answer twice).
  bot.use(async (ctx, next) => {
    if (!(await claimUpdate(db, ctx.update.update_id))) {
      log("bot_duplicate_update", { update_id: ctx.update.update_id });
      return;
    }
    await next();
  });

  // Private chats only; resolve merchant strictly from the Telegram user id.
  bot.use(async (ctx, next) => {
    if (!ctx.from || ctx.from.is_bot) return;
    if (ctx.chat && ctx.chat.type !== "private") return;
    const merchant = await findMerchantByTelegramId(db, ctx.from.id);
    const onboarding = merchant ? null : await readState<OnboardingState>(db, stateKeys.onboarding(ctx.from.id));
    const lang = merchant ? merchantLang(merchant) : (onboarding?.language ?? languageFromTelegram(ctx.from.language_code));
    ctx.cobra = { merchant, lang, onboarding };
    await next();
  });

  const tokenSymbol = (m: MerchantRow) => tokenByAddress(m.settlementToken)?.symbol ?? "wFIAT";

  // ---------- onboarding ----------
  function countryKeyboard(lang: Language): InlineKeyboard {
    const kb = new InlineKeyboard();
    COUNTRIES.forEach((c, i) => {
      kb.text(`${COUNTRY_LABEL[c.country][lang]} (${c.currency})`, `country:${c.country}`);
      if (i % 2 === 1) kb.row();
    });
    kb.row();
    for (const l of LANGUAGES) kb.text(LANGUAGE_LABEL[l], `lang:${l}`);
    return kb;
  }

  function languageKeyboard(): InlineKeyboard {
    const kb = new InlineKeyboard();
    for (const l of LANGUAGES) kb.text(LANGUAGE_LABEL[l], `lang:${l}`);
    return kb;
  }

  bot.command(COMMANDS.start as unknown as string[], async (ctx) => {
    const { merchant, lang } = ctx.cobra;
    if (merchant) {
      await ctx.reply(t(lang, "welcome_back", { name: merchantName(merchant) }));
      return;
    }
    const state: OnboardingState = { step: "country", language: lang };
    await writeState(db, stateKeys.onboarding(ctx.from!.id), state);
    await ctx.reply(t(lang, "welcome_new"), { reply_markup: countryKeyboard(lang) });
  });

  bot.callbackQuery(/^country:(AR|BR|MX|CO|CL|PE)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const { merchant, lang } = ctx.cobra;
    if (merchant) return;
    const country = ctx.match[1] as CountryCode;
    const cfg = countryConfig(country);
    const token = settlementTokenFor(country);
    if (!token) {
      await ctx.reply(t(lang, "country_unavailable", { country: COUNTRY_LABEL[country][lang], currency: cfg.currency }), {
        reply_markup: countryKeyboard(lang),
      });
      return;
    }
    await writeState(db, stateKeys.onboarding(ctx.from.id), { step: "address", language: lang, country } satisfies OnboardingState);
    if (!cfg.conversion) {
      await ctx.reply(t(lang, "country_no_conversion", { country: COUNTRY_LABEL[country][lang], token: token.symbol }));
    }
    await ctx.reply(t(lang, "ask_address", { token: token.symbol }));
  });

  bot.callbackQuery(/^lang:(es|pt|en)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const lang = ctx.match[1] as Language;
    const { merchant, onboarding } = ctx.cobra;
    if (merchant) {
      await updateMerchant(db, merchant.id, { language: lang });
    } else {
      await writeState(db, stateKeys.onboarding(ctx.from.id), { ...(onboarding ?? { step: "country" }), language: lang } satisfies OnboardingState);
    }
    ctx.cobra.lang = lang;
    await ctx.reply(t(lang, "language_set"));
    if (!merchant && (onboarding?.step ?? "country") === "country") {
      await ctx.reply(t(lang, "welcome_new"), { reply_markup: countryKeyboard(lang) });
    }
  });

  async function handleAddress(ctx: CobraContext, text: string, state: OnboardingState) {
    const lang = state.language;
    const check = checkPayoutAddress(text);
    if (!check.ok) {
      const key = check.error === "secret" ? "address_secret" : check.error === "checksum" ? "address_checksum" : check.error === "forbidden" ? "address_forbidden" : "address_invalid";
      await ctx.reply(t(lang, key));
      return;
    }
    const from = ctx.from!;
    let merchant: MerchantRow;
    try {
      merchant = await createMerchant(db, {
        telegramUserId: from.id,
        telegramChatId: ctx.chat!.id,
        displayName: [from.first_name, from.last_name].filter(Boolean).join(" ").slice(0, 60) || null,
        country: state.country!,
        payoutAddress: check.address,
        language: lang,
      });
    } catch (e) {
      const existing = await findMerchantByTelegramId(db, from.id); // double submit
      if (!existing) throw e;
      merchant = existing;
    }
    await deleteState(db, stateKeys.onboarding(from.id));
    ctx.cobra.merchant = merchant;
    const url = staticPayUrl(opts.publicBaseUrl, merchant.staticSlug);
    await ctx.reply(t(lang, "onboarding_done", { name: merchantName(merchant), token: tokenSymbol(merchant), address: merchant.payoutAddress }));
    await ctx.replyWithPhoto(new InputFile(await qrPng(url), `cobra-${merchant.staticSlug}.png`), {
      caption: t(lang, "static_qr_caption", { url }),
    });
    await ctx.reply(t(lang, "proof_hint", { url: proofUrl(opts.publicBaseUrl, merchant.staticSlug) }), {
      link_preview_options: { is_disabled: true },
    });
  }

  // ---------- invoices ----------
  async function sendInvoice(ctx: CobraContext, merchant: MerchantRow, inv: InvoiceRow) {
    const lang = merchantLang(merchant);
    const url = payUrl(opts.publicBaseUrl, inv.id);
    const kb = new InlineKeyboard()
      .url(t(lang, "btn_whatsapp"), shareLink(merchant, inv, opts.publicBaseUrl))
      .row()
      .url(t(lang, "btn_open"), url)
      .row()
      .text(t(lang, "btn_cancel"), `cx:${inv.reference}`);
    await ctx.replyWithPhoto(new InputFile(await qrPng(url), `cobra-${inv.reference}.png`), {
      caption: invoiceCaption(merchant, inv, opts.publicBaseUrl, now()),
      reply_markup: kb,
    });
  }

  async function handleCharge(ctx: CobraContext, merchant: MerchantRow, amountText: string, description: string) {
    const lang = merchantLang(merchant);
    if (!amountText) {
      await ctx.reply(t(lang, "usage_cobrar"));
      return;
    }
    const parsed = parseAmount(amountText, amountStyleFor(merchant.country, merchant.language));
    if (!parsed.ok) {
      await ctx.reply(amountErrorMessage(lang, parsed.error, amountText, merchant.currency));
      return;
    }
    const res = await createInvoice(db, merchant, { amountLocal: parsed.value, description, now: now() });
    if (!res.ok) {
      await ctx.reply(t(lang, res.error === "rate_limited" ? "rate_limited" : "unsupported_settlement", { currency: merchant.currency }));
      return;
    }
    await sendInvoice(ctx, merchant, res.invoice);
  }

  async function sendPayoutConfirmation(ctx: CobraContext, lang: Language, pending: PendingPayout) {
    const kb = new InlineKeyboard().text(t(lang, "btn_confirm"), `po:${pending.nonce}`).text(t(lang, "btn_reject"), `pn:${pending.nonce}`);
    await ctx.reply(t(lang, "payout_confirm", { address: pending.address }), { reply_markup: kb });
  }

  function llmAllowed(merchantId: string): boolean {
    const t0 = now().getTime();
    const recent = (llmCalls.get(merchantId) ?? []).filter((x) => t0 - x < 60_000);
    if (recent.length >= llmPerMinute) {
      llmCalls.set(merchantId, recent);
      return false;
    }
    recent.push(t0);
    llmCalls.set(merchantId, recent);
    return true;
  }

  async function handleAgent(ctx: CobraContext, merchant: MerchantRow, text: string) {
    const lang = merchantLang(merchant);
    if (!model) {
      await ctx.reply(t(lang, "llm_unavailable"));
      return;
    }
    if (!llmAllowed(merchant.id)) {
      await ctx.reply(t(lang, "busy"));
      return;
    }
    await ctx.replyWithChatAction("typing").catch(() => {});
    const toolCtx: ToolContext = { db, merchant, publicBaseUrl: opts.publicBaseUrl, now, env };
    let result;
    try {
      result = await runAgent({ model, ctx: toolCtx, text: text.slice(0, 1000) });
    } catch (e) {
      log("agent_error", { merchantId: merchant.id, error: e instanceof Error ? e.message : String(e) });
      await ctx.reply(t(lang, "llm_error"));
      return;
    }
    log("agent_ok", { merchantId: merchant.id, tools: result.toolCalls });
    const m = toolCtx.merchant; // may have changed language
    const outLang = merchantLang(m);
    if (result.unknownToolCalls.length > 0) {
      // The model tried to call a tool that does not exist (e.g. "transfer_funds"): treat the turn as injected.
      // Its text is discarded (it may claim funds were sent) and any payout proposal from this turn is dropped.
      log("agent_suspicious", { merchantId: merchant.id, unknownTools: result.unknownToolCalls });
      if (result.effects.payoutConfirmation) await deleteState(db, stateKeys.pendingPayout(m.id));
      result.effects.payoutConfirmation = null;
      result.text = t(outLang, "cannot_move_funds");
    }
    if (result.text) await ctx.reply(result.text, { link_preview_options: { is_disabled: true } });
    for (const inv of result.effects.invoices) await sendInvoice(ctx, m, inv);
    for (const d of result.effects.documents) {
      await ctx.replyWithDocument(new InputFile(new TextEncoder().encode(d.content), d.filename), { caption: d.caption });
    }
    if (result.effects.payoutConfirmation) await sendPayoutConfirmation(ctx, outLang, result.effects.payoutConfirmation);
    if (!result.text && result.effects.invoices.length === 0 && result.effects.documents.length === 0 && !result.effects.payoutConfirmation) {
      await ctx.reply(t(outLang, "help", { token: tokenSymbol(m) }));
    }
  }

  /** Routes free text (typed or transcribed) for an onboarded merchant: fast path first, then the agent. */
  async function routeText(ctx: CobraContext, merchant: MerchantRow, text: string) {
    const charge = matchCharge(text);
    if (charge) return handleCharge(ctx, merchant, charge.amountText, charge.description);
    return handleAgent(ctx, merchant, text);
  }

  const requireMerchant = async (ctx: CobraContext): Promise<MerchantRow | null> => {
    if (ctx.cobra.merchant) return ctx.cobra.merchant;
    await ctx.reply(t(ctx.cobra.lang, "not_onboarded"));
    return null;
  };

  // ---------- commands ----------
  bot.command(COMMANDS.charge as unknown as string[], async (ctx) => {
    const merchant = await requireMerchant(ctx);
    if (!merchant) return;
    const args = String(ctx.match ?? "").trim();
    const charge = matchCharge(`cobrar ${args}`);
    if (charge) return handleCharge(ctx, merchant, charge.amountText, charge.description);
    return handleAgent(ctx, merchant, `cobrar ${args}`);
  });

  bot.command(COMMANDS.invoices as unknown as string[], async (ctx) => {
    const merchant = await requireMerchant(ctx);
    if (!merchant) return;
    const lang = merchantLang(merchant);
    const rows = await listInvoices(db, merchant.id, { limit: 10 });
    if (rows.length === 0) {
      await ctx.reply(t(lang, "invoices_empty"));
      return;
    }
    await ctx.reply([t(lang, "invoices_header"), ...rows.map((r) => invoiceLine(merchant, r))].join("\n"));
  });

  bot.command(COMMANDS.close as unknown as string[], async (ctx) => {
    const merchant = await requireMerchant(ctx);
    if (!merchant) return;
    const lang = merchantLang(merchant);
    const date = localDate(now(), merchant.timezone);
    const s = await dailySummary(db, merchant, date);
    await ctx.reply(
      [
        t(lang, "close_header", { date }),
        t(lang, "close_body", {
          paidTotal: money(merchant, s.paidTotal, s.currency),
          paidCount: s.paidCount,
          open: s.open,
          expired: s.expired,
          cancelled: s.cancelled,
          created: s.created,
        }),
      ].join("\n"),
    );
    if (s.rows.length > 0) {
      await ctx.replyWithDocument(new InputFile(new TextEncoder().encode(s.csv), `cobra-${date}.csv`), {
        caption: t(lang, "close_csv_caption", { date }),
      });
    }
  });

  bot.command(COMMANDS.withdraw as unknown as string[], async (ctx) => {
    const merchant = await requireMerchant(ctx);
    if (!merchant) return;
    const lang = merchantLang(merchant);
    const token = tokenSymbol(merchant);
    const url = buildRipioOfframpLink(token);
    await ctx.reply(t(lang, "withdraw_link", { token, url, address: merchant.payoutAddress }));
  });

  bot.command(COMMANDS.panel as unknown as string[], async (ctx) => {
    const merchant = await requireMerchant(ctx);
    if (!merchant) return;
    const secret = env.DASHBOARD_SECRET;
    if (!secret) {
      await ctx.reply(t(merchantLang(merchant), "panel_unavailable"));
      return;
    }
    const token = signDashboardToken({ merchantId: merchant.id, now: now().getTime() }, secret);
    const url = `${opts.publicBaseUrl.replace(/\/+$/, "")}/dashboard?t=${encodeURIComponent(token)}`;
    await ctx.reply(t(merchantLang(merchant), "panel_link", { url }));
  });

  bot.command(COMMANDS.language as unknown as string[], async (ctx) => {
    await ctx.reply(t(ctx.cobra.lang, "choose_language"), { reply_markup: languageKeyboard() });
  });

  bot.command(COMMANDS.help as unknown as string[], async (ctx) => {
    const m = ctx.cobra.merchant;
    await ctx.reply(m ? t(ctx.cobra.lang, "help", { token: tokenSymbol(m) }) : t(ctx.cobra.lang, "not_onboarded"));
  });

  // ---------- callbacks ----------
  bot.callbackQuery(/^cx:(A-\d{1,9})$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const merchant = ctx.cobra.merchant;
    if (!merchant) return;
    const lang = merchantLang(merchant);
    const res = await cancelInvoice(db, merchant.id, ctx.match[1]!);
    if (res.ok) await ctx.reply(t(lang, "cancelled_ok", { ref: res.invoice.reference ?? "" }));
    else if (res.error === "not_found") await ctx.reply(t(lang, "cancel_not_found"));
    else await ctx.reply(t(lang, "cancel_not_open", { ref: res.invoice.reference ?? "", status: t(lang, `status_${res.invoice.status}` as never) }));
  });

  bot.callbackQuery(/^(po|pn):([0-9a-f]{12})$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const merchant = ctx.cobra.merchant;
    if (!merchant) return;
    const lang = merchantLang(merchant);
    const key = stateKeys.pendingPayout(merchant.id);
    const pending = await readState<PendingPayout>(db, key);
    if (!pending || pending.nonce !== ctx.match[2] || pending.expiresAt < now().getTime()) {
      await ctx.reply(t(lang, "payout_expired"));
      return;
    }
    await deleteState(db, key);
    if (ctx.match[1] === "pn") {
      await ctx.reply(t(lang, "payout_rejected"));
      return;
    }
    const check = checkPayoutAddress(pending.address);
    if (!check.ok) {
      await ctx.reply(t(lang, "address_invalid"));
      return;
    }
    await updateMerchant(db, merchant.id, { payoutAddress: check.address, payoutAddressProven: 0 });
    await ctx.reply(t(lang, "payout_updated", { address: check.address }));
  });

  bot.on("callback_query:data", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
  });

  // ---------- free text / voice ----------
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    const { merchant, onboarding, lang } = ctx.cobra;
    if (!merchant && onboarding?.step === "address" && onboarding.country) return handleAddress(ctx, text, onboarding);
    // A pasted private key / seed phrase is never forwarded to the LLM (or anywhere else).
    if (looksLikeSecret(text)) {
      await ctx.reply(t(lang, "address_secret"));
      return;
    }
    if (!merchant) {
      await ctx.reply(t(lang, "not_onboarded"));
      return;
    }
    if (text.startsWith("/") && !matchCharge(text)) {
      await ctx.reply(t(lang, "help", { token: tokenSymbol(merchant) }));
      return;
    }
    await routeText(ctx, merchant, text);
  });

  bot.on("message:voice", async (ctx) => {
    const merchant = await requireMerchant(ctx);
    if (!merchant) return;
    const lang = merchantLang(merchant);
    if (!opts.transcribe) {
      await ctx.reply(t(lang, "voice_unsupported"));
      return;
    }
    const voice = ctx.message.voice;
    if (voice.duration > MAX_VOICE_SECONDS) {
      await ctx.reply(t(lang, "voice_too_long"));
      return;
    }
    let text: string;
    try {
      const file = await ctx.getFile();
      if (!file.file_path) throw new Error("no file_path");
      const audio = await fetchFile(`https://api.telegram.org/file/bot${opts.token}/${file.file_path}`);
      text = (await opts.transcribe(audio, voice.mime_type ?? "audio/ogg")).trim();
    } catch (e) {
      log("voice_error", { merchantId: merchant.id, error: e instanceof Error ? e.message.replace(opts.token, "***") : "error" });
      await ctx.reply(t(lang, "voice_failed"));
      return;
    }
    if (!text) {
      await ctx.reply(t(lang, "voice_failed"));
      return;
    }
    await ctx.reply(t(lang, "voice_heard", { text: text.slice(0, 300) }));
    await routeText(ctx, merchant, text);
  });

  return bot;
}

export { Api };

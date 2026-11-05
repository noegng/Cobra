"use client";

/**
 * /demo: the merchant's Telegram chat and the customer's phone side by side, fully simulated in the browser.
 * No network call, no wallet, no LLM: amounts go through the bot's real parser (engine.ts).
 */
import { useEffect, useRef, useState } from "react";
import type { Language } from "@cobra/shared";
import { sumDecimals } from "@cobra/bot/amount";
import { FakeQr } from "../fake-qr";
import { DEMO } from "./demo-i18n";
import { fiatName, RECEIPT, tokenName } from "../../lib/units";
import {
  DEMO_BALANCE_MICRO,
  DEMO_COUNTRIES,
  DEMO_MAX_USD,
  demoCurrencyName,
  formatLocal,
  formatLocalNamed,
  formatUsdt,
  handleMerchantText,
  nextRef,
  quoteMicro,
  type DemoCountry,
  type DemoInvoice,
} from "./engine";

/** `confirm`: a large charge waiting for "yes / fix" (same flow as the real bot); `done` once a button was used. */
type Msg = {
  id: number;
  from: "me" | "bot";
  text: string;
  invoiceRef?: string;
  paid?: boolean;
  confirm?: { invoice: DemoInvoice; usdMicro: bigint; done?: boolean };
};
type PayerStep = "idle" | "connected" | "ramping" | "signing" | "paying" | "paid";
type LogLine = { id: number; text: string };
type Tab = "merchant" | "payer" | "agent";

const TTL_MS = 10 * 60_000;

export function DemoApp({ lang, telegramUrl }: { lang: Language; telegramUrl: string }) {
  const t = DEMO[lang];
  const [country, setCountry] = useState<DemoCountry>(lang === "pt" ? "BR" : "AR");
  const welcome = (c: DemoCountry) => DEMO[lang].welcome(demoCurrencyName(c, lang), DEMO[lang].chips[c][0]!);
  const [msgs, setMsgs] = useState<Msg[]>(() => [{ id: 0, from: "bot", text: welcome(lang === "pt" ? "BR" : "AR") }]);
  const [invoices, setInvoices] = useState<DemoInvoice[]>([]);
  const [created, setCreated] = useState<Record<string, number>>({});
  const [active, setActive] = useState<string | null>(null);
  const [step, setStep] = useState<PayerStep>("idle");
  /** Ramp countries: invoices whose wFIAT the payer already bought through the (simulated) Ripio ramp. */
  const [ramped, setRamped] = useState<Record<string, boolean>>({});
  const [log, setLog] = useState<LogLine[]>([]);
  const [input, setInput] = useState("");
  const [typing, setTyping] = useState(false);
  const [tab, setTab] = useState<Tab>("merchant");
  const [now, setNow] = useState(() => Date.now());
  const ids = useRef(1);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const chatEnd = useRef<HTMLDivElement>(null);

  const cfg = DEMO_COUNTRIES[country];
  const inv = invoices.find((i) => i.ref === active) ?? null;
  /** Payer pane: "$ 4.500" with the currency name on its own line below. */
  const fmt = (amount: string) => formatLocal(amount, country, lang);
  /** Chat: "$ 4.500 pesos argentinos", the currency always written out. */
  const fmtN = (amount: string) => formatLocalNamed(amount, country, lang);
  const cur = demoCurrencyName(country, lang);
  const nid = () => ids.current++;
  const later = (ms: number, fn: () => void) => timers.current.push(setTimeout(fn, ms));
  const addBot = (m: Omit<Msg, "id" | "from">) => setMsgs((xs) => [...xs, { id: nid(), from: "bot", ...m }]);
  const addLog = (text: string) => setLog((xs) => [...xs, { id: nid(), text }]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  useEffect(() => {
    chatEnd.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [msgs, typing]);

  function reset(next: DemoCountry = country) {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setCountry(next);
    setMsgs([{ id: nid(), from: "bot", text: welcome(next) }]);
    setInvoices([]);
    setCreated({});
    setActive(null);
    setStep("idle");
    setRamped({});
    setLog([]);
    setTyping(false);
    setTab("merchant");
  }

  function createCharge(draft: DemoInvoice, usdMicro: bigint) {
    const i: DemoInvoice = { ...draft, ref: nextRef(invoices.length + 1) };
    setInvoices((xs) => [...xs, i]);
    setCreated((c) => ({ ...c, [i.ref]: Date.now() }));
    setActive(i.ref);
    setStep("idle");
    addBot({ text: t.invoice_caption(i.ref, fmtN(i.amount), formatUsdt(usdMicro, lang), i.desc), invoiceRef: i.ref });
    addLog(t.agent_invoice(i.ref));
  }

  /** "Yes" creates the request; "fix" creates nothing. Each confirmation can be used once. */
  function answerConfirm(msgId: number, yes: boolean) {
    const m = msgs.find((x) => x.id === msgId);
    if (!m?.confirm || m.confirm.done || typing) return;
    const c = m.confirm;
    setMsgs((xs) => xs.map((x) => (x.id === msgId && x.confirm ? { ...x, confirm: { ...x.confirm, done: true } } : x)));
    if (yes) createCharge(c.invoice, c.usdMicro);
    else addBot({ text: t.charge_fix(cur) });
  }

  function send(raw: string) {
    const text = raw.trim();
    if (!text || typing) return;
    setInput("");
    setMsgs((xs) => [...xs, { id: nid(), from: "me", text }]);
    const action = handleMerchantText(text, { country, lang, invoices });
    setTyping(true);
    later(450, () => {
      setTyping(false);
      switch (action.kind) {
        case "charge":
          createCharge(action.invoice, action.usdMicro);
          break;
        case "confirm":
          addBot({
            text: t.charge_confirm(fmtN(action.invoice.amount), formatUsdt(action.usdMicro, lang), action.invoice.desc),
            confirm: { invoice: action.invoice, usdMicro: action.usdMicro },
          });
          break;
        case "over":
          addBot({ text: t.charge_over(fmtN(action.amount), formatUsdt(action.usdMicro, lang), DEMO_MAX_USD, cur) });
          break;
        case "amount_error":
          addBot({ text: t.amount_error(action.error, action.input) });
          break;
        case "usage":
          addBot({ text: t.usage(cur) });
          break;
        case "help":
          addBot({ text: t.help(cur) });
          break;
        case "unknown":
          addBot({ text: t.unknown });
          break;
        case "cancel":
          if (!action.invoice) addBot({ text: t.cancel_none });
          else {
            const ref = action.invoice.ref;
            setInvoices((xs) => xs.map((x) => (x.ref === ref ? { ...x, status: "cancelled" } : x)));
            addBot({ text: t.cancel_ok(ref) });
          }
          break;
        case "status": {
          const i = action.invoice;
          if (!i) addBot({ text: t.status_none });
          else if (i.status === "paid") addBot({ text: t.status_paid(i.ref, fmtN(i.amount)) });
          else if (i.status === "cancelled") addBot({ text: t.status_cancelled(i.ref) });
          else addBot({ text: t.status_open(i.ref, fmtN(i.amount)) });
          break;
        }
        case "close": {
          const total = action.paid.length ? sumDecimals(action.paid.map((p) => p.amount)) : "0";
          addBot({ text: t.close(fmtN(total), action.paid.length, action.open) });
          break;
        }
      }
    });
  }

  const isRamp = cfg.mode === "ramp";
  const quote = inv && !isRamp ? quoteMicro(inv.amount, country) : 0n;
  const insufficient = !isRamp && quote > DEMO_BALANCE_MICRO;
  const hasToken = !!inv && !!ramped[inv.ref];
  /** "4.500,50" without the currency symbol, for wFIAT amounts. */
  const tokAmt = (amount: string) => fmt(amount).replace(/^\S+\s/, "");
  const remaining = inv && created[inv.ref] ? Math.max(0, created[inv.ref]! + TTL_MS - now) : 0;
  const mm = String(Math.floor(remaining / 60_000)).padStart(2, "0");
  const ss = String(Math.floor((remaining % 60_000) / 1000)).padStart(2, "0");
  const costPct = (cfg.costBps / 100).toLocaleString(lang === "en" ? "en-US" : lang === "pt" ? "pt-BR" : "es-AR", { maximumFractionDigits: 2 }) + " %";

  function connect() {
    setStep("connected");
    if (isRamp && inv && !ramped[inv.ref]) addLog(t.agent_no_route(cfg.token));
  }

  /** Simulated Ripio on-ramp: the payer buys exactly the invoice amount of wFIAT in local currency. */
  function ramp() {
    if (!inv || !isRamp || step !== "connected") return;
    const ref = inv.ref;
    const amount = inv.amount;
    setStep("ramping");
    later(1800, () => {
      setRamped((r) => ({ ...r, [ref]: true }));
      addLog(t.agent_ramp(tokAmt(amount), cfg.token, cfg.rail ?? ""));
      setStep("connected");
    });
  }

  function pay() {
    if (!inv || insufficient || step !== "connected" || (isRamp && !ramped[inv.ref])) return;
    const ref = inv.ref;
    const amount = inv.amount;
    setStep("signing");
    later(1100, () => {
      if (isRamp) {
        addLog(t.agent_direct(cfg.token));
        addLog(t.agent_gas_grant);
      } else {
        addLog(t.agent_route(cfg.route, costPct));
        addLog(t.agent_gas);
      }
      setStep("paying");
    });
    later(2500, () => {
      addLog(t.agent_relay);
      addLog(t.agent_settle(fmt(amount), cfg.token));
      setInvoices((xs) => xs.map((x) => (x.ref === ref ? { ...x, status: "paid" } : x)));
      setStep("paid");
    });
    later(3100, () => {
      addBot({ text: t.paid_notice(ref, fmtN(amount), cfg.token), paid: true });
      addLog(t.agent_notify);
    });
  }

  const chips = t.chips[country];

  return (
    <div className="dm">
      <div className="dm-banner" role="note">
        <span className="dm-badge">DEMO</span> {t.banner}{" "}
        <a href="/proof">{t.banner_link} →</a>
      </div>

      <section className="dm-intro">
        <h1>{t.title}</h1>
        <p>{t.sub}</p>
        <div className="dm-controls">
          <div className="dm-seg" role="group" aria-label="Country">
            {(Object.keys(DEMO_COUNTRIES) as DemoCountry[]).map((c) => (
              <button key={c} type="button" aria-pressed={country === c} onClick={() => reset(c)}>
                {t.country[c]}
              </button>
            ))}
          </div>
          <button type="button" className="dm-link" onClick={() => reset()}>
            ↺ {t.reset}
          </button>
          <a className="lp-btn lp-btn-sm" href={telegramUrl} target="_blank" rel="noopener noreferrer">
            {t.real_bot} →
          </a>
        </div>
      </section>

      <nav className="dm-tabs" aria-label="Demo">
        {(["merchant", "payer", "agent"] as Tab[]).map((k) => (
          <button key={k} type="button" aria-pressed={tab === k} onClick={() => setTab(k)}>
            {k === "merchant" ? t.tab_merchant : k === "payer" ? t.tab_payer : t.tab_agent}
            {k === "payer" && inv && step !== "paid" && inv.status === "open" ? <span className="dm-dot" aria-hidden /> : null}
          </button>
        ))}
      </nav>

      <div className="dm-stage">
        {/* Merchant: Telegram chat */}
        <section className={`dm-pane ${tab === "merchant" ? "is-on" : ""}`} aria-label={t.merchant_side}>
          <h2 className="dm-label">{t.merchant_side}</h2>
          <div className="dm-phone">
            <div className="dm-bar">
              <img className="lp-avatar" src="/logo-192.png" alt="" width={30} height={30} />
              <span>
                <b>Cobrá</b>
                <small>bot · {cfg.merchant}</small>
              </span>
            </div>
            <div className="dm-chat" aria-live="polite">
              {msgs.map((m) => (
                <div key={m.id} className={`dm-msg ${m.from === "me" ? "me" : "bot"} ${m.paid ? "paid" : ""}`}>
                  {m.invoiceRef && <FakeQr seed={m.id * 7919 + 13} className="dm-qr" />}
                  <p>{m.text}</p>
                  {m.confirm && (
                    <div className="dm-kb">
                      <button type="button" disabled={m.confirm.done || typing} onClick={() => answerConfirm(m.id, true)}>
                        {t.btn_yes}
                      </button>
                      <button type="button" disabled={m.confirm.done || typing} onClick={() => answerConfirm(m.id, false)}>
                        {t.btn_fix}
                      </button>
                    </div>
                  )}
                  {m.invoiceRef && (
                    <div className="dm-kb">
                      <span>{t.btn_share}</span>
                      <button
                        type="button"
                        onClick={() => {
                          setActive(m.invoiceRef!);
                          setStep("idle");
                          setTab("payer");
                        }}
                      >
                        {t.btn_open_payer}
                      </button>
                    </div>
                  )}
                </div>
              ))}
              {typing && (
                <div className="dm-msg bot dm-typing" aria-label="…">
                  <i />
                  <i />
                  <i />
                </div>
              )}
              <div ref={chatEnd} />
            </div>
            <div className="dm-chips">
              {chips.map((c) => (
                <button key={c} type="button" onClick={() => send(c)} disabled={typing}>
                  {c}
                </button>
              ))}
            </div>
            <form
              className="dm-input"
              onSubmit={(e) => {
                e.preventDefault();
                send(input);
              }}
            >
              <input value={input} onChange={(e) => setInput(e.target.value)} placeholder={t.placeholder} aria-label={t.placeholder} maxLength={200} />
              <button type="submit" disabled={!input.trim() || typing} aria-label={t.send}>
                ➤
              </button>
            </form>
          </div>
        </section>

        {/* Customer: pay page */}
        <section className={`dm-pane ${tab === "payer" ? "is-on" : ""}`} aria-label={t.payer_side}>
          <h2 className="dm-label">{t.payer_side}</h2>
          <div className="dm-phone dm-pay">
            {!inv ? (
              <div className="dm-empty">
                <FakeQr seed={99} className="dm-qr dm-qr-muted" />
                <p>{t.payer_empty}</p>
              </div>
            ) : step === "paid" ? (
              <div className="dm-done">
                <div className="check" aria-hidden>✓</div>
                <h3>{t.payer_paid}</h3>
                <p className="dm-amount">{fmt(inv.amount)}</p>
                <p className="label">{fiatName(cfg.currency, lang)}</p>
                <p className="dm-muted">{t.payer_receipt(cfg.merchant)}</p>
                <p className="dm-sim">{t.payer_sim_tx}</p>
              </div>
            ) : (
              <div className="dm-checkout">
                <div className="dm-top">
                  <span>{cfg.merchant}</span>
                  {inv.status === "open" && <span className="tabular">{t.payer_expires} {mm}:{ss}</span>}
                </div>
                <div className="dm-hero">
                  <p className="dm-amount">{fmt(inv.amount)}</p>
                  <p className="label">{fiatName(cfg.currency, lang)}</p>
                  {inv.desc && <p className="dm-muted">{inv.desc}</p>}
                  <dl className="receipt dm-receipt">
                    <div>
                      <dt>{RECEIPT[lang].merchant_gets}</dt>
                      <dd>
                        {fmt(inv.amount).replace(/^\S+\s/, "")} {cfg.token}
                        <small>{tokenName(cfg.token, lang)}</small>
                      </dd>
                    </div>
                    <div className="receipt-total">
                      <dt>{RECEIPT[lang].you_pay}</dt>
                      <dd>
                        {step === "idle" ? "—" : isRamp ? `${tokAmt(inv.amount)} ${cfg.token}` : `${formatUsdt(quote, lang)} USD₮`}
                        <small>{step === "idle" ? RECEIPT[lang].you_pay_hint : tokenName(isRamp ? cfg.token : "USD₮", lang)}</small>
                      </dd>
                    </div>
                  </dl>
                  <p className="dm-muted mono">→ 0x7a3f…c0b4</p>
                </div>
                {inv.status === "cancelled" ? (
                  <p className="note">{t.payer_cancelled}</p>
                ) : step === "idle" ? (
                  <button type="button" className="btn primary" onClick={connect}>
                    {t.payer_connect}
                  </button>
                ) : isRamp ? (
                  <div className="stack">
                    <p className="dm-wallet">{t.payer_wallet_ramp(formatUsdt(DEMO_BALANCE_MICRO, lang), hasToken ? tokAmt(inv.amount) : "0", cfg.token)}</p>
                    {!hasToken ? (
                      <>
                        <p className="note">{t.payer_no_route(cfg.token)}</p>
                        <button type="button" className="btn primary" onClick={ramp} disabled={step !== "connected"}>
                          {step === "ramping" ? (
                            <>
                              <span className="spin" aria-hidden /> {t.payer_ramping(cfg.rail ?? "")}
                            </>
                          ) : (
                            t.payer_ramp_btn(tokAmt(inv.amount), cfg.token)
                          )}
                        </button>
                        <p className="dm-fine">{t.payer_ramp_note}</p>
                      </>
                    ) : (
                      <>
                        <p className="note">{t.payer_ramp_done(tokAmt(inv.amount), cfg.token)}</p>
                        <button type="button" className="btn primary" onClick={pay} disabled={step !== "connected"}>
                          {step === "signing" ? (
                            <>
                              <span className="spin" aria-hidden /> {t.payer_signing}
                            </>
                          ) : step === "paying" ? (
                            <>
                              <span className="spin" aria-hidden /> {t.payer_paying}
                            </>
                          ) : (
                            t.payer_pay_token(tokAmt(inv.amount), cfg.token)
                          )}
                        </button>
                        <p className="note">{t.payer_note}</p>
                      </>
                    )}
                  </div>
                ) : (
                  <div className="stack">
                    <p className="dm-wallet">{t.payer_wallet(formatUsdt(DEMO_BALANCE_MICRO, lang))}</p>
                    {insufficient ? (
                      <p className="note">{t.payer_insufficient}</p>
                    ) : (
                      <button type="button" className="btn primary" onClick={pay} disabled={step !== "connected"}>
                        {step === "signing" ? (
                          <>
                            <span className="spin" aria-hidden /> {t.payer_signing}
                          </>
                        ) : step === "paying" ? (
                          <>
                            <span className="spin" aria-hidden /> {t.payer_paying}
                          </>
                        ) : (
                          t.payer_pay(formatUsdt(quote, lang))
                        )}
                      </button>
                    )}
                    <p className="note">{t.payer_note}</p>
                    <p className="dm-fine">{t.payer_illustrative}</p>
                  </div>
                )}
              </div>
            )}
          </div>
        </section>

        {/* Agent log */}
        <section className={`dm-pane dm-agent ${tab === "agent" ? "is-on" : ""}`} aria-label={t.agent_side}>
          <h2 className="dm-label">{t.agent_side}</h2>
          <ol className="dm-log" aria-live="polite">
            {log.length === 0 ? <li className="dm-muted">{t.agent_idle}</li> : log.map((l) => <li key={l.id}>{l.text}</li>)}
          </ol>
          <p className="dm-fine">
            {t.agent_footer} <a href="/proof#journal">/proof →</a>
          </p>
        </section>
      </div>
    </div>
  );
}

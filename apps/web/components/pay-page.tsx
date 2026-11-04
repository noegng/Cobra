"use client";

/**
 * Pay page: one amount, one button. Every step that does not need the payer's decision happens on its own:
 * the quote is computed on connect and refreshed before it expires, the approval is followed on-chain, the gas
 * grant is awaited, and the invoice status is polled until it is paid.
 */
import { useCallback, useEffect, useState } from "react";
import { erc20Abi, maxUint256, type Address, type Hex } from "viem";
import { celo } from "viem/chains";
import { useConnect, useConnection, useConnectors, useDisconnect, usePublicClient, useSignTypedData, useSwitchChain, useWalletClient } from "wagmi";
import { HACKATHON_ATTRIBUTION_CODE, explorerAddress, explorerTx, type Language } from "@cobra/shared";
import { allowanceLegs, allowancePlan, approveCalldata, attributionSuffix, feeCurrencyFor, invoiceFromWire } from "../lib/allowance";
import { formatDecimal, formatUnits } from "../lib/amount";
import { DICTS, localeFor, tr, type Dict } from "../lib/i18n";
import { hydrateTypedData, type PublicInvoice, type QuoteError, type QuoteOk, type StatusResponse } from "../lib/wire";
import { LangSwitch } from "./lang-switch";
import { fiatName, legsName, RECEIPT, tokenName } from "../lib/units";

const ATTRIBUTION_CODE = process.env.NEXT_PUBLIC_ATTRIBUTION_CODE || HACKATHON_ATTRIBUTION_CODE;
/** Native balance that covers one ERC-20 approval even at a 2x base fee (~55k gas × ~400 gwei). */
const GAS_FOR_APPROVAL_WEI = 25_000_000_000_000_000n; // 0.025 CELO
/** How long to wait for the agent's gas grant before telling the payer CELO is missing. */
const GAS_WAIT_MS = 90_000;
const TERMINAL = new Set(["paid", "expired", "cancelled"]);

type Busy = null | "quoting" | "approving" | "signing" | "submitting" | "sending";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

function errorKey(code: string | undefined): keyof Dict {
  switch (code) {
    case "invoice_expired":
      return "expired";
    case "invoice_not_open":
    case "already_submitted":
      return "not_open";
    case "insufficient_balance":
      return "insufficient";
    case "no_route":
    case "price_guard":
      return "no_route";
    case "over_cap":
      return "over_cap";
    case "rate_limited":
    case "temporarily_unavailable":
    case "upstream_unavailable":
    case "solver_unavailable":
    case "not_configured":
      return "temporarily_unavailable";
    default:
      return "generic_error";
  }
}

const isRejection = (e: unknown) => /UserRejected|rejected|denied|cancel/i.test(`${(e as Error)?.name ?? ""}${(e as Error)?.message ?? ""}`);

export function PayPage({ invoice, lang }: { invoice: PublicInvoice; lang: Language }) {
  const t = DICTS[lang];
  const locale = localeFor(lang, invoice.currency);
  const now = useNow(1000);
  const remainingS = Math.max(0, Math.floor((Date.parse(invoice.expiresAt) - now) / 1000));

  const [status, setStatus] = useState(invoice.status);
  const [txHash, setTxHash] = useState<Hex | null>(null);
  const [quote, setQuote] = useState<QuoteOk | null>(null);
  const [quoteErr, setQuoteErr] = useState<QuoteError | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<keyof Dict | null>(null);
  const [approving, setApproving] = useState<Address | null>(null);
  const [gasWaitSince, setGasWaitSince] = useState<number | null>(null);
  const [nativeBal, setNativeBal] = useState<bigint | null>(null);

  const { address, isConnected, chainId } = useConnection();
  const connectors = useConnectors();
  const connect = useConnect();
  const { mutate: disconnect } = useDisconnect();
  const switchChain = useSwitchChain();
  const signTypedData = useSignTypedData();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();

  const paid = status === "paid";
  const closed = TERMINAL.has(status) || remainingS <= 0;
  const inFlight = status === "submitted";
  const onCelo = isConnected && chainId === celo.id;

  // MiniPay injects window.ethereum and expects the dapp to connect without a button.
  useEffect(() => {
    const eth = (globalThis as { ethereum?: { isMiniPay?: boolean } }).ethereum;
    const inj = connectors.find((c) => c.type === "injected");
    if (eth?.isMiniPay && !isConnected && inj) connect.mutate({ connector: inj });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectors, isConnected]);

  // Status: polled until the invoice is final (paid from another device, relayed, expired…).
  const pollStatus = useCallback(async () => {
    const res = await fetch(`/api/invoices/${invoice.id}/status`, { cache: "no-store" }).catch(() => null);
    if (!res?.ok) return;
    const s = (await res.json()) as StatusResponse;
    setStatus(s.status);
    if (s.txHash) setTxHash(s.txHash);
    if (s.status === "open" && s.submission?.status === "failed") setNotice("generic_error");
  }, [invoice.id]);
  useEffect(() => {
    if (TERMINAL.has(status)) return;
    void pollStatus();
    const id = setInterval(pollStatus, 3000);
    return () => clearInterval(id);
  }, [status, pollStatus]);

  const getQuote = useCallback(async () => {
    if (!address) return;
    setBusy("quoting");
    setQuoteErr(null);
    try {
      const res = await fetch(`/api/invoices/${invoice.id}/quote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payer: address }),
      });
      const body = (await res.json()) as QuoteOk & QuoteError;
      if (res.ok) setQuote(body);
      else {
        setQuote(null);
        setQuoteErr(body);
      }
    } catch {
      setQuoteErr({ error: "generic_error" } as QuoteError);
    } finally {
      setBusy(null);
    }
  }, [address, invoice.id]);

  // Quote on connect, and again just before it expires.
  useEffect(() => {
    if (onCelo && !closed && !inFlight && !quote && !quoteErr && !busy) void getQuote();
  }, [onCelo, closed, inFlight, quote, quoteErr, busy, getQuote]);
  useEffect(() => {
    if (!quote) return;
    const ms = Date.parse(quote.quoteExpiresAt) - Date.now() - 2000;
    const id = setTimeout(() => setQuote(null), Math.max(0, ms));
    return () => clearTimeout(id);
  }, [quote]);
  useEffect(() => {
    setQuote(null);
    setQuoteErr(null);
  }, [address]);

  // One-time Permit2 approval of a wFIAT: wait for gas (the agent sends some to payers without CELO), then follow
  // the allowance on-chain and re-quote as soon as it is there, without depending on the wallet's receipt.
  const approvalToken = quote?.needsPermit2Approval[0] ?? null;
  useEffect(() => {
    if (!approvalToken || !address || !publicClient) {
      setNativeBal(null);
      setGasWaitSince(null);
      return;
    }
    setGasWaitSince((v) => v ?? Date.now());
    let stop = false;
    const tick = async () => {
      try {
        const bal = await publicClient.getBalance({ address });
        if (!stop) setNativeBal(bal);
        if (approving) {
          const a = await publicClient.readContract({ address: approving, abi: erc20Abi, functionName: "allowance", args: [address, quote!.permit2] });
          const need = BigInt(quote!.toSign.find((e) => e.token === approving)?.amountIn ?? "0");
          if (!stop && a >= need) {
            setApproving(null);
            setQuote(null); // re-quote: the leg is now a gasless signature
          }
        }
      } catch {
        /* next tick */
      }
    };
    void tick();
    const id = setInterval(tick, 2000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [approvalToken, approving, address, publicClient, quote]);
  const lowGas = nativeBal !== null && nativeBal < GAS_FOR_APPROVAL_WEI;
  const gasMissing = lowGas && gasWaitSince !== null && now - gasWaitSince > GAS_WAIT_MS;

  async function approve(token: Address) {
    if (!quote || !address || !walletClient) return;
    setNotice(null);
    setBusy("approving");
    try {
      const feeCurrency = feeCurrencyFor([token]);
      await walletClient.sendTransaction({
        account: address,
        chain: celo,
        to: token,
        data: approveCalldata(quote.permit2, maxUint256, attributionSuffix(ATTRIBUTION_CODE)),
        ...(feeCurrency ? { feeCurrency } : {}),
      });
      setApproving(token);
    } catch (e) {
      setNotice(isRejection(e) ? "rejected" : "generic_error");
    } finally {
      setBusy(null);
    }
  }

  async function pay() {
    if (!quote || !address) return;
    setNotice(null);
    if (quote.toSign.some((e) => e.kind === "ALLOWANCE")) return selfPay(quote);
    const signatures: Hex[] = [];
    setBusy("signing");
    try {
      for (const entry of quote.toSign) {
        if (!entry.typedData) throw new Error("allowance leg");
        const td = hydrateTypedData(entry.typedData);
        signatures.push(await signTypedData.mutateAsync({ account: address, ...td } as Parameters<typeof signTypedData.mutateAsync>[0]));
      }
      setBusy("submitting");
      const res = await fetch(`/api/invoices/${invoice.id}/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ quoteId: quote.quoteId, signatures }),
      });
      const body = res.ok ? {} : ((await res.json().catch(() => ({}))) as { error?: string });
      // Only "already submitted" means a payment is in flight; any other 409/429 is a "try again", not a dead end.
      if (res.ok || (res.status === 409 && (body as { error?: string }).error === "already_submitted")) {
        setStatus("submitted");
      } else {
        setNotice(errorKey((body as { error?: string }).error));
        setQuote(null);
      }
    } catch (e) {
      setNotice(isRejection(e) ? "rejected" : "generic_error");
    } finally {
      setBusy(null);
    }
  }

  /** ALLOWANCE legs (rare fallback): approve(router) + pay() sent by the payer, ERC-8021 tagged. */
  async function selfPay(q: QuoteOk) {
    if (!address || !walletClient || !publicClient) return;
    setBusy("sending");
    try {
      const legs = allowanceLegs(q.plan.legs);
      const current: Record<string, bigint> = {};
      for (const l of legs) {
        current[l.token] = await publicClient.readContract({ address: l.token, abi: erc20Abi, functionName: "allowance", args: [address, q.router] });
      }
      const txs = allowancePlan({ invoice: invoiceFromWire(q.invoice), payer: address, router: q.router, legs, currentAllowances: current, attributionCode: ATTRIBUTION_CODE });
      const feeCurrency = feeCurrencyFor(legs.map((l) => l.token));
      for (const tx of txs) {
        const hash = await walletClient.sendTransaction({ account: address, chain: celo, to: tx.to, data: tx.data, ...(feeCurrency ? { feeCurrency } : {}) });
        const r = await publicClient.waitForTransactionReceipt({ hash });
        if (r.status !== "success") throw new Error("reverted");
        setTxHash(hash);
      }
      setStatus("submitted");
    } catch (e) {
      setNotice(isRejection(e) ? "rejected" : "generic_error");
    } finally {
      setBusy(null);
    }
  }

  const r = RECEIPT[lang];
  const amountIn = quote?.toSign.map((e) => `${formatUnits(BigInt(e.amountIn), e.decimals, locale, 2)} ${e.symbol}`).join(" + ");
  const symbolOf = (token: Address) => quote?.toSign.find((e) => e.token === token)?.symbol ?? "";
  const fiatLabel = invoice.currency === "BRL" ? DICTS.pt.pay_fiat : lang === "en" ? t.pay_fiat : DICTS.es.pay_fiat;

  // The single action of the screen, derived from the state.
  function renderAction() {
    const wait = (label: string) => (
      <button type="button" className="btn primary" disabled>
        <span className="spin" aria-hidden /> {label}
      </button>
    );
    if (!isConnected) {
      return (
        <div className="stack">
          {connectors.map((c, i) => (
            <button key={c.uid} type="button" className={`btn ${i === 0 ? "primary" : ""}`} disabled={connect.isPending} onClick={() => connect.mutate({ connector: c, chainId: celo.id })}>
              {i === 0 ? t.connect : c.type === "walletConnect" ? t.connect_wc : c.name}
            </button>
          ))}
          {connectors.length === 0 && <p className="note">{t.no_wallet}</p>}
        </div>
      );
    }
    if (!onCelo) return <button type="button" className="btn primary" onClick={() => switchChain.mutate({ chainId: celo.id })}>{t.switch_network}</button>;
    if (inFlight || busy === "submitting") return wait(t.paying);
    if (busy === "signing" || busy === "approving" || busy === "sending") return wait(t.confirm_wallet);
    if (quoteErr) {
      return (
        <div className="stack">
          {quoteErr.rampUrl ? (
            <a className="btn primary" href={quoteErr.rampUrl} target="_blank" rel="noopener noreferrer">{fiatLabel}</a>
          ) : null}
          <button type="button" className={`btn ${quoteErr.rampUrl ? "" : "primary"}`} onClick={getQuote}>{t.retry}</button>
          <p className="note">{t[errorKey(quoteErr.error)]}</p>
        </div>
      );
    }
    if (!quote) return wait("");
    if (approvalToken) {
      if (approving) return wait(tr(t, "approve", { token: symbolOf(approvalToken) }));
      if (lowGas && !gasMissing) return wait(t.preparing);
      return (
        <div className="stack">
          <button type="button" className="btn primary" onClick={() => approve(approvalToken)}>{tr(t, "approve", { token: symbolOf(approvalToken) })}</button>
          {gasMissing && <p className="note">{t.gas_missing}</p>}
        </div>
      );
    }
    return <button type="button" className="btn primary" onClick={pay}>{tr(t, "pay_with", { amount: amountIn ?? "" })}</button>;
  }

  if (paid) {
    return (
      <main className="wrap center">
        <div className="check" aria-hidden>✓</div>
        <h1 className="title">{t.paid}</h1>
        <p className="amount">{formatDecimal(invoice.amountLocal, locale)} <span className="ccy">{invoice.currency}</span></p>
        <p className="label">{fiatName(invoice.currency, lang)}</p>
        <p className="sub">{invoice.merchantName}</p>
        {txHash && <a className="sub" href={explorerTx(txHash)} target="_blank" rel="noopener noreferrer">Celoscan ↗</a>}
      </main>
    );
  }

  const mm = String(Math.floor(remainingS / 60)).padStart(2, "0");
  const ss = String(remainingS % 60).padStart(2, "0");
  return (
    <main className="wrap">
      <header className="top">
        <span className="sub">{invoice.merchantName}</span>
        {!closed && <span className={`sub tabular ${remainingS < 60 ? "warn" : ""}`}>{mm}:{ss}</span>}
      </header>

      <section className="hero ticket">
        <p className="amount">{formatDecimal(invoice.amountLocal, locale)} <span className="ccy">{invoice.currency}</span></p>
        <p className="label">{fiatName(invoice.currency, lang)}</p>
        {invoice.description && <p className="sub">{invoice.description}</p>}
        <hr className="rule" />
        <dl className="receipt">
          <div>
            <dt>{r.merchant_gets}</dt>
            <dd>
              {formatUnits(BigInt(invoice.amountOut), invoice.tokenOutDecimals, locale, 2)} {invoice.tokenOutSymbol}
              <small>{tokenName(invoice.tokenOutSymbol, lang)}</small>
            </dd>
          </div>
          <div className="receipt-total">
            <dt>{r.you_pay}</dt>
            <dd>
              {quote && amountIn ? amountIn : "—"}
              <small>{quote ? legsName(quote.toSign.map((e) => e.symbol), lang) : r.you_pay_hint}</small>
            </dd>
          </div>
        </dl>
        <a className="sub mono" href={explorerAddress(invoice.payoutAddress)} target="_blank" rel="noopener noreferrer">→ {short(invoice.payoutAddress)}</a>
      </section>

      {closed ? <p className="note center-text">{status === "expired" || remainingS <= 0 ? t.expired : t.not_open}</p> : renderAction()}
      {notice && !closed && <p className="note err-text">{t[notice]}</p>}

      <footer className="foot">
        {isConnected && address && (
          <button type="button" className="linkish" onClick={() => disconnect()}>{short(address)} · {t.disconnect}</button>
        )}
        <LangSwitch lang={lang} />
      </footer>
    </main>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { erc20Abi, maxUint256, type Address, type Hex } from "viem";
import { celo } from "viem/chains";
import {
  useConnect,
  useConnection,
  useConnectors,
  useDisconnect,
  usePublicClient,
  useSignTypedData,
  useSwitchChain,
  useWalletClient,
} from "wagmi";
import { CELO, HACKATHON_ATTRIBUTION_CODE, explorerAddress, explorerTx, type Language } from "@cobra/shared";
import { allowanceLegs, allowancePlan, approveCalldata, attributionSuffix, feeCurrencyFor, invoiceFromWire } from "../lib/allowance";
import { formatDecimal, formatUnits } from "../lib/amount";
import { DICTS, localeFor, tr, type Dict } from "../lib/i18n";
import { hydrateTypedData, type PublicInvoice, type QuoteError, type QuoteOk, type StatusResponse } from "../lib/wire";
import { LangSwitch } from "./lang-switch";

type Phase = "idle" | "quoting" | "quoted" | "signing" | "submitting" | "waiting" | "self_paying" | "paid";

const ATTRIBUTION_CODE = process.env.NEXT_PUBLIC_ATTRIBUTION_CODE || HACKATHON_ATTRIBUTION_CODE;
/** Native balance that covers one ERC-20 approval even at a 2x base fee (~55k gas × ~400 gwei). */
const GAS_FOR_APPROVAL_WEI = 25_000_000_000_000_000n; // 0.025 CELO
const TERMINAL = new Set(["paid", "expired", "cancelled"]);

function short(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function errorKey(code: string | undefined): keyof Dict {
  switch (code) {
    case "quote_expired":
      return "quote_expired";
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
    case "temporarily_unavailable":
    case "upstream_unavailable":
    case "solver_unavailable":
    case "not_configured":
      return "temporarily_unavailable";
    default:
      return "generic_error";
  }
}

function isUserRejection(e: unknown): boolean {
  const s = String((e as { name?: string; shortMessage?: string; message?: string })?.name ?? "") + String((e as { message?: string })?.message ?? "");
  return /UserRejected|rejected|denied|cancel/i.test(s);
}

export function PayPage({ invoice, lang, host }: { invoice: PublicInvoice; lang: Language; host: string }) {
  const t = DICTS[lang];
  const locale = localeFor(lang, invoice.currency);
  const now = useNow(1000);
  const deadline = Date.parse(invoice.expiresAt);
  const remainingS = Math.max(0, Math.floor((deadline - now) / 1000));

  const [status, setStatus] = useState(invoice.status);
  const [phase, setPhase] = useState<Phase>(invoice.status === "paid" ? "paid" : "idle");
  const [quote, setQuote] = useState<QuoteOk | null>(null);
  const [quoteErr, setQuoteErr] = useState<QuoteError | null>(null);
  const [error, setError] = useState<keyof Dict | null>(null);
  const [step, setStep] = useState(0);
  const [txHash, setTxHash] = useState<Hex | null>(null);
  const [showFull, setShowFull] = useState(false);
  const [copied, setCopied] = useState(false);

  const { address, isConnected, chainId } = useConnection();
  const connectors = useConnectors();
  const connect = useConnect();
  const { mutate: disconnect } = useDisconnect();
  const switchChain = useSwitchChain();
  const signTypedData = useSignTypedData();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();

  // Gas for the one-time Permit2 approval of a wFIAT (no EIP-3009). A payer with no CELO gets a small grant from the
  // agent (worker, after this quote): poll the native balance until it can pay the approval, give up after 90 s.
  const [nativeBal, setNativeBal] = useState<bigint | null>(null);
  const [gasWaitSince, setGasWaitSince] = useState<number | null>(null);
  const needsApproval = (quote?.needsPermit2Approval.length ?? 0) > 0;
  useEffect(() => {
    if (!needsApproval || !address || !publicClient) {
      setNativeBal(null);
      setGasWaitSince(null);
      return;
    }
    let stop = false;
    const poll = async () => {
      try {
        const b = await publicClient.getBalance({ address });
        if (!stop) setNativeBal(b);
      } catch {
        /* keep the last value */
      }
    };
    void poll();
    setGasWaitSince((v) => v ?? Date.now());
    const id = setInterval(poll, 3000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [needsApproval, address, publicClient]);
  const lowGas = nativeBal !== null && nativeBal < GAS_FOR_APPROVAL_WEI;
  const gasGaveUp = lowGas && gasWaitSince !== null && now - gasWaitSince > 90_000;

  const expired = remainingS <= 0 && status !== "paid";
  const closed = TERMINAL.has(status) || expired;

  // MiniPay injects window.ethereum and expects the dapp to connect without a button.
  useEffect(() => {
    const eth = (globalThis as { ethereum?: { isMiniPay?: boolean } }).ethereum;
    const inj = connectors.find((c) => c.type === "injected");
    if (eth?.isMiniPay && !isConnected && inj) connect.mutate({ connector: inj });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectors, isConnected]);

  // Status polling: once on load, then while a payment is in flight.
  const pollStatus = useCallback(async () => {
    const res = await fetch(`/api/invoices/${invoice.id}/status`, { cache: "no-store" });
    if (!res.ok) return null;
    const s = (await res.json()) as StatusResponse;
    setStatus(s.status);
    if (s.txHash) setTxHash(s.txHash);
    if (s.status === "paid") setPhase("paid");
    return s;
  }, [invoice.id]);

  useEffect(() => {
    void pollStatus();
  }, [pollStatus]);

  useEffect(() => {
    if (phase !== "waiting") return;
    const id = setInterval(async () => {
      const s = await pollStatus();
      if (s?.submission?.status === "failed" && s.status === "open") {
        setPhase("idle");
        setQuote(null);
        setError("generic_error");
      }
    }, 2500);
    return () => clearInterval(id);
  }, [phase, pollStatus]);

  const wrongChain = isConnected && chainId !== celo.id;

  async function getQuote() {
    if (!address) return;
    setError(null);
    setQuoteErr(null);
    setPhase("quoting");
    try {
      const res = await fetch(`/api/invoices/${invoice.id}/quote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payer: address }),
      });
      const body = (await res.json()) as QuoteOk & QuoteError;
      if (res.ok) {
        setQuote(body);
        setPhase("quoted");
      } else {
        setQuoteErr(body);
        setError(errorKey(body.error));
        setPhase("idle");
      }
    } catch {
      setError("generic_error");
      setPhase("idle");
    }
  }

  async function signAndSubmit() {
    if (!quote || !address) return;
    if (Date.parse(quote.quoteExpiresAt) <= Date.now()) {
      setError("quote_expired");
      setQuote(null);
      setPhase("idle");
      return;
    }
    setError(null);
    setPhase("signing");
    const signatures: Hex[] = [];
    try {
      for (const [i, entry] of quote.toSign.entries()) {
        setStep(i + 1);
        if (!entry.typedData) throw new Error("allowance leg");
        const td = hydrateTypedData(entry.typedData);
        signatures.push(await signTypedData.mutateAsync({ account: address, ...td } as Parameters<typeof signTypedData.mutateAsync>[0]));
      }
    } catch (e) {
      setError(isUserRejection(e) ? "rejected" : "generic_error");
      setPhase("quoted");
      return;
    }
    setPhase("submitting");
    try {
      const res = await fetch(`/api/invoices/${invoice.id}/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ quoteId: quote.quoteId, signatures }),
      });
      if (res.ok || res.status === 409) {
        setPhase("waiting");
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(errorKey(body.error));
      setQuote(null);
      setPhase("idle");
    } catch {
      setError("generic_error");
      setPhase("quoted");
    }
  }

  /** ALLOWANCE mode: approve(router) + pay() sent by the payer, ERC-8021 tagged, gas via fee-currency adapter. */
  async function selfPay() {
    if (!quote || !address || !walletClient || !publicClient) return;
    setError(null);
    setPhase("self_paying");
    try {
      const inv = invoiceFromWire(quote.invoice);
      const legs = allowanceLegs(quote.plan.legs);
      const current: Record<string, bigint> = {};
      for (const l of legs) {
        current[l.token] = await publicClient.readContract({ address: l.token, abi: erc20Abi, functionName: "allowance", args: [address, quote.router] });
      }
      const txs = allowancePlan({ invoice: inv, payer: address, router: quote.router, legs, currentAllowances: current, attributionCode: ATTRIBUTION_CODE });
      const feeCurrency = feeCurrencyFor(legs.map((l) => l.token));
      let last: Hex | null = null;
      for (const tx of txs) {
        last = await walletClient.sendTransaction({ account: address, chain: celo, to: tx.to, data: tx.data, ...(feeCurrency ? { feeCurrency } : {}) });
        const receipt = await publicClient.waitForTransactionReceipt({ hash: last });
        if (receipt.status !== "success") throw new Error("tx reverted");
      }
      setTxHash(last);
      setPhase("waiting");
    } catch (e) {
      setError(isUserRejection(e) ? "rejected" : "generic_error");
      setPhase("quoted");
    }
  }

  async function approvePermit2(token: Address) {
    if (!quote || !address || !walletClient || !publicClient) return;
    setError(null);
    try {
      const feeCurrency = feeCurrencyFor([token]);
      const hash = await walletClient.sendTransaction({
        account: address,
        chain: celo,
        to: token,
        data: approveCalldata(quote.permit2, maxUint256, attributionSuffix(ATTRIBUTION_CODE)),
        ...(feeCurrency ? { feeCurrency } : {}),
      });
      await publicClient.waitForTransactionReceipt({ hash });
      await getQuote();
    } catch (e) {
      setError(isUserRejection(e) ? "rejected" : "generic_error");
    }
  }

  const planView = useMemo(() => {
    if (!quote) return null;
    const { costBps, savingsBps } = quote.plan;
    const pct = (bps: number) => `${(bps / 100).toLocaleString(locale, { maximumFractionDigits: 2 })} %`;
    return {
      legs: quote.toSign.map((e) => {
        const amount = BigInt(e.amountIn);
        const fee = costBps > 0 ? (amount * BigInt(costBps)) / BigInt(10_000 + costBps) : 0n;
        return {
          key: e.index,
          label: `${formatUnits(amount, e.decimals, locale, 2)} ${e.symbol}`,
          fee: `${formatUnits(fee, e.decimals, locale, 2)} ${e.symbol}`,
        };
      }),
      cost: pct(costBps),
      savings: savingsBps > 0 ? pct(savingsBps) : null,
      hasAllowanceLeg: quote.toSign.some((e) => e.kind === "ALLOWANCE"),
    };
  }, [quote, locale]);

  const mm = String(Math.floor(remainingS / 60)).padStart(2, "0");
  const ss = String(remainingS % 60).padStart(2, "0");
  const busy = phase === "quoting" || phase === "signing" || phase === "submitting" || phase === "self_paying";

  return (
    <main className="wrap">
      <div className="topbar">
        <span className="brand">Cobrá</span>
        <LangSwitch lang={lang} />
      </div>

      {/* Phishing-resistant header: who gets paid, how much, to which address, on which domain. */}
      <section className="card header" aria-labelledby="merchant">
        <p className="muted small">{t.merchant}</p>
        <h1 id="merchant" className="merchant">{invoice.merchantName}</h1>
        <p className="amount" aria-label={t.amount}>
          {formatDecimal(invoice.amountLocal, locale)} <span className="ccy">{invoice.currency}</span>
        </p>
        {invoice.reference && <p className="muted small">{t.reference} {invoice.reference}{invoice.description ? ` · ${invoice.description}` : ""}</p>}
        <p className="small">
          {t.pays_to}{" "}
          <button type="button" className="linkish mono" onClick={() => setShowFull((v) => !v)} aria-expanded={showFull}>
            {showFull ? invoice.payoutAddress : short(invoice.payoutAddress)}
          </button>{" "}
          <a className="small" href={explorerAddress(invoice.payoutAddress)} target="_blank" rel="noopener noreferrer">↗</a>
        </p>
        <p className="small muted">
          {formatUnits(invoice.amountOut, invoice.tokenOutDecimals, locale, 2)} {invoice.tokenOutSymbol} · Celo
        </p>
        <p className="small domain">
          🔒 {t.domain_check} <strong>{host}</strong>
        </p>
        {!closed && phase !== "paid" && (
          <p className={`countdown ${remainingS < 60 ? "warn" : ""}`} aria-live="polite">
            {t.expires_in} {mm}:{ss}
          </p>
        )}
      </section>

      {phase === "paid" || status === "paid" ? (
        <section className="card ok" aria-live="polite">
          <h2>✓ {t.paid}</h2>
          <p>{t.receipt}: {formatDecimal(invoice.amountLocal, locale)} {invoice.currency} → {invoice.merchantName}</p>
          {txHash && (
            <p>
              <a href={explorerTx(txHash)} target="_blank" rel="noopener noreferrer">{t.view_explorer}</a>
              <br />
              <span className="mono small">{short(txHash)}</span>
            </p>
          )}
        </section>
      ) : closed ? (
        <section className="card err" role="alert">
          <p>{expired || status === "expired" ? t.expired : t.not_open}</p>
        </section>
      ) : (
        <>
          <section className="card">
            {!isConnected ? (
              <div className="stack">
                <h2>{t.connect}</h2>
                {connectors.length === 0 && <p className="muted">{t.no_wallet}</p>}
                {connectors.map((c) => (
                  <button key={c.uid} type="button" className="btn" disabled={connect.isPending} onClick={() => connect.mutate({ connector: c, chainId: celo.id })}>
                    {c.type === "injected" ? (c.name && c.name !== "Injected" ? c.name : t.connect_injected) : c.type === "walletConnect" ? t.connect_wc : c.name}
                  </button>
                ))}
                {connect.error && <p className="error small">{isUserRejection(connect.error) ? t.rejected : t.no_wallet}</p>}
              </div>
            ) : (
              <div className="row">
                <span className="small">{t.connected_as} <span className="mono">{short(address!)}</span></span>
                <button type="button" className="linkish small" onClick={() => { disconnect(); setQuote(null); setPhase("idle"); }}>{t.disconnect}</button>
              </div>
            )}
            {wrongChain && (
              <div className="stack">
                <p className="error small">{t.wrong_network}</p>
                <button type="button" className="btn" onClick={() => switchChain.mutate({ chainId: celo.id })}>{t.switch_network}</button>
              </div>
            )}
          </section>

          {isConnected && !wrongChain && (
            <section className="card stack" aria-live="polite">
              {!quote && (
                <button type="button" className="btn primary" disabled={busy} onClick={getQuote}>
                  {phase === "quoting" ? t.quoting : t.get_quote}
                </button>
              )}

              {quote && planView && (
                <>
                  <h2>{t.plan_title}</h2>
                  <ul className="legs">
                    {planView.legs.map((l) => (
                      <li key={l.key}>
                        <strong>{l.label}</strong> <span className="muted small">({t.fee} ≈ {l.fee})</span>
                      </li>
                    ))}
                  </ul>
                  <p className="small">{t.cost}: {planView.cost}{planView.savings && <> · <span className="good">{t.savings}: {planView.savings}</span></>}</p>
                  {!planView.hasAllowanceLeg && !needsApproval && <p className="small muted">{t.no_gas}</p>}

                  {needsApproval && lowGas && <p className="small muted">{gasGaveUp ? t.gas_missing : `⏳ ${t.gas_incoming}`}</p>}
                  {quote.needsPermit2Approval.map((tok) => (
                    <button key={tok} type="button" className="btn" disabled={busy || (lowGas && !gasGaveUp)} onClick={() => approvePermit2(tok)}>
                      {tr(t, "approve_permit2", { token: quote.toSign.find((e) => e.token === tok)?.symbol ?? "" })}
                    </button>
                  ))}

                  {!planView.hasAllowanceLeg && quote.needsPermit2Approval.length === 0 && (
                    <button type="button" className="btn primary" disabled={busy} onClick={signAndSubmit}>
                      {phase === "signing"
                        ? `${t.signing} (${tr(t, "sign_step", { i: step, n: quote.toSign.length })})`
                        : phase === "submitting"
                          ? t.submitting
                          : t.sign}
                    </button>
                  )}
                  <details className="small" open={planView.hasAllowanceLeg}>
                    <summary>{t.self_pay}</summary>
                    <p className="muted">{t.self_pay_hint}</p>
                    <button type="button" className="btn" disabled={busy || !walletClient} onClick={selfPay}>
                      {phase === "self_paying" ? t.sending_tx : t.self_pay}
                    </button>
                  </details>
                  <button type="button" className="linkish small" disabled={busy} onClick={getQuote}>{t.requote}</button>
                </>
              )}

              {phase === "waiting" && (
                <p className="small">
                  ⏳ {t.waiting_tx}
                  {txHash && (
                    <>
                      {" "}
                      <a href={explorerTx(txHash)} target="_blank" rel="noopener noreferrer">{t.view_explorer}</a>
                    </>
                  )}
                </p>
              )}
            </section>
          )}

          {error && (
            <section className="card err stack" role="alert">
              <p>{t[error]}</p>
              {quoteErr?.rampUrl && (
                <a className="btn primary" href={quoteErr.rampUrl} target="_blank" rel="noopener noreferrer">
                  {invoice.currency === "BRL" ? DICTS.pt.pay_fiat : lang === "en" ? t.pay_fiat : DICTS.es.pay_fiat}
                </a>
              )}
              {quoteErr?.rampUrl && (
                <div className="small">
                  <p className="muted">{t.ramp_steps.replace("{token}", quoteErr.directTransfer?.symbol ?? "")}</p>
                  {quoteErr.directTransfer && (
                    <p>
                      <strong>
                        {formatUnits(quoteErr.directTransfer.amount, quoteErr.directTransfer.decimals, locale, 18)} {quoteErr.directTransfer.symbol}
                      </strong>{" "}
                      · Celo
                    </p>
                  )}
                  {address && <p className="mono break">{address}</p>}
                </div>
              )}
              {quoteErr?.directTransfer && (
                <div className="small">
                  <p className="muted">{t.direct_transfer}</p>
                  <p>
                    <strong>
                      {formatUnits(quoteErr.directTransfer.amount, quoteErr.directTransfer.decimals, locale, 18)} {quoteErr.directTransfer.symbol}
                    </strong>
                  </p>
                  <p className="mono break">{quoteErr.directTransfer.address}</p>
                  <button
                    type="button"
                    className="linkish"
                    onClick={async () => {
                      await navigator.clipboard?.writeText(quoteErr.directTransfer!.address);
                      setCopied(true);
                    }}
                  >
                    {copied ? t.copied : t.copy}
                  </button>
                </div>
              )}
              {!busy && isConnected && (
                <button type="button" className="btn" onClick={getQuote}>{t.retry}</button>
              )}
            </section>
          )}
        </>
      )}
      <footer className="muted small foot">Celo · {CELO.chainId}</footer>
    </main>
  );
}

"use client";

/** Wallet-ownership proof: connect, sign one plain-text message. Never sends a transaction. */
import { useState } from "react";
import { useConnect, useConnection, useConnectors, useDisconnect, useSignMessage } from "wagmi";
import { celo } from "wagmi/chains";
import type { Language } from "@cobra/shared";
import { DICTS } from "../lib/i18n";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function VerifyView({ slug, payoutAddress, alreadyVerified, lang }: { slug: string; payoutAddress: string; alreadyVerified: boolean; lang: Language }) {
  const t = DICTS[lang];
  const { address, isConnected } = useConnection();
  const connectors = useConnectors();
  const connect = useConnect();
  const { mutate: disconnect } = useDisconnect();
  const { mutateAsync: signMessage } = useSignMessage();
  const [state, setState] = useState<"idle" | "signing" | "done">(alreadyVerified ? "done" : "idle");
  const [error, setError] = useState<string | null>(null);

  const wrongWallet = isConnected && !!address && address.toLowerCase() !== payoutAddress.toLowerCase();

  async function sign() {
    setError(null);
    setState("signing");
    try {
      const res = await fetch(`/api/m/${encodeURIComponent(slug)}/verify`, { cache: "no-store" });
      const issued = (await res.json()) as { nonce?: string; message?: string };
      if (!res.ok || !issued.nonce || !issued.message) throw new Error("nonce");
      const signature = await signMessage({ message: issued.message });
      const out = await fetch(`/api/m/${encodeURIComponent(slug)}/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nonce: issued.nonce, signature }),
      });
      if (out.ok) {
        setState("done");
        return;
      }
      const body = (await out.json().catch(() => ({}))) as { error?: string };
      setError(body.error === "nonce_invalid" ? t.verify_nonce_expired : t.verify_failed);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      setError(/reject|denied|cancel/i.test(msg) ? t.rejected : t.verify_failed);
    }
    setState("idle");
  }

  return (
    <div className="stack">
      <h1 className="title">{t.verify_title}</h1>
      <p className="note">{t.verify_intro}</p>
      <div className="card">
        <p className="small muted">{t.verify_payout}</p>
        <p className="mono small break">{payoutAddress}</p>
      </div>

      {state === "done" ? (
        <p className="note" role="status">{t.verify_ok}</p>
      ) : !isConnected ? (
        <div className="stack">
          {connectors.map((c, i) => (
            <button key={c.uid} type="button" className={`btn ${i === 0 ? "primary" : ""}`} disabled={connect.isPending} onClick={() => connect.mutate({ connector: c, chainId: celo.id })}>
              {i === 0 ? t.connect : c.type === "walletConnect" ? t.connect_wc : c.name}
            </button>
          ))}
          {connectors.length === 0 && <p className="note">{t.no_wallet}</p>}
        </div>
      ) : (
        <div className="stack">
          {wrongWallet && <p className="note err-text" role="alert">{t.verify_wrong_wallet}</p>}
          <button type="button" className="btn primary" disabled={wrongWallet || state === "signing"} onClick={sign}>
            {state === "signing" ? t.verify_signing : t.verify_sign}
          </button>
          <button type="button" className="linkish small" onClick={() => disconnect()}>
            {short(address ?? "")} · {t.disconnect}
          </button>
        </div>
      )}
      {error && <p className="note err-text" role="alert">{error}</p>}
    </div>
  );
}

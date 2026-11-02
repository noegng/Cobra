"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Language } from "@cobra/shared";
import { parseLocalAmount } from "../lib/amount";
import { DICTS } from "../lib/i18n";

export function StaticAmountForm({ slug, currency, lang }: { slug: string; currency: string; lang: Language }) {
  const t = DICTS[lang];
  const router = useRouter();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = parseLocalAmount(value);
    if (!parsed.ok) {
      setError(t.invalid_amount);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/m/${encodeURIComponent(slug)}/invoice`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amountLocal: parsed.value }),
      });
      const body = (await res.json()) as { id?: string; error?: string };
      if (res.ok && body.id) {
        router.push(`/pay/${body.id}`);
        return;
      }
      setError(body.error === "invalid_amount" ? t.invalid_amount : t.generic_error);
    } catch {
      setError(t.generic_error);
    }
    setBusy(false);
  }

  return (
    <form className="stack" onSubmit={submit} noValidate>
      <label htmlFor="amount">{t.enter_amount}</label>
      <div className="row">
        <input
          id="amount"
          className="amount-input"
          inputMode="decimal"
          autoComplete="off"
          autoFocus
          placeholder="0"
          value={value}
          maxLength={16}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "amount-err" : undefined}
          onChange={(e) => setValue(e.target.value.replace(/[^\d.,]/g, ""))}
        />
        <span className="ccy">{currency}</span>
      </div>
      {error && <p id="amount-err" className="error small" role="alert">{error}</p>}
      <button type="submit" className="btn primary" disabled={busy || value === ""}>
        {t.continue}
      </button>
    </form>
  );
}

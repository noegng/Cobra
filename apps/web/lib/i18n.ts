/** Tiny i18n: es / pt / en dictionaries, Accept-Language negotiation, `lang` cookie override. */
import type { Language } from "@cobra/shared";

export const LANGS: readonly Language[] = ["es", "pt", "en"];
export const LANG_COOKIE = "lang";

const es = {
  merchant: "Comercio",
  amount: "Monto",
  expired: "Este cobro venció. Pedile al comercio uno nuevo.",
  not_open: "Este cobro ya no está disponible.",
  connect: "Conectar billetera",
  connect_wc: "WalletConnect",
  no_wallet: "No se detectó billetera. Abrí este enlace desde MiniPay, Valora o MetaMask, o usá WalletConnect.",
  disconnect: "Desconectar",
  switch_network: "Cambiar a Celo",
  quoting: "Buscando la mejor ruta…",
  savings: "Ahorro vs ruta directa",
  signing: "Esperando tu firma en la billetera…",
  submitting: "Enviando…",
  paid: "¡Pagado!",
  retry: "Reintentar",
  quote_expired: "La cotización venció. Recalculá para seguir.",
  insufficient: "No tenés saldo suficiente en Celo para este pago.",
  no_route: "No encontramos una ruta de pago con tus saldos.",
  over_cap: "El monto supera el límite por pago.",
  generic_error: "Algo salió mal. Probá de nuevo.",
  temporarily_unavailable: "Servicio momentáneamente no disponible. Reintentá en unos segundos.",
  rejected: "Firma cancelada.",
  pay_fiat: "Pagar en pesos",
  approve: "Autorizar {token}",
  gas_missing: "Falta un poco de CELO para el gas.",
  enter_amount: "Ingresá el monto",
  continue: "Continuar",
  invalid_amount: "Monto inválido. Usá solo números, por ejemplo 4500 o 4500,50.",
  dashboard: "Panel del comercio",
  link_expired: "Este enlace venció o no es válido. Pedí uno nuevo al bot con /panel.",
  totals_today: "Cobrado hoy",
  totals_all: "Cobrado (total)",
  open_invoices: "Cobros abiertos",
  export_csv: "Exportar CSV",
  date: "Fecha",
  reference: "Ref.",
  status: "Estado",
  tx: "Tx",
  status_open: "abierto",
  status_submitted: "enviado",
  status_paid: "pagado",
  status_expired: "vencido",
  status_cancelled: "cancelado",
  language: "Idioma",
  proof_title: "Prueba on-chain",
  proof_payments: "Pagos confirmados",
  proof_payers: "Pagadores distintos",
  proof_merchants: "Comercios",
  proof_savings: "Ahorro promedio vs ruta directa",
  proof_volume: "Volumen por token",
  proof_recent: "Pagos recientes",
  proof_empty: "Aún no hay pagos confirmados.",
  proof_agent: "Agente y contratos",
  proof_agent_wallet: "Billetera del agente",
  proof_router: "Router",
  proof_identity: "Identidad ERC-8004 (8004scan)",
  proof_unset: "no configurado",
  proof_payer: "Pagador",
  proof_view_tx: "Ver en Celoscan",
  pay_with: "Pagar {amount}",
  paying: "Pagando…",
  confirm_wallet: "Confirmá en tu billetera",
  preparing: "Preparando…",
} as const;

export type Dict = Record<keyof typeof es, string>;

const pt: Dict = {
  merchant: "Loja",
  amount: "Valor",
  expired: "Esta cobrança expirou. Peça uma nova à loja.",
  not_open: "Esta cobrança não está mais disponível.",
  connect: "Conectar carteira",
  connect_wc: "WalletConnect",
  no_wallet: "Nenhuma carteira detectada. Abra este link no MiniPay, Valora ou MetaMask, ou use o WalletConnect.",
  disconnect: "Desconectar",
  switch_network: "Mudar para Celo",
  quoting: "Buscando a melhor rota…",
  savings: "Economia vs rota direta",
  signing: "Aguardando sua assinatura na carteira…",
  submitting: "Enviando…",
  paid: "Pago!",
  retry: "Tentar de novo",
  quote_expired: "A cotação expirou. Recalcule para continuar.",
  insufficient: "Você não tem saldo suficiente na Celo para este pagamento.",
  no_route: "Não encontramos uma rota de pagamento com seus saldos.",
  over_cap: "O valor excede o limite por pagamento.",
  generic_error: "Algo deu errado. Tente de novo.",
  temporarily_unavailable: "Serviço temporariamente indisponível. Tente de novo em alguns segundos.",
  rejected: "Assinatura cancelada.",
  pay_fiat: "Pagar em reais",
  approve: "Autorizar {token}",
  gas_missing: "Falta um pouco de CELO para o gás.",
  enter_amount: "Digite o valor",
  continue: "Continuar",
  invalid_amount: "Valor inválido. Use só números, por exemplo 45 ou 45,90.",
  dashboard: "Painel da loja",
  link_expired: "Este link expirou ou é inválido. Peça um novo ao bot com /painel.",
  totals_today: "Recebido hoje",
  totals_all: "Recebido (total)",
  open_invoices: "Cobranças abertas",
  export_csv: "Exportar CSV",
  date: "Data",
  reference: "Ref.",
  status: "Status",
  tx: "Tx",
  status_open: "aberta",
  status_submitted: "enviada",
  status_paid: "paga",
  status_expired: "expirada",
  status_cancelled: "cancelada",
  language: "Idioma",
  proof_title: "Prova on-chain",
  proof_payments: "Pagamentos confirmados",
  proof_payers: "Pagadores distintos",
  proof_merchants: "Comerciantes",
  proof_savings: "Economia média vs rota direta",
  proof_volume: "Volume por token",
  proof_recent: "Pagamentos recentes",
  proof_empty: "Ainda não há pagamentos confirmados.",
  proof_agent: "Agente e contratos",
  proof_agent_wallet: "Carteira do agente",
  proof_router: "Router",
  proof_identity: "Identidade ERC-8004 (8004scan)",
  proof_unset: "não configurado",
  proof_payer: "Pagador",
  proof_view_tx: "Ver na Celoscan",
  pay_with: "Pagar {amount}",
  paying: "Pagando…",
  confirm_wallet: "Confirme na sua carteira",
  preparing: "Preparando…",
};

const en: Dict = {
  merchant: "Merchant",
  amount: "Amount",
  expired: "This payment request expired. Ask the merchant for a new one.",
  not_open: "This payment request is no longer available.",
  connect: "Connect wallet",
  connect_wc: "WalletConnect",
  no_wallet: "No wallet detected. Open this link in MiniPay, Valora or MetaMask, or use WalletConnect.",
  disconnect: "Disconnect",
  switch_network: "Switch to Celo",
  quoting: "Finding the best route…",
  savings: "Savings vs direct route",
  signing: "Waiting for your signature in the wallet…",
  submitting: "Submitting…",
  paid: "Paid!",
  retry: "Retry",
  quote_expired: "The quote expired. Re-quote to continue.",
  insufficient: "You don't have enough balance on Celo for this payment.",
  no_route: "We couldn't find a payment route with your balances.",
  over_cap: "The amount exceeds the per-payment limit.",
  generic_error: "Something went wrong. Please try again.",
  temporarily_unavailable: "Service temporarily unavailable. Retry in a few seconds.",
  rejected: "Signature cancelled.",
  pay_fiat: "Pay with local currency",
  approve: "Approve {token}",
  gas_missing: "You need a little CELO for gas.",
  enter_amount: "Enter the amount",
  continue: "Continue",
  invalid_amount: "Invalid amount. Use digits only, e.g. 4500 or 4500.50.",
  dashboard: "Merchant dashboard",
  link_expired: "This link expired or is invalid. Ask the bot for a new one.",
  totals_today: "Collected today",
  totals_all: "Collected (all time)",
  open_invoices: "Open requests",
  export_csv: "Export CSV",
  date: "Date",
  reference: "Ref.",
  status: "Status",
  tx: "Tx",
  status_open: "open",
  status_submitted: "submitted",
  status_paid: "paid",
  status_expired: "expired",
  status_cancelled: "cancelled",
  language: "Language",
  proof_title: "On-chain proof",
  proof_payments: "Confirmed payments",
  proof_payers: "Distinct payers",
  proof_merchants: "Merchants",
  proof_savings: "Average savings vs direct route",
  proof_volume: "Volume per token",
  proof_recent: "Recent payments",
  proof_empty: "No confirmed payments yet.",
  proof_agent: "Agent and contracts",
  proof_agent_wallet: "Agent wallet",
  proof_router: "Router",
  proof_identity: "ERC-8004 identity (8004scan)",
  proof_unset: "not configured",
  proof_payer: "Payer",
  proof_view_tx: "View on Celoscan",
  pay_with: "Pay {amount}",
  paying: "Paying…",
  confirm_wallet: "Confirm in your wallet",
  preparing: "Preparing…",
};

export const DICTS: Record<Language, Dict> = { es, pt, en };

export function isLang(v: unknown): v is Language {
  return v === "es" || v === "pt" || v === "en";
}

/** Cookie wins, then Accept-Language (q-weighted), then `fallback`. */
export function negotiateLanguage(acceptLanguage: string | null | undefined, cookie: string | null | undefined, fallback: Language = "es"): Language {
  if (isLang(cookie)) return cookie;
  if (acceptLanguage) {
    const prefs = acceptLanguage
      .split(",")
      .map((part) => {
        const [tag = "", ...params] = part.trim().split(";");
        const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
        return { tag: tag.toLowerCase(), q: q ? Number(q.slice(2)) : 1 };
      })
      .filter((p) => p.tag && Number.isFinite(p.q) && p.q > 0)
      .sort((a, b) => b.q - a.q);
    for (const p of prefs) {
      const base = p.tag.split("-")[0];
      if (isLang(base)) return base;
    }
  }
  return fallback;
}

export function localeFor(lang: Language, currency?: string): string {
  if (lang === "pt") return "pt-BR";
  if (lang === "en") return "en-US";
  return currency === "MXN" ? "es-MX" : currency === "COP" ? "es-CO" : currency === "CLP" ? "es-CL" : currency === "PEN" ? "es-PE" : "es-AR";
}

export function tr(dict: Dict, key: keyof Dict, vars: Record<string, string | number> = {}): string {
  return dict[key].replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));
}

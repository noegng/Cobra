/** Strings of the "Agent decisions" journal (kept apart from the shared dictionaries). */
import type { Language } from "@cobra/shared";

export interface JournalStrings {
  title: string;
  intro: string;
  empty: string;
  route: string;
  paid_out: string;
  signed: string;
  path: string;
  split: string; // {n}
  single: string;
  surplus: string;
  cost: string;
  savings: string;
  grant: string; // {amount} {to}
  grant_why: string;
  relayed_by: string;
  tag: string;
  self_submitted: string;
  daily: string;
  reminders: string;
  closes: string;
  failed: string;
  failed_note: string;
  json: string;
  invoice: string;
  surplus_real: string;
  refusals_title: string;
  refusals_note: string;
  refusals_none: string;
  /** Labels of the closed refusal codes (AGENT_EVENT_CODES). */
  refusal_codes: Record<string, string>;
}

export const JOURNAL: Record<Language, JournalStrings> = {
  es: {
    title: "Decisiones del agente",
    intro: "Cada decisión del agente, derivada de datos on-chain y de la cola de pagos. Sin descripciones ni datos personales.",
    empty: "Aún no hay decisiones registradas.",
    route: "Ruta elegida",
    paid_out: "Entregado al comercio",
    signed: "El pagador firmó",
    path: "Ruta",
    split: "Pago dividido en {n} tramos",
    single: "Un solo tramo",
    surplus: "Excedente cotizado (devuelto al pagador)",
    cost: "Costo total vs tasa de referencia",
    savings: "Ahorro vs ruta directa",
    grant: "Envió {amount} CELO a {to} para que pudiera aprobar Permit2",
    grant_why: "Subsidio de gas",
    relayed_by: "Transacción enviada por el agente",
    tag: "Etiqueta ERC-8021",
    self_submitted: "Enviada por el propio pagador",
    daily: "Por día",
    reminders: "recordatorios",
    closes: "cierres diarios",
    failed: "envíos rechazados o fallidos",
    failed_note: "Los motivos (límite de precio, topes, autopago) no se publican.",
    json: "Diario en JSON",
    invoice: "Cobro",
    surplus_real: "Excedente devuelto al pagador (real, on-chain)",
    refusals_title: "Rechazos del agente (últimos 14 días)",
    refusals_note: "Solo conteos por motivo: no se guarda ninguna dirección, monto ni identificador.",
    refusals_none: "Ningún rechazo registrado.",
    refusal_codes: { price_guard: "Precio fuera del límite de referencia", no_route: "Sin ruta de swap", cap_per_payment: "Tope por pago", cap_per_day: "Tope diario", cap_per_merchant_day: "Tope diario por comercio", cap_per_payer_day: "Tope diario por pagador", self_payment: "Autopago (pagador = comercio)", smart_account_unsupported: "Cuenta inteligente no compatible", payer_blocked: "Pagador bloqueado temporalmente", refused_other: "Otro rechazo de seguridad" },
  },
  pt: {
    title: "Decisões do agente",
    intro: "Cada decisão do agente, derivada de dados on-chain e da fila de pagamentos. Sem descrições nem dados pessoais.",
    empty: "Ainda não há decisões registradas.",
    route: "Rota escolhida",
    paid_out: "Entregue ao comerciante",
    signed: "O pagador assinou",
    path: "Rota",
    split: "Pagamento dividido em {n} partes",
    single: "Uma única parte",
    surplus: "Excedente cotado (devolvido ao pagador)",
    cost: "Custo total vs taxa de referência",
    savings: "Economia vs rota direta",
    grant: "Enviou {amount} CELO para {to} para que pudesse aprovar o Permit2",
    grant_why: "Auxílio de gás",
    relayed_by: "Transação enviada pelo agente",
    tag: "Tag ERC-8021",
    self_submitted: "Enviada pelo próprio pagador",
    daily: "Por dia",
    reminders: "lembretes",
    closes: "fechamentos diários",
    failed: "envios recusados ou falhos",
    failed_note: "Os motivos (limite de preço, tetos, autopagamento) não são publicados.",
    json: "Diário em JSON",
    invoice: "Cobrança",
    surplus_real: "Excedente devolvido ao pagador (real, on-chain)",
    refusals_title: "Recusas do agente (últimos 14 dias)",
    refusals_note: "Apenas contagens por motivo: nenhum endereço, valor ou identificador é guardado.",
    refusals_none: "Nenhuma recusa registrada.",
    refusal_codes: { price_guard: "Preço fora do limite de referência", no_route: "Sem rota de swap", cap_per_payment: "Limite por pagamento", cap_per_day: "Limite diário", cap_per_merchant_day: "Limite diário por lojista", cap_per_payer_day: "Limite diário por pagador", self_payment: "Autopagamento (pagador = lojista)", smart_account_unsupported: "Conta inteligente não suportada", payer_blocked: "Pagador bloqueado temporariamente", refused_other: "Outra recusa de segurança" },
  },
  en: {
    title: "Agent decisions",
    intro: "Every decision the agent made, derived from on-chain data and the payment queue. No descriptions, no personal data.",
    empty: "No decisions recorded yet.",
    route: "Route chosen",
    paid_out: "Delivered to the merchant",
    signed: "Payer signed",
    path: "Path",
    split: "Payment split in {n} legs",
    single: "Single leg",
    surplus: "Quoted surplus (refunded to the payer)",
    cost: "Total cost vs reference rate",
    savings: "Savings vs direct route",
    grant: "Sent {amount} CELO to {to} so they could approve Permit2",
    grant_why: "Gas grant",
    relayed_by: "Transaction sent by the agent",
    tag: "ERC-8021 tag",
    self_submitted: "Submitted by the payer",
    daily: "Per day",
    reminders: "reminders",
    closes: "daily closes",
    failed: "refused or failed submissions",
    failed_note: "Reasons (price guard, caps, self-payment) are not published.",
    json: "Journal as JSON",
    invoice: "Invoice",
    surplus_real: "Surplus refunded to the payer (actual, on-chain)",
    refusals_title: "Refusals by the agent (last 14 days)",
    refusals_note: "Counts by reason only: no address, amount or identifier is stored.",
    refusals_none: "No refusals recorded.",
    refusal_codes: { price_guard: "Price outside the reference guard", no_route: "No swap route", cap_per_payment: "Per-payment cap", cap_per_day: "Daily cap", cap_per_merchant_day: "Per-merchant daily cap", cap_per_payer_day: "Per-payer daily cap", self_payment: "Self-payment (payer = merchant)", smart_account_unsupported: "Smart account not supported", payer_blocked: "Payer temporarily blocked", refused_other: "Other safety refusal" },
  },
};

/** /demo strings (es / pt / en). Plain text. */
import type { Language } from "@cobra/shared";
import type { AmountError } from "@cobra/bot/amount";
import type { DemoCountry } from "./engine";

export interface DemoStrings {
  meta_title: string;
  meta_desc: string;
  banner: string;
  banner_link: string;
  title: string;
  sub: string;
  country: Record<DemoCountry, string>;
  tab_merchant: string;
  tab_payer: string;
  tab_agent: string;
  reset: string;
  real_bot: string;
  merchant_side: string;
  payer_side: string;
  agent_side: string;
  placeholder: string;
  send: string;
  chips: Record<DemoCountry, string[]>;
  /** `example` is the first chip of the selected country, `cur` its currency written out. */
  welcome: (cur: string, example: string) => string;
  help: (cur: string) => string;
  usage: (cur: string) => string;
  amount_error: (e: AmountError, input: string) => string;
  /** `usd`: dollar value at the illustrative rate, "2,73". */
  invoice_caption: (ref: string, amount: string, usd: string, desc: string) => string;
  charge_over: (amount: string, usd: string, max: number, cur: string) => string;
  charge_confirm: (amount: string, usd: string, desc: string) => string;
  btn_yes: string;
  btn_fix: string;
  charge_fix: (cur: string) => string;
  btn_share: string;
  btn_open_payer: string;
  cancel_ok: (ref: string) => string;
  cancel_none: string;
  status_paid: (ref: string, amount: string) => string;
  status_open: (ref: string, amount: string) => string;
  status_cancelled: (ref: string) => string;
  status_none: string;
  close: (total: string, count: number, open: number) => string;
  unknown: string;
  paid_notice: (ref: string, amount: string, token: string) => string;
  payer_empty: string;
  payer_connect: string;
  payer_wallet: (balance: string) => string;
  payer_pay: (usdt: string) => string;
  payer_note: string;
  payer_signing: string;
  payer_paying: string;
  payer_paid: string;
  payer_receipt: (merchant: string) => string;
  payer_sim_tx: string;
  payer_insufficient: string;
  payer_cancelled: string;
  payer_expires: string;
  payer_illustrative: string;
  agent_idle: string;
  agent_invoice: (ref: string) => string;
  agent_route: (route: string, cost: string) => string;
  agent_gas: string;
  agent_relay: string;
  agent_settle: (amount: string, token: string) => string;
  agent_notify: string;
  agent_footer: string;
  // Ramp countries (MX, CO): no conversion route on Celo, the payer buys the wFIAT through Ripio first.
  payer_wallet_ramp: (usdt: string, held: string, token: string) => string;
  payer_no_route: (token: string) => string;
  payer_ramp_btn: (amount: string, token: string) => string;
  payer_ramping: (rail: string) => string;
  payer_ramp_done: (amount: string, token: string) => string;
  payer_pay_token: (amount: string, token: string) => string;
  payer_ramp_note: string;
  agent_no_route: (token: string) => string;
  agent_ramp: (amount: string, token: string, rail: string) => string;
  agent_direct: (token: string) => string;
  agent_gas_grant: string;
}

const ERR_ES: Record<AmountError, string> = {
  empty: "Falta el monto.",
  invalid: "No entendí el monto",
  ambiguous: "Ese monto es ambiguo: ¿sin decimales (4.500) o con decimales (4,50)?",
  negative: "El monto debe ser positivo.",
  zero: "El monto debe ser mayor que cero.",
  too_many_decimals: "Máximo 2 decimales.",
  too_large: "Ese monto es demasiado grande.",
  foreign_currency: "Tus cobros son en tu moneda local. Si prefieres recibir dólares digitales, en Telegram usa /moneda.",
};
const ERR_PT: Record<AmountError, string> = {
  empty: "Falta o valor.",
  invalid: "Não entendi o valor",
  ambiguous: "Esse valor é ambíguo: sem centavos (4.500) ou com centavos (4,50)?",
  negative: "O valor deve ser positivo.",
  zero: "O valor deve ser maior que zero.",
  too_many_decimals: "No máximo 2 casas decimais.",
  too_large: "Esse valor é grande demais.",
  foreign_currency: "Suas cobranças são na sua moeda local. Se preferir receber dólares digitais, no Telegram use /moeda.",
};
const ERR_EN: Record<AmountError, string> = {
  empty: "The amount is missing.",
  invalid: "I didn't understand the amount",
  ambiguous: "That amount is ambiguous: no decimals (4,500) or with decimals (4.50)?",
  negative: "The amount must be positive.",
  zero: "The amount must be greater than zero.",
  too_many_decimals: "At most 2 decimals.",
  too_large: "That amount is too large.",
  foreign_currency: "Your requests are in your local currency. To get paid in digital dollars instead, use /currency on Telegram.",
};
const withInput = (map: Record<AmountError, string>) => (e: AmountError, input: string) =>
  e === "invalid" ? `${map.invalid} "${input}".` : map[e];

const es: DemoStrings = {
  meta_title: "Cobrá · Demo interactiva",
  meta_desc: "Prueba Cobrá en 30 segundos: el chat del comercio y el teléfono del cliente, lado a lado. Todo simulado.",
  banner: "DEMO · Todo es simulado: ninguna transacción, ningún dinero real.",
  banner_link: "Ver pagos reales en Celo",
  title: "Prueba Cobrá en 30 segundos",
  sub: "A la izquierda, el chat del comercio en Telegram. A la derecha, el teléfono del cliente. Escribe un cobro y págalo.",
  country: { AR: "Argentina · wARS", BR: "Brasil · wBRL", MX: "México · wMXN", CO: "Colombia · wCOP" },
  tab_merchant: "Comercio",
  tab_payer: "Cliente",
  tab_agent: "Agente",
  reset: "Reiniciar",
  real_bot: "Probar el bot real",
  merchant_side: "El comercio (Telegram)",
  payer_side: "El cliente (su billetera)",
  agent_side: "Lo que hace el agente",
  placeholder: "Escribe un mensaje…",
  send: "Enviar",
  chips: { AR: ["cobrar 4500 pizza", "cobrar 200000 heladera", "¿me pagaron el A-0001?", "/cierre"], BR: ["cobrar 30 corte", "cobrar 800 reparación", "¿me pagaron el A-0001?", "/cierre"], MX: ["cobrar 180 tacos", "cobrar 2500 pastel", "¿me pagaron el A-0001?", "/cierre"], CO: ["cobrar 12000 almuerzo", "cobrar 500000 mercado", "¿me pagaron el A-0001?", "/cierre"] },
  welcome: (cur, ex) => `¡Hola! Soy Cobrá (versión demo). Escribe el monto en ${cur}, por ejemplo: ${ex}`,
  help: (cur) => `En la demo entiendo (los montos son en ${cur}):\n• cobrar 4500 pizza — crea un cobro con QR\n• ¿me pagaron el A-0001?\n• cancela el último cobro\n• /cierre — resumen del día\nEn Telegram también entiendo frases libres y notas de voz, y puedes cambiar país (/pais), moneda de cobro (/moneda) o billetera (/billetera).`,
  usage: (cur) => `Escribe el monto en ${cur} y una descripción, por ejemplo: cobrar 4500 café`,
  amount_error: withInput(ERR_ES),
  invoice_caption: (ref, amount, usd, desc) => `Cobro ${ref}: ${amount} (≈ US$ ${usd})${desc ? ` · ${desc}` : ""}\nVence en 10 min.`,
  charge_over: (amount, usd, max, cur) =>
    `No creé el cobro: ${amount} equivale a ≈ US$ ${usd}, y por ahora el máximo por pago es US$ ${max}. ¿Escribiste el monto en ${cur}? Revísalo y vuelve a intentarlo.`,
  charge_confirm: (amount, usd, desc) => `¿Confirmas este cobro?\n${amount} (≈ US$ ${usd})${desc ? ` — ${desc}` : ""}`,
  btn_yes: "Sí, cobrar",
  btn_fix: "Corregir",
  charge_fix: (cur) => `Listo, no creé nada. Escribe el monto correcto en ${cur}, por ejemplo: cobrar 4500 café`,
  btn_share: "Compartir por WhatsApp",
  btn_open_payer: "Abrir en el teléfono del cliente →",
  cancel_ok: (ref) => `Cobro ${ref} cancelado.`,
  cancel_none: "No tienes cobros pendientes para cancelar.",
  status_paid: (ref, amount) => `Sí: ${ref} (${amount}) está pagado. Comprobante en Celoscan (en la app real).`,
  status_open: (ref, amount) => `${ref} (${amount}) sigue pendiente. Te aviso apenas llegue el pago.`,
  status_cancelled: (ref) => `${ref} fue cancelado.`,
  status_none: "No encontré ese cobro. Crea uno con: cobrar 4500 pizza",
  close: (total, count, open) => `Cierre del día\nCobrado: ${total} (${count} pagos)\nPendientes: ${open}\nEn la app real también recibes un CSV, cada noche a las 21:00.`,
  unknown: "En la demo solo entiendo algunas frases (prueba /ayuda). En Telegram, el agente entiende lenguaje natural y notas de voz.",
  paid_notice: (ref, amount, token) => `¡Pago recibido! ${ref}: ${amount} → ${token} en tu billetera.`,
  payer_empty: "Aquí aparece el pago cuando el cliente escanea tu QR. Crea un cobro en el chat de la izquierda.",
  payer_connect: "Conectar billetera (demo)",
  payer_wallet: (b) => `Billetera demo · ${b} USD₮ · 0 CELO`,
  payer_pay: (u) => `Pagar ${u} USD₮`,
  payer_note: "Una firma · sin gas · el agente paga la red",
  payer_signing: "Confirma en tu billetera…",
  payer_paying: "Pagando…",
  payer_paid: "Pagado",
  payer_receipt: (m) => `Pagaste a ${m}. El comercio recibió el monto exacto.`,
  payer_sim_tx: "Transacción simulada (demo)",
  payer_insufficient: "Saldo insuficiente. En la app real: «Pagar en pesos» con Ripio.",
  payer_cancelled: "El comercio canceló este cobro.",
  payer_expires: "Vence en",
  payer_illustrative: "Tipo de cambio ilustrativo",
  agent_idle: "Esperando un cobro…",
  agent_invoice: (ref) => `Cobro ${ref} creado. El monto lo leyó el parser, no la IA.`,
  agent_route: (route, cost) => `Ruta elegida: ${route} · costo ≈ ${cost}`,
  agent_gas: "Gas pagado por el agente: el cliente no necesita CELO",
  agent_relay: "Transacción enviada por el agente, con la etiqueta ERC-8021",
  agent_settle: (amount, token) => `El contrato pagó exactamente ${amount} en ${token} al comercio`,
  agent_notify: "Comercio avisado en Telegram",
  agent_footer: "En producción, cada paso queda en el diario público del agente.",
  payer_wallet_ramp: (u, held, tok) => `Billetera demo · ${u} USD₮ · ${held} ${tok} · 0 CELO`,
  payer_no_route: (tok) => `Todavía no hay ruta de conversión de dólares a ${tok} en Celo: este cobro se paga en ${tok}.`,
  payer_ramp_btn: (a, tok) => `Comprar ${a} ${tok} en pesos con Ripio`,
  payer_ramping: (rail) => `Ripio · transferencia ${rail} en curso…`,
  payer_ramp_done: (a, tok) => `Ripio acreditó ${a} ${tok} en tu billetera.`,
  payer_pay_token: (a, tok) => `Pagar ${a} ${tok}`,
  payer_ramp_note: "Rampa Ripio simulada: en la app real se abre Ripio (cuenta y verificación de identidad en Ripio).",
  agent_no_route: (tok) => `Sin ruta de conversión hacia ${tok} en Celo: el agente propone pagar en ${tok} y abre la rampa Ripio`,
  agent_ramp: (a, tok, rail) => `Rampa Ripio (fuera de Cobrá): el cliente compró ${a} ${tok} con pesos por ${rail}`,
  agent_direct: (tok) => `Sin swap: el cliente paga directamente en ${tok} · costo 0 % (solo la red, pagada por el agente)`,
  agent_gas_grant: "Primer pago en este token: el agente envía 0,05 CELO para la autorización Permit2 (una sola vez)",
};

const pt: DemoStrings = {
  meta_title: "Cobrá · Demo interativa",
  meta_desc: "Teste a Cobrá em 30 segundos: o chat do comércio e o celular do cliente, lado a lado. Tudo simulado.",
  banner: "DEMO · Tudo é simulado: nenhuma transação, nenhum dinheiro real.",
  banner_link: "Ver pagamentos reais na Celo",
  title: "Teste a Cobrá em 30 segundos",
  sub: "À esquerda, o chat do comércio no Telegram. À direita, o celular do cliente. Escreva uma cobrança e pague.",
  country: { AR: "Argentina · wARS", BR: "Brasil · wBRL", MX: "México · wMXN", CO: "Colombia · wCOP" },
  tab_merchant: "Comércio",
  tab_payer: "Cliente",
  tab_agent: "Agente",
  reset: "Reiniciar",
  real_bot: "Testar o bot real",
  merchant_side: "O comércio (Telegram)",
  payer_side: "O cliente (a carteira dele)",
  agent_side: "O que o agente faz",
  placeholder: "Escreva uma mensagem…",
  send: "Enviar",
  chips: { AR: ["cobrar 4500 pizza", "cobrar 200000 geladeira", "o A-0001 foi pago?", "/fechamento"], BR: ["cobrar 30 corte", "cobrar 800 conserto", "o A-0001 foi pago?", "/fechamento"], MX: ["cobrar 180 tacos", "cobrar 2500 bolo", "o A-0001 foi pago?", "/fechamento"], CO: ["cobrar 12000 almoço", "cobrar 500000 mercado", "o A-0001 foi pago?", "/fechamento"] },
  welcome: (cur, ex) => `Olá! Eu sou a Cobrá (versão demo). Escreva o valor em ${cur}, por exemplo: ${ex}`,
  help: (cur) => `Na demo eu entendo (os valores são em ${cur}):\n• cobrar 30 corte — cria uma cobrança com QR\n• o A-0001 foi pago?\n• cancela a última cobrança\n• /fechamento — resumo do dia\nNo Telegram também entendo frases livres e áudios, e você pode mudar país (/pais), moeda de recebimento (/moeda) ou carteira (/carteira).`,
  usage: (cur) => `Escreva o valor em ${cur} e uma descrição, por exemplo: cobrar 30 corte`,
  amount_error: withInput(ERR_PT),
  invoice_caption: (ref, amount, usd, desc) => `Cobrança ${ref}: ${amount} (≈ US$ ${usd})${desc ? ` · ${desc}` : ""}\nVence em 10 min.`,
  charge_over: (amount, usd, max, cur) =>
    `Não criei a cobrança: ${amount} equivale a ≈ US$ ${usd}, e por enquanto o máximo por pagamento é US$ ${max}. Você escreveu o valor em ${cur}? Confira e tente de novo.`,
  charge_confirm: (amount, usd, desc) => `Confirma esta cobrança?\n${amount} (≈ US$ ${usd})${desc ? ` — ${desc}` : ""}`,
  btn_yes: "Sim, cobrar",
  btn_fix: "Corrigir",
  charge_fix: (cur) => `Pronto, não criei nada. Escreva o valor certo em ${cur}, por exemplo: cobrar 30 corte`,
  btn_share: "Compartilhar no WhatsApp",
  btn_open_payer: "Abrir no celular do cliente →",
  cancel_ok: (ref) => `Cobrança ${ref} cancelada.`,
  cancel_none: "Você não tem cobranças pendentes para cancelar.",
  status_paid: (ref, amount) => `Sim: ${ref} (${amount}) está pago. Comprovante no Celoscan (no app real).`,
  status_open: (ref, amount) => `${ref} (${amount}) continua pendente. Te aviso assim que o pagamento chegar.`,
  status_cancelled: (ref) => `${ref} foi cancelada.`,
  status_none: "Não encontrei essa cobrança. Crie uma com: cobrar 30 corte",
  close: (total, count, open) => `Fechamento do dia\nRecebido: ${total} (${count} pagamentos)\nPendentes: ${open}\nNo app real você também recebe um CSV, toda noite às 21:00.`,
  unknown: "Na demo eu só entendo algumas frases (teste /ajuda). No Telegram, o agente entende linguagem natural e áudios.",
  paid_notice: (ref, amount, token) => `Pagamento recebido! ${ref}: ${amount} → ${token} na sua carteira.`,
  payer_empty: "O pagamento aparece aqui quando o cliente escaneia o seu QR. Crie uma cobrança no chat à esquerda.",
  payer_connect: "Conectar carteira (demo)",
  payer_wallet: (b) => `Carteira demo · ${b} USD₮ · 0 CELO`,
  payer_pay: (u) => `Pagar ${u} USD₮`,
  payer_note: "Uma assinatura · sem gas · o agente paga a rede",
  payer_signing: "Confirme na sua carteira…",
  payer_paying: "Pagando…",
  payer_paid: "Pago",
  payer_receipt: (m) => `Você pagou ${m}. O comércio recebeu o valor exato.`,
  payer_sim_tx: "Transação simulada (demo)",
  payer_insufficient: "Saldo insuficiente. No app real: «Pagar em reais» com a Ripio.",
  payer_cancelled: "O comércio cancelou esta cobrança.",
  payer_expires: "Vence em",
  payer_illustrative: "Câmbio ilustrativo",
  agent_idle: "Esperando uma cobrança…",
  agent_invoice: (ref) => `Cobrança ${ref} criada. O valor foi lido pelo parser, não pela IA.`,
  agent_route: (route, cost) => `Rota escolhida: ${route} · custo ≈ ${cost}`,
  agent_gas: "Gas pago pelo agente: o cliente não precisa de CELO",
  agent_relay: "Transação enviada pelo agente, com a etiqueta ERC-8021",
  agent_settle: (amount, token) => `O contrato pagou exatamente ${amount} em ${token} ao comércio`,
  agent_notify: "Comércio avisado no Telegram",
  agent_footer: "Em produção, cada passo fica no diário público do agente.",
  payer_wallet_ramp: (u, held, tok) => `Carteira demo · ${u} USD₮ · ${held} ${tok} · 0 CELO`,
  payer_no_route: (tok) => `Ainda não há rota de conversão de dólares para ${tok} na Celo: esta cobrança é paga em ${tok}.`,
  payer_ramp_btn: (a, tok) => `Comprar ${a} ${tok} em pesos com a Ripio`,
  payer_ramping: (rail) => `Ripio · transferência ${rail} em andamento…`,
  payer_ramp_done: (a, tok) => `A Ripio creditou ${a} ${tok} na sua carteira.`,
  payer_pay_token: (a, tok) => `Pagar ${a} ${tok}`,
  payer_ramp_note: "Rampa Ripio simulada: no app real a Ripio abre (conta e verificação de identidade na Ripio).",
  agent_no_route: (tok) => `Sem rota de conversão para ${tok} na Celo: o agente propõe pagar em ${tok} e abre a rampa Ripio`,
  agent_ramp: (a, tok, rail) => `Rampa Ripio (fora da Cobrá): o cliente comprou ${a} ${tok} com pesos via ${rail}`,
  agent_direct: (tok) => `Sem swap: o cliente paga direto em ${tok} · custo 0 % (só a rede, paga pelo agente)`,
  agent_gas_grant: "Primeiro pagamento neste token: o agente envia 0,05 CELO para a autorização Permit2 (uma única vez)",
};

const en: DemoStrings = {
  meta_title: "Cobrá · Interactive demo",
  meta_desc: "Try Cobrá in 30 seconds: the merchant's chat and the customer's phone, side by side. Everything simulated.",
  banner: "DEMO · Everything is simulated: no transaction, no real money.",
  banner_link: "See real payments on Celo",
  title: "Try Cobrá in 30 seconds",
  sub: "On the left, the merchant's Telegram chat. On the right, the customer's phone. Type a charge and pay it.",
  country: { AR: "Argentina · wARS", BR: "Brazil · wBRL", MX: "Mexico · wMXN", CO: "Colombia · wCOP" },
  tab_merchant: "Merchant",
  tab_payer: "Customer",
  tab_agent: "Agent",
  reset: "Reset",
  real_bot: "Try the real bot",
  merchant_side: "The merchant (Telegram)",
  payer_side: "The customer (their wallet)",
  agent_side: "What the agent does",
  placeholder: "Type a message…",
  send: "Send",
  chips: { AR: ["charge 4500 pizza", "charge 200000 fridge", "was A-0001 paid?", "/close"], BR: ["charge 30 haircut", "charge 800 repair", "was A-0001 paid?", "/close"], MX: ["charge 180 tacos", "charge 2500 cake", "was A-0001 paid?", "/close"], CO: ["charge 12000 lunch", "charge 500000 groceries", "was A-0001 paid?", "/close"] },
  welcome: (cur, ex) => `Hi! I'm Cobrá (demo version). Type the amount in ${cur}, e.g.: ${ex}`,
  help: (cur) => `In the demo I understand (amounts are in ${cur}):\n• charge 4500 pizza — creates a request with a QR\n• was A-0001 paid?\n• cancel the last one\n• /close — today's summary\nOn Telegram I also understand free text and voice notes, and you can change country (/country), payout currency (/currency) or wallet (/wallet).`,
  usage: (cur) => `Type the amount in ${cur} and a description, for example: charge 4500 coffee`,
  amount_error: withInput(ERR_EN),
  invoice_caption: (ref, amount, usd, desc) => `Request ${ref}: ${amount} (≈ US$ ${usd})${desc ? ` · ${desc}` : ""}\nExpires in 10 min.`,
  charge_over: (amount, usd, max, cur) =>
    `I didn't create the request: ${amount} is about US$ ${usd}, and for now the maximum per payment is US$ ${max}. Did you type the amount in ${cur}? Check it and try again.`,
  charge_confirm: (amount, usd, desc) => `Confirm this request?\n${amount} (≈ US$ ${usd})${desc ? ` — ${desc}` : ""}`,
  btn_yes: "Yes, charge",
  btn_fix: "Fix it",
  charge_fix: (cur) => `OK, nothing was created. Type the right amount in ${cur}, e.g.: charge 4500 coffee`,
  btn_share: "Share on WhatsApp",
  btn_open_payer: "Open on the customer's phone →",
  cancel_ok: (ref) => `Request ${ref} cancelled.`,
  cancel_none: "You have no open request to cancel.",
  status_paid: (ref, amount) => `Yes: ${ref} (${amount}) is paid. Receipt on Celoscan (in the real app).`,
  status_open: (ref, amount) => `${ref} (${amount}) is still open. I'll tell you as soon as it's paid.`,
  status_cancelled: (ref) => `${ref} was cancelled.`,
  status_none: "I couldn't find that request. Create one with: charge 4500 pizza",
  close: (total, count, open) => `Daily close\nCollected: ${total} (${count} payments)\nOpen: ${open}\nIn the real app you also get a CSV, every evening at 21:00.`,
  unknown: "The demo only understands a few phrases (try /help). On Telegram, the agent understands natural language and voice notes.",
  paid_notice: (ref, amount, token) => `Payment received! ${ref}: ${amount} → ${token} in your wallet.`,
  payer_empty: "The payment shows up here when the customer scans your QR. Create a request in the chat on the left.",
  payer_connect: "Connect wallet (demo)",
  payer_wallet: (b) => `Demo wallet · ${b} USD₮ · 0 CELO`,
  payer_pay: (u) => `Pay ${u} USD₮`,
  payer_note: "One signature · no gas · the agent pays the network",
  payer_signing: "Confirm in your wallet…",
  payer_paying: "Paying…",
  payer_paid: "Paid",
  payer_receipt: (m) => `You paid ${m}. The merchant received the exact amount.`,
  payer_sim_tx: "Simulated transaction (demo)",
  payer_insufficient: "Not enough balance. In the real app: “Pay in pesos” through Ripio.",
  payer_cancelled: "The merchant cancelled this request.",
  payer_expires: "Expires in",
  payer_illustrative: "Illustrative exchange rate",
  agent_idle: "Waiting for a request…",
  agent_invoice: (ref) => `Request ${ref} created. The amount was read by the parser, not the AI.`,
  agent_route: (route, cost) => `Route chosen: ${route} · cost ≈ ${cost}`,
  agent_gas: "Gas paid by the agent: the customer needs no CELO",
  agent_relay: "Transaction sent by the agent, with the ERC-8021 tag",
  agent_settle: (amount, token) => `The contract paid exactly ${amount} in ${token} to the merchant`,
  agent_notify: "Merchant notified on Telegram",
  agent_footer: "In production, every step lands in the agent's public journal.",
  payer_wallet_ramp: (u, held, tok) => `Demo wallet · ${u} USD₮ · ${held} ${tok} · 0 CELO`,
  payer_no_route: (tok) => `There is no dollar-to-${tok} conversion route on Celo yet: this request is paid in ${tok}.`,
  payer_ramp_btn: (a, tok) => `Buy ${a} ${tok} in pesos with Ripio`,
  payer_ramping: (rail) => `Ripio · ${rail} transfer in progress…`,
  payer_ramp_done: (a, tok) => `Ripio credited ${a} ${tok} to your wallet.`,
  payer_pay_token: (a, tok) => `Pay ${a} ${tok}`,
  payer_ramp_note: "Simulated Ripio ramp: the real app opens Ripio (Ripio account and identity check).",
  agent_no_route: (tok) => `No conversion route to ${tok} on Celo: the agent offers to pay in ${tok} and opens the Ripio ramp`,
  agent_ramp: (a, tok, rail) => `Ripio ramp (outside Cobrá): the customer bought ${a} ${tok} with pesos over ${rail}`,
  agent_direct: (tok) => `No swap: the customer pays in ${tok} directly · 0 % cost (network only, paid by the agent)`,
  agent_gas_grant: "First payment in this token: the agent sends 0.05 CELO for the one-time Permit2 approval",
};

export const DEMO: Record<Language, DemoStrings> = { es, pt, en };

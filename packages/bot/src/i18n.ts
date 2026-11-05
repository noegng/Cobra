/**
 * All user-facing strings (es / pt / en). Plain text only (no Markdown / HTML parse mode), so merchant-provided
 * descriptions can never break formatting or inject markup.
 */
import type { CountryCode, InvoiceStatus, Language } from "@cobra/shared";
import { currencyName, type AmountError } from "./amount";

type P = Record<string, string | number>;
const fill = (s: string, p: P = {}): string => s.replace(/\{(\w+)\}/g, (_, k: string) => String(p[k] ?? `{${k}}`));

const es = {
  welcome_new:
    "¡Hola! Soy Cobrá: cobras en pesos con un QR y recibes el dinero directo en tu billetera.\n\nPaso 1 de 2: ¿en qué país está tu negocio?",
  welcome_back: "¡Hola de nuevo, {name}! Escribe el monto en {cur}, por ejemplo: cobrar 4500 café\n/ayuda para ver todo lo que puedo hacer.",
  choose_language: "Elige tu idioma:",
  language_set: "Listo, te hablo en español.",
  country_unavailable: "Todavía no podemos liquidar en {currency} ({country}). Elige otro país o vuelve pronto.",
  country_no_conversion:
    "Nota: en {country} todavía no hay conversión automática. Tus clientes deben pagar directamente en {token}.",
  ask_address:
    "Paso 2 de 2: pega la dirección de tu billetera en Celo (empieza con 0x). Ahí recibirás {token}, 1:1 con tu moneda.\n\nNunca te pediremos claves privadas ni frases semilla.",
  address_invalid: "Eso no parece una dirección válida. Debe empezar con 0x y tener 42 caracteres. Inténtalo de nuevo.",
  address_checksum: "La dirección tiene un error de mayúsculas/minúsculas (checksum). Cópiala de nuevo desde tu billetera.",
  address_forbidden: "Esa dirección no puede recibir pagos (es una dirección nula o de un contrato de token). Pega la de tu billetera.",
  address_secret:
    "¡Cuidado! Eso parece una clave privada o una frase semilla. NUNCA la compartas con nadie, tampoco conmigo. Borra ese mensaje y, si alguien más la vio, mueve tus fondos a una billetera nueva. Pega solo tu dirección pública (0x...).",
  onboarding_done:
    "¡Listo, {name}! Recibirás {token} en {address}.\n\nPara cobrar escribe el monto en {cur}: cobrar 4500 café\nEste es tu QR fijo: tus clientes lo escanean e ingresan el monto.",
  static_qr_caption: "Tu QR de cobro fijo: {url}",
  proof_hint: "Opcional: prueba que la billetera es tuya firmando un mensaje en {url}",
  help:
    "Comandos (los montos son en {cur}):\n/cobrar 4500 café — crea un cobro de 4500 {cur} con QR y link (vence en 10 min)\n/facturas — tus últimos cobros\n/cierre — resumen del día + CSV (también llega solo a las 21:00)\n/panel — enlace privado a tu panel web\n/retirar — cómo pasar tus {token} a tu banco\n/idioma — cambiar idioma\n/pais — cambiar de país\n/moneda — recibir en moneda local digital o en USD₮\n/billetera — cambiar tu dirección de cobro\n\nTambién puedes escribirme normal: \"¿me pagaron el A-0042?\", \"cancela el último cobro\".",
  not_onboarded: "Primero configuremos tu cuenta: /start",
  invoice_caption: "Cobro {ref}: {amount}{usd}{desc}\nVence en {minutes} min.\nLink de pago: {url}",
  wa_text: "{name} te envía un cobro de {amount}{desc}. Paga aquí: {url}",
  btn_whatsapp: "Compartir por WhatsApp",
  btn_open: "Abrir link de pago",
  btn_cancel: "Cancelar cobro",
  usage_cobrar: "Escribe el monto en {cur} y una descripción, por ejemplo: cobrar 4500 café",
  amount_space_ambiguous: "\"{input}\" puede leerse como {joined} o como {first}. Escribe el monto sin espacios, por ejemplo: cobrar 4500 café",
  amount_empty: "Falta el monto en {cur}. Ejemplo: cobrar 4500 café",
  amount_invalid: "No entendí el monto \"{input}\". Ejemplos: 4500, 4.500,50, 2 mil.",
  amount_ambiguous: "\"{input}\" es ambiguo. ¿Quisiste decir sin decimales (4.500) o con decimales (4,50)? Escríbelo de nuevo, por favor.",
  amount_negative: "El monto debe ser positivo.",
  amount_zero: "El monto debe ser mayor que cero.",
  amount_too_many_decimals: "Máximo 2 decimales.",
  amount_too_large: "Ese monto es demasiado grande.",
  amount_foreign_currency: "Tus cobros son en {cur}. Escribe el monto en {cur}, por ejemplo: cobrar 4500 café. Si prefieres recibir dólares digitales, usa /moneda.",
  usd_hint: " (≈ US$ {usd})",
  charge_over:
    "No creé el cobro: {amount} equivale a ≈ US$ {usd}, y por ahora el máximo por pago es US$ {max}. ¿Escribiste el monto en {cur}? Revísalo y vuelve a intentarlo.",
  charge_confirm: "¿Confirmas este cobro?\n{amount} (≈ US$ {usd}){desc}",
  btn_charge_yes: "Sí, cobrar",
  btn_charge_fix: "Corregir",
  charge_fix: "Listo, no creé nada. Escribe el monto correcto en {cur}, por ejemplo: cobrar 4500 café",
  charge_confirm_expired: "Esta confirmación ya no es válida. Vuelve a escribir el cobro.",
  rate_limited: "Demasiados cobros seguidos. Espera un minuto e inténtalo de nuevo.",
  unsupported_settlement: "Tu moneda de liquidación no es compatible con cobros en {currency} todavía.",
  invoices_empty: "Todavía no tienes cobros.",
  invoices_header: "Tus últimos cobros:",
  invoice_line: "{ref} · {amount} · {status}{desc}",
  status_open: "pendiente",
  status_submitted: "en proceso",
  status_paid: "pagado",
  status_expired: "vencido",
  status_cancelled: "cancelado",
  cancelled_ok: "Cobro {ref} cancelado.",
  cancel_not_found: "No encontré ese cobro.",
  cancel_not_open: "No se puede cancelar {ref}: está {status}.",
  close_header: "Cierre del día {date}",
  close_body:
    "Cobrado: {paidTotal} ({paidCount} pagos)\nPendientes: {open} · Vencidos: {expired} · Cancelados: {cancelled}\nCobros creados hoy: {created}",
  close_csv_caption: "Detalle del día {date} (CSV)",
  withdraw_link: "Para pasar tus {token} a pesos en tu banco:\n1. Abre {url} (Ripio, retiro a banco).\n2. Elige {token} en la red Celo.\n3. Envía tus {token} desde tu billetera ({address}) a la dirección de depósito que te muestre Ripio.\nCobrá nunca mueve tus fondos.",
  panel_link: "Tu panel (válido 15 minutos): {url}",
  panel_unavailable: "El panel no está disponible por ahora.",
  reminder: "Recordatorio: el cobro {ref} ({amount}) sigue pendiente y vence en {minutes} min.\nLink: {url}\nReenviar por WhatsApp: {wa}",
  paid: "¡Pago recibido! {ref}: {amount}{received}.\nComprobante: {url}",
  paid_received: " → {amount} {token} en tu billetera",
  payout_confirm: "¿Confirmas que quieres recibir tus pagos en esta nueva dirección?\n{address}\nRevisa cada carácter.",
  btn_confirm: "Sí, confirmar",
  btn_reject: "No",
  payout_updated: "Dirección de cobro actualizada: {address}",
  payout_expired: "Esta confirmación ya no es válida. Vuelve a pedir el cambio.",
  payout_rejected: "Cambio descartado. Tu dirección sigue igual.",
  choose_country: "¿En qué país está tu negocio? Ahora: {country} ({currency}).",
  country_changed: "Listo: {country}. Cobras en {currency} y recibes {token} en {address}.",
  choose_currency: "¿Cómo quieres recibir tus pagos? Tus cobros siguen en {currency}; en USD₮ se convierten al tipo de cambio de referencia al crear cada cobro.\nAhora: {token}",
  currency_set: "Listo: recibirás {token}. Tus cobros siguen en {currency}.",
  currency_unavailable: "Esa opción no está disponible para tu país.",
  rate_unavailable: "No pude obtener el tipo de cambio {currency}/USD₮ ahora. No se creó el cobro: inténtalo de nuevo en unos minutos.",
  ask_wallet: "Pega la nueva dirección de tu billetera en Celo (empieza con 0x). Nunca te pediremos claves privadas ni frases semilla.",
  stale_open: "{n} cobro(s) abierto(s) todavía pagan a la dirección o moneda anterior.",
  btn_cancel_stale: "Cancelarlos todos",
  stale_cancelled: "{n} cobro(s) cancelado(s).",
  voice_unsupported: "Por ahora no puedo escuchar audios. Escríbeme el cobro, por ejemplo: cobrar 4500 café",
  voice_too_long: "El audio es muy largo (máximo 60 s).",
  voice_heard: "Entendí: \"{text}\"",
  voice_failed: "No pude entender el audio. ¿Me lo escribes?",
  llm_unavailable: "Solo entiendo comandos simples por ahora. Ejemplo: cobrar 4500 café — o /ayuda",
  llm_error: "Tuve un problema para responder. Inténtalo de nuevo o usa /ayuda.",
  busy: "Vas muy rápido. Espera unos segundos.",
  private_only: "Solo funciono en chat privado.",
  cannot_move_funds: "No puedo enviar ni mover dinero: Cobrá solo crea cobros que se pagan a tu propia billetera. No se hizo ningún cambio.",
} as const;

type Key = keyof typeof es;
type Strings = Record<Key, string>;

const pt: Strings = {
  welcome_new:
    "Olá! Eu sou o Cobrá: você cobra em reais com um QR e recebe o dinheiro direto na sua carteira.\n\nPasso 1 de 2: em qual país fica o seu negócio?",
  welcome_back: "Olá de novo, {name}! Escreva o valor em {cur}, por exemplo: cobrar 30 corte\n/ajuda para ver tudo o que eu faço.",
  choose_language: "Escolha seu idioma:",
  language_set: "Pronto, vou falar em português.",
  country_unavailable: "Ainda não conseguimos liquidar em {currency} ({country}). Escolha outro país ou volte em breve.",
  country_no_conversion:
    "Obs.: em {country} ainda não há conversão automática. Seus clientes precisam pagar diretamente em {token}.",
  ask_address:
    "Passo 2 de 2: cole o endereço da sua carteira na Celo (começa com 0x). Você vai receber {token}, 1:1 com a sua moeda.\n\nNunca vamos pedir chaves privadas nem frases-semente.",
  address_invalid: "Isso não parece um endereço válido. Deve começar com 0x e ter 42 caracteres. Tente de novo.",
  address_checksum: "O endereço tem um erro de maiúsculas/minúsculas (checksum). Copie de novo da sua carteira.",
  address_forbidden: "Esse endereço não pode receber pagamentos (endereço nulo ou de contrato de token). Cole o da sua carteira.",
  address_secret:
    "Cuidado! Isso parece uma chave privada ou frase-semente. NUNCA compartilhe com ninguém, nem comigo. Apague essa mensagem e, se alguém viu, mova seus fundos para uma carteira nova. Cole só o seu endereço público (0x...).",
  onboarding_done:
    "Pronto, {name}! Você vai receber {token} em {address}.\n\nPara cobrar escreva o valor em {cur}: cobrar 30 corte\nEste é o seu QR fixo: o cliente escaneia e digita o valor.",
  static_qr_caption: "Seu QR de cobrança fixo: {url}",
  proof_hint: "Opcional: prove que a carteira é sua assinando uma mensagem em {url}",
  help:
    "Comandos (os valores são em {cur}):\n/cobrar 30 corte — cria uma cobrança de 30 {cur} com QR e link (vence em 10 min)\n/faturas — suas últimas cobranças\n/fechamento — resumo do dia + CSV (também chega sozinho às 21:00)\n/painel — link privado para seu painel web\n/sacar — como levar seus {token} para o banco\n/idioma — mudar idioma\n/pais — mudar de país\n/moeda — receber em moeda local digital ou em USD₮\n/carteira — mudar seu endereço de recebimento\n\nVocê também pode escrever normalmente: \"o A-0042 foi pago?\", \"cancela a última cobrança\".",
  not_onboarded: "Primeiro vamos configurar sua conta: /start",
  invoice_caption: "Cobrança {ref}: {amount}{usd}{desc}\nVence em {minutes} min.\nLink de pagamento: {url}",
  wa_text: "{name} te enviou uma cobrança de {amount}{desc}. Pague aqui: {url}",
  btn_whatsapp: "Compartilhar no WhatsApp",
  btn_open: "Abrir link de pagamento",
  btn_cancel: "Cancelar cobrança",
  usage_cobrar: "Escreva o valor em {cur} e uma descrição, por exemplo: cobrar 30 corte",
  amount_space_ambiguous: "\"{input}\" pode ser lido como {joined} ou como {first}. Escreva o valor sem espaços, por exemplo: cobrar 4500 corte",
  amount_empty: "Falta o valor em {cur}. Exemplo: cobrar 30 corte",
  amount_invalid: "Não entendi o valor \"{input}\". Exemplos: 30, 4.500,50, 2 mil.",
  amount_ambiguous: "\"{input}\" é ambíguo. Você quis dizer sem centavos (4.500) ou com centavos (4,50)? Escreva de novo, por favor.",
  amount_negative: "O valor deve ser positivo.",
  amount_zero: "O valor deve ser maior que zero.",
  amount_too_many_decimals: "No máximo 2 casas decimais.",
  amount_too_large: "Esse valor é grande demais.",
  amount_foreign_currency: "Suas cobranças são em {cur}. Escreva o valor em {cur}, por exemplo: cobrar 30 corte. Se preferir receber dólares digitais, use /moeda.",
  usd_hint: " (≈ US$ {usd})",
  charge_over:
    "Não criei a cobrança: {amount} equivale a ≈ US$ {usd}, e por enquanto o máximo por pagamento é US$ {max}. Você escreveu o valor em {cur}? Confira e tente de novo.",
  charge_confirm: "Confirma esta cobrança?\n{amount} (≈ US$ {usd}){desc}",
  btn_charge_yes: "Sim, cobrar",
  btn_charge_fix: "Corrigir",
  charge_fix: "Pronto, não criei nada. Escreva o valor certo em {cur}, por exemplo: cobrar 30 corte",
  charge_confirm_expired: "Esta confirmação não é mais válida. Escreva a cobrança de novo.",
  rate_limited: "Muitas cobranças seguidas. Espere um minuto e tente de novo.",
  unsupported_settlement: "Sua moeda de liquidação ainda não é compatível com cobranças em {currency}.",
  invoices_empty: "Você ainda não tem cobranças.",
  invoices_header: "Suas últimas cobranças:",
  invoice_line: "{ref} · {amount} · {status}{desc}",
  status_open: "pendente",
  status_submitted: "em processamento",
  status_paid: "pago",
  status_expired: "vencido",
  status_cancelled: "cancelado",
  cancelled_ok: "Cobrança {ref} cancelada.",
  cancel_not_found: "Não encontrei essa cobrança.",
  cancel_not_open: "Não dá para cancelar {ref}: está {status}.",
  close_header: "Fechamento do dia {date}",
  close_body:
    "Recebido: {paidTotal} ({paidCount} pagamentos)\nPendentes: {open} · Vencidas: {expired} · Canceladas: {cancelled}\nCobranças criadas hoje: {created}",
  close_csv_caption: "Detalhe do dia {date} (CSV)",
  withdraw_link: "Para levar seus {token} para reais no banco:\n1. Abra {url} (Ripio, saque para o banco).\n2. Escolha {token} na rede Celo.\n3. Envie seus {token} da sua carteira ({address}) para o endereço de depósito que a Ripio mostrar.\nO Cobrá nunca movimenta seus fundos.",
  panel_link: "Seu painel (válido por 15 minutos): {url}",
  panel_unavailable: "O painel não está disponível no momento.",
  reminder: "Lembrete: a cobrança {ref} ({amount}) ainda está pendente e vence em {minutes} min.\nLink: {url}\nReenviar pelo WhatsApp: {wa}",
  paid: "Pagamento recebido! {ref}: {amount}{received}.\nComprovante: {url}",
  paid_received: " → {amount} {token} na sua carteira",
  payout_confirm: "Confirma que quer receber seus pagamentos neste novo endereço?\n{address}\nConfira cada caractere.",
  btn_confirm: "Sim, confirmar",
  btn_reject: "Não",
  payout_updated: "Endereço de recebimento atualizado: {address}",
  payout_expired: "Esta confirmação não é mais válida. Peça a alteração de novo.",
  payout_rejected: "Alteração descartada. Seu endereço continua o mesmo.",
  choose_country: "Em que país fica seu negócio? Agora: {country} ({currency}).",
  country_changed: "Pronto: {country}. Você cobra em {currency} e recebe {token} em {address}.",
  choose_currency: "Como você quer receber seus pagamentos? Suas cobranças continuam em {currency}; em USD₮ elas são convertidas pela cotação de referência ao criar cada cobrança.\nAgora: {token}",
  currency_set: "Pronto: você vai receber {token}. Suas cobranças continuam em {currency}.",
  currency_unavailable: "Essa opção não está disponível para o seu país.",
  rate_unavailable: "Não consegui obter a cotação {currency}/USD₮ agora. A cobrança não foi criada: tente de novo em alguns minutos.",
  ask_wallet: "Cole o novo endereço da sua carteira na Celo (começa com 0x). Nunca vamos pedir chaves privadas nem frases semente.",
  stale_open: "{n} cobrança(s) aberta(s) ainda paga(m) no endereço ou moeda anterior.",
  btn_cancel_stale: "Cancelar todas",
  stale_cancelled: "{n} cobrança(s) cancelada(s).",
  voice_unsupported: "Por enquanto não consigo ouvir áudios. Escreva a cobrança, por exemplo: cobrar 30 corte",
  voice_too_long: "O áudio é muito longo (máximo 60 s).",
  voice_heard: "Entendi: \"{text}\"",
  voice_failed: "Não consegui entender o áudio. Pode escrever?",
  llm_unavailable: "Por enquanto só entendo comandos simples. Exemplo: cobrar 30 corte — ou /ajuda",
  llm_error: "Tive um problema para responder. Tente de novo ou use /ajuda.",
  busy: "Muito rápido! Espere alguns segundos.",
  private_only: "Só funciono em conversa privada.",
  cannot_move_funds: "Não posso enviar nem movimentar dinheiro: o Cobrá só cria cobranças pagas na sua própria carteira. Nenhuma alteração foi feita.",
};

const en: Strings = {
  welcome_new:
    "Hi! I'm Cobrá: charge in local currency with a QR code and get paid straight to your wallet.\n\nStep 1 of 2: which country is your business in?",
  welcome_back: "Welcome back, {name}! Type the amount in {cur}, e.g.: charge 4500 coffee\n/help shows everything I can do.",
  choose_language: "Choose your language:",
  language_set: "Done, I'll speak English.",
  country_unavailable: "We can't settle in {currency} ({country}) yet. Pick another country or come back soon.",
  country_no_conversion:
    "Note: there is no automatic conversion in {country} yet. Your customers must pay directly in {token}.",
  ask_address:
    "Step 2 of 2: paste your Celo wallet address (starts with 0x). You'll receive {token}, 1:1 with your currency.\n\nWe will never ask for private keys or seed phrases.",
  address_invalid: "That doesn't look like a valid address. It must start with 0x and be 42 characters long. Try again.",
  address_checksum: "The address has an upper/lower-case (checksum) error. Copy it again from your wallet.",
  address_forbidden: "That address can't receive payments (zero address or a token contract). Paste your wallet's address.",
  address_secret:
    "Careful! That looks like a private key or seed phrase. NEVER share it with anyone, including me. Delete that message and, if anyone else saw it, move your funds to a new wallet. Paste only your public address (0x...).",
  onboarding_done:
    "All set, {name}! You'll receive {token} at {address}.\n\nTo charge, type the amount in {cur}: charge 4500 coffee\nThis is your fixed QR: customers scan it and enter the amount.",
  static_qr_caption: "Your fixed checkout QR: {url}",
  proof_hint: "Optional: prove the wallet is yours by signing a message at {url}",
  help:
    "Commands (amounts are in {cur}):\n/charge 4500 coffee — create a request for 4500 {cur} with QR and link (expires in 10 min)\n/invoices — your latest requests\n/close — today's summary + CSV (also sent automatically at 21:00)\n/dashboard — private link to your web dashboard\n/withdraw — how to cash out your {token} to your bank\n/language — change language\n/country — change country\n/currency — get paid in local digital currency or in USD₮\n/wallet — change your payout address\n\nYou can also just write: \"was A-0042 paid?\", \"cancel the last one\".",
  not_onboarded: "Let's set up your account first: /start",
  invoice_caption: "Request {ref}: {amount}{usd}{desc}\nExpires in {minutes} min.\nPayment link: {url}",
  wa_text: "{name} sent you a payment request for {amount}{desc}. Pay here: {url}",
  btn_whatsapp: "Share on WhatsApp",
  btn_open: "Open payment link",
  btn_cancel: "Cancel request",
  usage_cobrar: "Type the amount in {cur} and a description, e.g.: charge 4500 coffee",
  amount_space_ambiguous: "\"{input}\" could mean {joined} or {first}. Type the amount without spaces, e.g.: charge 4500 coffee",
  amount_empty: "The amount in {cur} is missing. Example: charge 4500 coffee",
  amount_invalid: "I didn't understand the amount \"{input}\". Examples: 4500, 4,500.50, 2 mil.",
  amount_ambiguous: "\"{input}\" is ambiguous. Did you mean a whole number (4500) or with decimals (4.50)? Please type it again.",
  amount_negative: "The amount must be positive.",
  amount_zero: "The amount must be greater than zero.",
  amount_too_many_decimals: "At most 2 decimals.",
  amount_too_large: "That amount is too large.",
  amount_foreign_currency: "Your requests are in {cur}. Type the amount in {cur}, e.g.: charge 4500 coffee. To get paid in digital dollars instead, use /currency.",
  usd_hint: " (≈ US$ {usd})",
  charge_over:
    "I didn't create the request: {amount} is about US$ {usd}, and for now the maximum per payment is US$ {max}. Did you type the amount in {cur}? Check it and try again.",
  charge_confirm: "Confirm this request?\n{amount} (≈ US$ {usd}){desc}",
  btn_charge_yes: "Yes, charge",
  btn_charge_fix: "Fix it",
  charge_fix: "OK, nothing was created. Type the right amount in {cur}, e.g.: charge 4500 coffee",
  charge_confirm_expired: "This confirmation is no longer valid. Type the request again.",
  rate_limited: "Too many requests in a row. Wait a minute and try again.",
  unsupported_settlement: "Your settlement token doesn't support {currency} requests yet.",
  invoices_empty: "You don't have any payment requests yet.",
  invoices_header: "Your latest requests:",
  invoice_line: "{ref} · {amount} · {status}{desc}",
  status_open: "pending",
  status_submitted: "processing",
  status_paid: "paid",
  status_expired: "expired",
  status_cancelled: "cancelled",
  cancelled_ok: "Request {ref} cancelled.",
  cancel_not_found: "I couldn't find that request.",
  cancel_not_open: "Can't cancel {ref}: it is {status}.",
  close_header: "Daily close {date}",
  close_body:
    "Collected: {paidTotal} ({paidCount} payments)\nPending: {open} · Expired: {expired} · Cancelled: {cancelled}\nRequests created today: {created}",
  close_csv_caption: "Details for {date} (CSV)",
  withdraw_link: "To cash out your {token} to your bank:\n1. Open {url} (Ripio off-ramp).\n2. Choose {token} on the Celo network.\n3. Send your {token} from your wallet ({address}) to the deposit address Ripio shows you.\nCobrá never moves your funds.",
  panel_link: "Your dashboard (valid for 15 minutes): {url}",
  panel_unavailable: "The dashboard is not available right now.",
  reminder: "Reminder: request {ref} ({amount}) is still unpaid and expires in {minutes} min.\nLink: {url}\nResend on WhatsApp: {wa}",
  paid: "Payment received! {ref}: {amount}{received}.\nReceipt: {url}",
  paid_received: " → {amount} {token} in your wallet",
  payout_confirm: "Do you confirm you want to receive payments at this new address?\n{address}\nCheck every character.",
  btn_confirm: "Yes, confirm",
  btn_reject: "No",
  payout_updated: "Payout address updated: {address}",
  payout_expired: "This confirmation is no longer valid. Ask for the change again.",
  payout_rejected: "Change discarded. Your address is unchanged.",
  choose_country: "Which country is your business in? Now: {country} ({currency}).",
  country_changed: "Done: {country}. You charge in {currency} and receive {token} at {address}.",
  choose_currency: "How do you want to get paid? Your requests stay in {currency}; with USD₮ they are converted at the reference rate when each request is created.\nNow: {token}",
  currency_set: "Done: you will receive {token}. Your requests stay in {currency}.",
  currency_unavailable: "That option is not available for your country.",
  rate_unavailable: "I couldn't get the {currency}/USD₮ rate right now. No request was created: try again in a few minutes.",
  ask_wallet: "Paste your new Celo wallet address (starts with 0x). We will never ask for private keys or seed phrases.",
  stale_open: "{n} open request(s) still pay the previous address or currency.",
  btn_cancel_stale: "Cancel them all",
  stale_cancelled: "{n} request(s) cancelled.",
  voice_unsupported: "I can't listen to voice notes yet. Type the request, e.g.: charge 4500 coffee",
  voice_too_long: "The voice note is too long (60 s max).",
  voice_heard: "I heard: \"{text}\"",
  voice_failed: "I couldn't understand the voice note. Could you type it?",
  llm_unavailable: "For now I only understand simple commands. Example: charge 4500 coffee — or /help",
  llm_error: "I had a problem answering. Try again or use /help.",
  busy: "Slow down a little. Wait a few seconds.",
  private_only: "I only work in private chats.",
  cannot_move_funds: "I can't send or move money: Cobrá only creates payment requests paid to your own wallet. Nothing was changed.",
};

const STRINGS: Record<Language, Strings> = { es, pt, en };

export const LANGUAGES: readonly Language[] = ["es", "pt", "en"];

export function t(lang: Language, key: Key, params?: P): string {
  return fill(STRINGS[lang][key], params);
}

export function asLanguage(x: string | null | undefined): Language {
  return x === "pt" || x === "en" || x === "es" ? x : "es";
}

/** Telegram `language_code` ("es-AR", "pt-br", "en") -> supported language; unknown -> `fallback`. */
export function languageFromTelegram(code: string | undefined, fallback: Language = "es"): Language {
  const base = (code ?? "").toLowerCase().split(/[-_]/)[0];
  return base === "es" || base === "pt" || base === "en" ? base : fallback;
}

export const LANGUAGE_LABEL: Record<Language, string> = { es: "Español", pt: "Português", en: "English" };

export const COUNTRY_LABEL: Record<CountryCode, Record<Language, string>> = {
  AR: { es: "Argentina", pt: "Argentina", en: "Argentina" },
  BR: { es: "Brasil", pt: "Brasil", en: "Brazil" },
  MX: { es: "México", pt: "México", en: "Mexico" },
  CO: { es: "Colombia", pt: "Colômbia", en: "Colombia" },
  CL: { es: "Chile", pt: "Chile", en: "Chile" },
  PE: { es: "Perú", pt: "Peru", en: "Peru" },
};

const FIAT_PLURAL: Record<string, Record<Language, string>> = {
  ARS: { es: "pesos", pt: "pesos", en: "pesos" },
  MXN: { es: "pesos", pt: "pesos", en: "pesos" },
  COP: { es: "pesos", pt: "pesos", en: "pesos" },
  CLP: { es: "pesos", pt: "pesos", en: "pesos" },
  BRL: { es: "reales", pt: "reais", en: "reais" },
  PEN: { es: "soles", pt: "soles", en: "soles" },
  USD: { es: "dólares", pt: "dólares", en: "dollars" },
};

/** Settlement button label: "wARS · pesos digitales", "USD₮ · dólares digitales". */
export function settlementLabel(lang: Language, symbol: string, currency: string): string {
  const name = FIAT_PLURAL[currency]?.[lang] ?? currency;
  const desc = lang === "en" ? `digital ${name}` : `${name} ${lang === "pt" ? "digitais" : "digitales"}`;
  return `${symbol} · ${desc}`;
}

export function statusLabel(lang: Language, status: InvoiceStatus): string {
  return t(lang, `status_${status}` as Key);
}

export function amountErrorMessage(lang: Language, error: AmountError, input: string, currency: string): string {
  return t(lang, `amount_${error}` as Key, { input, currency, cur: currencyName(currency, lang) });
}

export type StringKey = Key;

# Cobrá — Pilot test guide (Brazil)

Thanks for testing Cobrá! This guide takes about **15 minutes**. You will act as a **merchant** (you charge in
reais and receive wBRL in your own wallet) and, with a second wallet, as a **customer** (you pay with digital dollars).

- Telegram bot: https://t.me/cobra_agent_telegram_bot
- Website: https://cobra-beige.vercel.app
- Try it without any wallet first (simulated): https://cobra-beige.vercel.app/demo

---

## Before you start: please read

Cobrá is a **hackathon pilot** running on Celo mainnet with **real money**. It is designed so that nobody, including
us, can hold or redirect your funds. But it is new and **has not been audited** yet. So:

- **Use small amounts only** (a few reais, at most ~US$10). That is enough to test everything.
- **Never share your seed phrase or private key** with anyone, Cobrá included. Cobrá only ever asks for your public
  address (`0x…`). If someone asks for your seed phrase, it is a scam.
- **Only pay through the link or QR code** the bot gives you. Never send tokens manually to any Cobrá contract
  address: they would be stuck there forever.
- **Double-check your receiving address** when you sign up. Payments go straight to it and cannot be reversed.
- Payments are capped at US$200 each and US$500 per day per merchant.

## What you need

| | |
| --- | --- |
| **Telegram** | On your phone or computer |
| **Wallet 1: merchant** | A Celo wallet that receives the money, e.g. [MiniPay](https://www.opera.com/products/minipay), [Valora](https://valora.xyz), or MetaMask with the Celo network. It does not need any balance. |
| **Wallet 2: customer** | A **different** wallet (Cobrá refuses payments from the merchant's own address) holding a few **USD₮ (Tether) on the Celo network**. About US$2 pays a R$10 invoice. You do **not** need CELO for fees. |

**Getting USD₮ on Celo:** buy it in MiniPay, or withdraw USD₮ from an exchange and **choose the Celo network** when
you withdraw. Check the network twice: sending on the wrong network can lose the funds.

USD₮ gets the best price in Brazil (~0.5–0.7% total cost, through Textile FX). USDC also works in Cobrá, but for wBRL it
currently goes through a thin Uniswap pool and may be refused.

---

## Part A — Sign up as a merchant (1 minute)

1. Open **https://t.me/cobra_agent_telegram_bot** and tap **Start**.
2. Choose **Brasil (BRL)**. You can switch the language with the **Português / English** buttons.
3. Paste the **public address of Wallet 1** (starts with `0x`). Check it character by character.
4. The bot confirms "You'll receive wBRL at 0x…" and sends your **fixed QR code** (customers scan it and type the
   amount themselves).
5. *(Optional)* Open the link the bot sends to **prove the wallet is yours** (one signature, no transaction).

## Part B — Create a payment request

Send the bot an amount and a description, the way you write numbers in Brazil:

```
cobrar 10 teste
```

`cobrar 10,50 café` and `cobrar 2 mil` work too. The bot answers with a **QR code**, a **payment link** and a
**Share on WhatsApp** button. The request is valid for **10 minutes**; the bot reminds you 3 minutes before it expires.

## Part C — Pay as the customer (with Wallet 2)

1. Open the payment link on the phone where Wallet 2 is installed:
   - **MiniPay**: open the link in MiniPay's browser, it connects by itself;
   - otherwise tap **Connect** (or **WalletConnect** to use a wallet on another device), then **Switch to Celo** if asked.
2. Check the receipt on the page:
   - **Merchant receives**: `10,00 wBRL` (digital reais, 1 wBRL = R$1)
   - **You pay**: about `1,85 USD₮` (digital dollars). The first quote can take a few seconds.
3. Tap **Pay** and **sign** in your wallet. It is **one signature**, not a transaction: no gas, nothing to approve.
4. Wait a few seconds: **Paying…** then **✓ Paid**, with a Celoscan link.

## Part D — Check the result

- **Telegram**: the bot sends **"Pagamento recebido!"** with the amount, the wBRL received and a Celoscan receipt link.
- **Wallet 1** now holds exactly **10 wBRL**.
- In the bot: `/faturas` (latest requests), `/fechamento` (today's summary + CSV, also sent automatically at 21:00),
  `/painel` (private web dashboard, link valid 15 minutes).
- Every payment is public on https://cobra-beige.vercel.app/proof.

You can also just write to the bot: *"o A-0001 foi pago?"*, *"cancela a última cobrança"*.

## Part E — Cash out to your bank (optional, not tested yet)

This part goes through **Ripio**, not Cobrá. We have **not tested it end to end yet**, so your feedback is very useful.

1. In the bot: `/sacar`. It sends a prefilled Ripio off-ramp link.
2. Ripio will ask you to sign up and verify your identity (**CPF**), and for a **Pix key** or bank account.
3. Ripio shows a **deposit address**: send your wBRL there **from your own wallet, on the Celo network**.
4. **Before sending**, check Ripio's minimum withdrawal: a few reais may be below it.

Cobrá never moves your funds: you send them yourself.

---

## If something goes wrong

| What you see | What to do |
| --- | --- |
| "Not enough balance" / "Pagar em reais" | Wallet 2 does not hold enough USD₮ on Celo. Add some, then tap **Try again**. |
| "Switch to Celo" | Your wallet is on another network: tap the button. |
| The request expired | Ask the bot for a new one (`cobrar …`). Nothing was charged. |
| Your wallet cannot sign | Some smart / delegated wallets are not supported yet. Try MiniPay, Valora or MetaMask. Nothing was charged. |
| The bot does not answer | Send `/start` again, or tell us. |

A failed payment never takes money: either the whole payment goes through, or nothing moves.

## What we would love to hear

- Was sign-up clear? Anything confusing in Portuguese?
- Was the amount in reais and what you pay in dollars clear on the payment page?
- How long did it take from "cobrar" to "Paid"?
- Would your customers be able to pay this way? What would stop them?
- If you tried Part E: Ripio's fees, minimum and how long the Pix took.
- What would make you use Cobrá for real?

Thank you! 🙏

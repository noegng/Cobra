# Cobrá — Set up a Celo wallet and add funds (Brazil)

This guide is for testers who have **never used a crypto wallet**. It takes about **10 minutes**, plus Ripio's
identity check the first time. When you are done, follow the [pilot test guide](brazil-test-guide.md).

> **Wallet choice still being confirmed.** We recommend **MiniPay** below; if it is not available in your app store,
> use **MetaMask** (section 1b). Tell us which one worked for you.

---

## Before you start: three rules

1. **Your recovery phrase (12 or 24 words) is the key to your money.** Write it on paper, keep it offline, and
   **never give it to anyone**: not to Cobrá, not to "support", not to a website. Anyone who has it can take your funds.
2. **Always use the Celo network.** Money sent on another network (Ethereum, Tron, BNB…) does not arrive and can be
   lost. Check the network every time you buy or withdraw.
3. **Start small**: 10 to 20 reais is enough for the whole pilot.

You need **two wallets** for the full test (a merchant cannot pay their own invoice): one to **receive** (merchant)
and one to **pay** (customer). Two phones, or two wallets in the same app, both work.

---

## Step 1 — Install a wallet

### 1a. MiniPay (recommended, check availability)

1. Install **MiniPay** from the [official page](https://www.opera.com/products/minipay) (Play Store / App Store),
   or open it inside the Opera Mini browser.
2. Create your account and follow the **backup** instructions carefully.
3. MiniPay is built for **Celo** and stablecoins, and Cobrá's payment page connects to it automatically. When you
   send money to it from somewhere else, the network must still be **Celo**.

### 1b. MetaMask (if MiniPay is not available)

1. Install **MetaMask** from [metamask.io](https://metamask.io) (official app only).
2. Create a new wallet and **write down the recovery phrase** on paper.
3. Add the **Celo** network: *Networks → Add network → Add manually*:

   | Field | Value |
   | --- | --- |
   | Network name | Celo |
   | RPC URL | `https://forno.celo.org` |
   | Chain ID | `42220` |
   | Currency symbol | `CELO` |
   | Block explorer | `https://celoscan.io` |

   (Cobrá's payment page also offers **Switch to Celo** when you connect.)
4. *(Optional)* So the balances show in MetaMask, *Import tokens* on Celo:
   - **wBRL** (digital real): `0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0`, 18 decimals
   - **USD₮** (digital dollar): `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e`, 6 decimals

## Step 2 — Find your address

Your **address** starts with `0x` and has 42 characters. It is public: you can share it to receive money.

- MiniPay: tap *Receive* / your account to copy it.
- MetaMask: tap the account name at the top to copy it.

Copy and paste it, **never type it by hand**. This is the address you give the Cobrá bot when you sign up as a merchant.

## Step 3 — Add funds to the customer wallet

Pick **one** of the two paths.

### Path A — In reais, with Pix (simplest)

You buy **wBRL** (1 wBRL = R$1) and pay the merchant directly in reais. No exchange rate, no conversion.

1. Open Ripio's ramp, prefilled for R$20 of wBRL on Celo:
   **https://ramp.ripio.com/?country=BR&chain=42220&token=WBRL&amount=20**
2. Paste the **address of your customer wallet** (Step 2) when asked.
3. Ripio asks you to sign up and verify your identity with your **CPF** (first time only).
4. Pay with **Pix**. The wBRL arrive in your wallet, on Celo.
5. **The first time you pay a Cobrá invoice in wBRL**, the page asks for a one-time **"Authorize wBRL"** step. If your
   wallet has no CELO for the network fee, Cobrá's agent sends you a little (0.05 CELO, automatically, once): just wait
   until the button is active. After that, every payment is a single signature.

> We have **not tested this Ripio purchase end to end yet**: please tell us how long it took, the fees, and any problem.
> Cobrá's payment page also shows a **"Pay in reais"** button that opens this same Ripio link, prefilled with the
> invoice amount, when your wallet balance is too low.

### Path B — In digital dollars (USD₮)

For people who already save in dollars. You pay with **USD₮**; Cobrá converts and the merchant still receives reais
(about 0.5–0.7% total cost).

- **In MiniPay**: use its *Add cash / Deposit* options, if available in Brazil.
- **From an exchange**: withdraw **USD₮ (Tether)** and, on the withdrawal screen, choose the **Celo network**. If Celo
  is not in the list, **do not withdraw**: that exchange cannot send to Celo.
- About **US$2** pays a R$10 invoice. You do **not** need CELO for fees: Cobrá pays them.

Prefer **USD₮** over USDC for Brazil: it gets the best price. USDC can be refused for wBRL payments for now.

## Step 4 — Check, then start the pilot

- Your customer wallet shows **wBRL** (path A) or **USD₮** (path B) on **Celo**.
- You can also paste your address on [celoscan.io](https://celoscan.io) to see the balances.
- Now open the **[pilot test guide](brazil-test-guide.md)** and sign up as a merchant with the *other* wallet.

---

## Common problems

| Problem | What to do |
| --- | --- |
| I sent funds but they do not show | Check you used the **Celo** network and the right address on celoscan.io. In MetaMask, import the token (Step 1b.4). |
| The exchange does not offer the Celo network | Do not withdraw from it. Use path A (Pix) or MiniPay. |
| "Authorize wBRL" stays greyed out | Cobrá's agent is sending you a little CELO for the fee: wait up to a minute. |
| Ripio refuses my verification | That is on Ripio's side: try path B, and tell us what happened. |
| I lost my recovery phrase | Funds cannot be recovered without it. That is why we test with small amounts only. |

**Never** share your recovery phrase. Cobrá, Ripio and real support teams will never ask for it.

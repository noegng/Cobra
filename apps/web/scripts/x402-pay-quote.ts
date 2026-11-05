/**
 * Pays ONE call of the x402 FX quote endpoint, like any agent would. Run by a HUMAN (it signs with your key).
 *
 *   read -s X402_PAYER_KEY && export X402_PAYER_KEY     # paste the key of a small burner wallet, not shown
 *   pnpm x402:pay                                       # defaults: ARS 4500, pays in USDC, production URL
 *   pnpm x402:pay -- --currency BRL --amount 50 --asset USDT --url https://cobra-beige.vercel.app
 *
 * The wallet needs at least 0.001 USDC (or USD₮). No CELO needed: the signature is gasless (EIP-3009) and Celo's
 * facilitator submits the transfer. Refuses to sign anything above 0.01 USD.
 */
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { getAddress, isHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { explorerTx, tokenBySymbol } from "@cobra/shared";

const MAX_UNITS = 10_000n; // 0.01 USD (6 decimals)

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

async function main(): Promise<number> {
  const key = process.env.X402_PAYER_KEY?.trim();
  if (!key || !isHex(key) || key.length !== 66) {
    console.error("Set X402_PAYER_KEY (0x + 64 hex) in your shell first: read -s X402_PAYER_KEY && export X402_PAYER_KEY");
    return 2;
  }
  const account = privateKeyToAccount(key);
  const base = arg("url", "https://cobra-beige.vercel.app").replace(/\/+$/, "");
  const url = `${base}/api/x402/fx-quote?currency=${encodeURIComponent(arg("currency", "ARS"))}&amount=${encodeURIComponent(arg("amount", "4500"))}`;
  const asset = tokenBySymbol(arg("asset", "USDC").toUpperCase() === "USDT" ? "USDT" : "USDC")!;

  const client = new x402Client((_v, reqs) => {
    const r = reqs.find((q) => getAddress(q.asset) === asset.address);
    if (!r) throw new Error(`endpoint does not accept ${asset.symbol}`);
    if (BigInt(r.amount) > MAX_UNITS) throw new Error(`price ${r.amount} above the 0.01 USD safety cap`);
    return r;
  }).register("eip155:42220", new ExactEvmScheme(account));
  const http = new x402HTTPClient(client);

  console.log(`payer ${account.address}, paying in ${asset.symbol}\nGET ${url}`);
  const first = await fetch(url);
  if (first.status !== 402) {
    console.error(`expected 402, got ${first.status}: ${await first.text()}`);
    return 1;
  }
  const required = http.getPaymentRequiredResponse((h) => first.headers.get(h), await first.json().catch(() => undefined));
  const headers = http.encodePaymentSignatureHeader(await http.createPaymentPayload(required));
  const paid = await fetch(url, { headers });
  const text = await paid.text();
  console.log(`status ${paid.status}`);
  console.log(text);
  if (paid.ok) {
    const s = http.getPaymentSettleResponse((h) => paid.headers.get(h));
    console.log(`settled: ${s.success}  tx ${explorerTx(s.transaction)}`);
  }
  return paid.ok ? 0 : 1;
}

main()
  .then((c) => process.exit(c))
  .catch((e) => {
    console.error(String((e as Error).message ?? e));
    process.exit(1);
  });

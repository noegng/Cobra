/**
 * Pushes the bot's command menus (es default, pt, en) to Telegram with setMyCommands, then reads them back.
 * Run once after a deploy that changes COMMANDS / the menus:
 *   TELEGRAM_BOT_TOKEN=… pnpm bot:commands
 * Touches only the Telegram bot profile (no database, no chain). The token is never printed: grammY puts it in
 * the request URL of its errors, so every error message is redacted before it is shown.
 */
import { Api } from "grammy";
import { registerBotCommands } from "../src/bot";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is not set");
  process.exit(1);
}

const redact = (s: string) => s.split(token).join("<token>").replace(/bot\d+:[\w-]{30,}/g, "bot<token>");

async function main(api: Api) {
  const me = await api.getMe();
  await registerBotCommands(api);
  console.log(`@${me.username}: command menus updated`);
  for (const lang of [undefined, "pt", "en"] as const) {
    const cmds = await api.getMyCommands(lang ? { language_code: lang } : {});
    console.log(`  ${lang ?? "default (es)"}: ${cmds.map((c) => `/${c.command}`).join(" ")}`);
  }
}

main(new Api(token)).catch((e: unknown) => {
  const err = e as { message?: string; error?: { message?: string; code?: string } };
  const cause = err.error ? ` (${err.error.code ?? ""} ${err.error.message ?? ""})` : "";
  console.error(redact(`failed: ${err.message ?? String(e)}${cause}`));
  process.exit(1);
});

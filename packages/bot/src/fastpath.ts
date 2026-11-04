/**
 * Fast path: "cobrar <amount> <description>" (and /cobrar, cobrá, /charge, charge) is handled with a regex and
 * the deterministic amount parser — no LLM call at all.
 */
const TRIGGER = /^\/?(?:cobrar|cobr[aá]|charge)(?:@\w+)?(?:\s+([\s\S]*))?$/i;

const SPACE = "[ \\u00a0\\u202f]";
const AMOUNT_TOKEN = new RegExp(
  "^(" +
    "(?<pre>(?:r\\$|ar\\$|mx\\$|s\\/|\\$|ars|brl|mxn|cop|clp|pen|us\\$|usd)\\s*)?" + // optional currency marker
    `(?:\\d{1,3}(?:${SPACE}\\d{3})+(?:[.,]\\d+)?(?=\\s|$)|\\d(?:[\\d.,]*\\d)?)` + // space-grouped or compact number
    "(?:\\s*mil(?![a-zà-ÿ]))?" + // "2 mil" (not "milanesa")
    "(?<word>\\s*(?:pesos?|reais|real|soles?|ars|brl|usd|d[oó]lares?)(?![a-zà-ÿ]))?" + // optional currency word
    ")",
  "i",
);
const SPACE_GROUPED = new RegExp(`\\d${SPACE}\\d`);

export interface ChargeMatch {
  /** Raw amount text, to be parsed by parseAmount. */
  amountText: string;
  description: string;
  /**
   * "cobrar 4 500 café": a space-grouped number with no currency marker, followed by a description. It reads as
   * 4500 *or* as 4 + "500 café" (and "cobrar 500 100 gramos" as 500100): the bot asks instead of guessing.
   * Unambiguous forms: "$ 4 500 café", "4 500 pesos café", "4500 café", or "cobrar 4 500" alone.
   */
  spaceAmbiguous?: true;
}

/**
 * Returns:
 *  - null: not a charge command (route elsewhere);
 *  - { amountText: "" }: trigger without amount (reply usage);
 *  - { amountText, description }: candidate charge.
 * If the text after the trigger does not start with a number, returns null so the LLM can interpret it.
 */
export function matchCharge(text: string): ChargeMatch | null {
  const m = TRIGGER.exec(text.trim());
  if (!m) return null;
  const rest = (m[1] ?? "").trim();
  if (rest === "") return { amountText: "", description: "" };
  const a = AMOUNT_TOKEN.exec(rest);
  if (!a) return null;
  const amountText = a[1]!.trim();
  const description = rest
    .slice(a[0].length)
    .replace(/^[\s,.:;\-–—]+/, "")
    .trim();
  const marked = !!(a.groups?.pre || a.groups?.word);
  if (!marked && description !== "" && SPACE_GROUPED.test(amountText)) return { amountText, description, spaceAmbiguous: true };
  return { amountText, description };
}

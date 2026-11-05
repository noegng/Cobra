/**
 * Link-preview image (og:image, reused as twitter:image by Next): a static brand card rendered at build time with
 * next/og (bundled with Next, no extra dependency). Plain text, no UI screenshot, so it never shows stale wording.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

export const alt = "Cobrá: get paid with a QR and receive the exact amount in your own currency, on Celo";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Dark theme tokens from globals.css.
const BG = "#0d0f0e";
const FG = "#edede6";
const SUB = "#9ca29b";
const ACCENT = "#3ddc84";

export default async function Image() {
  const logo = await readFile(join(process.cwd(), "public", "logo-512.png"));
  const logoSrc = `data:image/png;base64,${logo.toString("base64")}`;
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "64px 72px", background: BG, color: FG }}>
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={logoSrc} width={72} height={72} alt="" />
          <span style={{ fontSize: 44, fontWeight: 700 }}>Cobrá</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span style={{ fontSize: 76, fontWeight: 700, lineHeight: 1.05 }}>Get paid with a QR.</span>
          <span style={{ fontSize: 76, fontWeight: 700, lineHeight: 1.05, color: ACCENT }}>Receive the exact amount.</span>
        </div>
        <div style={{ display: "flex", fontSize: 28, color: SUB }}>
          Celo checkout for Latin American merchants · wARS · wBRL · one signature
        </div>
      </div>
    ),
    size,
  );
}

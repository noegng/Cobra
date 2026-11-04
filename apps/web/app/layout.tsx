import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { JetBrains_Mono, Space_Grotesk } from "next/font/google";
import { requestLanguage } from "../lib/server/lang";
import { THEME_COOKIE } from "../lib/theme";
import "./globals.css";

// Self-hosted at build time by next/font (no request to Google from the browser).
const display = Space_Grotesk({ subsets: ["latin", "latin-ext"], variable: "--font-display-loaded", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin", "latin-ext"], variable: "--font-mono-loaded", display: "swap" });

export const metadata: Metadata = {
  title: "Cobrá",
  description: "Pagos en Celo con una sola firma",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f4ee" },
    { media: "(prefers-color-scheme: dark)", color: "#0d0f0e" },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [lang, jar] = await Promise.all([requestLanguage(), cookies()]);
  const t = jar.get(THEME_COOKIE)?.value;
  const theme = t === "light" || t === "dark" ? t : undefined;
  return (
    <html lang={lang} data-theme={theme} className={`${display.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}

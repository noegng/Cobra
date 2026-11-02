import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { requestLanguage } from "../lib/server/lang";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cobrá",
  description: "Pagos en Celo con una sola firma",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0f5132",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const lang = await requestLanguage();
  return (
    <html lang={lang}>
      <body>{children}</body>
    </html>
  );
}

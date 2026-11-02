"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { http, createConfig, WagmiProvider } from "wagmi";
import { celo } from "wagmi/chains";
import { injected, walletConnect } from "wagmi/connectors";

function makeConfig() {
  const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
  const origin = typeof window !== "undefined" ? window.location.origin : "https://cobra.example";
  return createConfig({
    chains: [celo],
    ssr: true,
    // MiniPay / Valora / MetaMask in-app browsers inject window.ethereum: injected first.
    connectors: [
      injected({ shimDisconnect: true }),
      ...(projectId
        ? [
            walletConnect({
              projectId,
              showQrModal: true,
              metadata: { name: "Cobrá", description: "Pagos en Celo", url: origin, icons: [`${origin}/icon.svg`] },
            }),
          ]
        : []),
    ],
    transports: { [celo.id]: http(process.env.NEXT_PUBLIC_RPC_URL || undefined) },
  });
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [config] = useState(makeConfig);
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1 } } }));
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}

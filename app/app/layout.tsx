import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import Providers from "./providers";
import Header from "@/components/Header";
import HelperWidget from "@/components/HelperWidget";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "GoHealthMe",
  description:
    "Set a health goal, a sponsor puts up the USDC, and an agent named SPOTTER verifies it and pays you the moment it can prove you did it.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        <Providers>
          <Header />
          <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
            {children}
          </main>
          <footer className="border-t border-edge px-4 py-6 text-center text-xs text-muted">
            <p>
              GoHealthMe — settled by SPOTTER on Arc testnet. Your health data
              never touches the chain.
            </p>
            <nav className="mt-2 flex items-center justify-center gap-4">
              <Link href="/privacy" className="hover:text-foreground hover:underline">
                Privacy
              </Link>
              <Link href="/terms" className="hover:text-foreground hover:underline">
                Terms
              </Link>
            </nav>
          </footer>
          <HelperWidget />
        </Providers>
      </body>
    </html>
  );
}

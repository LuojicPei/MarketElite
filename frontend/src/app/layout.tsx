import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "MarketElite | US Equity Multi-Agent Risk & Market Structure Terminal",
  description:
    "Institutional US market structure cockpit, autonomous investigation, adversarial risk control, and closed-loop post-trade evaluation.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className={`${inter.variable} ${jetbrainsMono.variable} dark`}>
      <body className="terminal-backdrop min-h-screen font-sans selection:bg-sky-500/30 selection:text-sky-100">
        {children}
      </body>
    </html>
  );
}

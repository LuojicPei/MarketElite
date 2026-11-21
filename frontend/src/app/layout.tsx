import type { Metadata } from "next";
import { Instrument_Serif, Inter, JetBrains_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/ThemeProvider";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const instrumentSerif = Instrument_Serif({
  weight: "400",
  style: ["normal", "italic"],
  subsets: ["latin"],
  variable: "--font-instrument-serif",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "MarketElite | US Equity Structure & Multi-Agent Risk Terminal",
  description:
    "Dual-theme Alabaster & Obsidian Velvet US equity structure cockpit, autonomous investigation, and adversarial risk control.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="zh-CN"
      suppressHydrationWarning
      className={`${inter.variable} ${instrumentSerif.variable} ${jetbrainsMono.variable}`}
    >
      <body className="silk-velvet-backdrop min-h-screen font-sans transition-colors duration-150 selection:bg-zinc-900 selection:text-white dark:selection:bg-white dark:selection:text-zinc-950">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}

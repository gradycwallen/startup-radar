import type { Metadata } from "next";
import Script from "next/script";
import { Inter, Instrument_Serif, JetBrains_Mono } from "next/font/google";
import { SiteHeader } from "@/components/layout/site-header";
import { SiteFooter } from "@/components/layout/site-footer";
import { themeInitScript } from "@/lib/theme/theme-script";
import "./globals.css";

// Matches gradyallen.com's type system (editorial-personal-site-match branch): Inter for body/UI,
// Instrument Serif for display headings (italics used sparingly, for emphasis on one word at a
// time, not as a default style).
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument-serif",
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  display: "swap",
});

// Mono for terminal-shaped text (labels, counts, metadata) — the homepage hero's prompt line.
const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Startup Radar",
    template: "%s · Startup Radar",
  },
  description: "Discovery intelligence for emerging startups, before they're obvious.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" suppressHydrationWarning className={`${inter.variable} ${instrumentSerif.variable} ${jetbrainsMono.variable} h-full`}>
      <body className="flex min-h-full flex-col bg-canvas font-sans text-ink antialiased">
        <Script id="theme-init" strategy="beforeInteractive">{themeInitScript()}</Script>
        <SiteHeader />
        <div className="flex-1">{children}</div>
        <SiteFooter />
      </body>
    </html>
  );
}

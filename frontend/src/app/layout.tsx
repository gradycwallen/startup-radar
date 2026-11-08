import type { Metadata } from "next";
import Script from "next/script";
import { Public_Sans, Newsreader, JetBrains_Mono } from "next/font/google";
import { SiteHeader } from "@/components/layout/site-header";
import { SiteFooter } from "@/components/layout/site-footer";
import { themeInitScript } from "@/lib/theme/theme-script";
import "./globals.css";

// Public Sans, not Inter — Inter is the de facto default of every AI-scaffolded/shadcn template,
// and that association alone reads as "generated" regardless of the rest of the palette. Public
// Sans has more character at display sizes while staying just as neutral for body copy.
const publicSans = Public_Sans({
  variable: "--font-public-sans",
  subsets: ["latin"],
  display: "swap",
});

const newsreader = Newsreader({
  variable: "--font-newsreader",
  subsets: ["latin"],
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
    <html lang="en" suppressHydrationWarning className={`${publicSans.variable} ${newsreader.variable} ${jetbrainsMono.variable} h-full`}>
      <body className="flex min-h-full flex-col bg-canvas font-sans text-ink antialiased">
        <Script id="theme-init" strategy="beforeInteractive">{themeInitScript()}</Script>
        <SiteHeader />
        <div className="flex-1">{children}</div>
        <SiteFooter />
      </body>
    </html>
  );
}

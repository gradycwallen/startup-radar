/** Section/page kicker in the homepage hero's terminal voice: a mono label behind a faint `>`
 * prompt. `tone="hero"` is for the fixed-dark banners (PageBanner, HomeIntro's palette), which
 * don't follow the light/dark tokens. */
export function Eyebrow({ children, tone = "page", className = "" }: { children: React.ReactNode; tone?: "page" | "hero"; className?: string }) {
  const color = tone === "hero" ? "text-[#8fd8ff]" : "text-accent";
  const prompt = tone === "hero" ? "text-[#5b6472]" : "text-ink-faint";
  return (
    <p className={`font-mono text-xs uppercase tracking-[0.18em] ${color} ${className}`}>
      <span aria-hidden className={`mr-2 ${prompt}`}>
        &gt;
      </span>
      {children}
    </p>
  );
}

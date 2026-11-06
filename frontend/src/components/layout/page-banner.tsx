import { MatrixField } from "@/components/intro/matrix-field";
import { Eyebrow } from "@/components/ui/eyebrow";

/**
 * A short, full-bleed version of the homepage's terminal hero for inner pages (Explore,
 * Methodology): the same pointer-reactive character field and fixed near-black palette, so every
 * page opens in the same room the homepage does. Like the hero, it deliberately ignores the
 * light/dark tokens.
 */
export function PageBanner({ eyebrow, title, children }: { eyebrow: string; title: string; children?: React.ReactNode }) {
  return (
    <section className="relative overflow-hidden border-b border-[#161c24] bg-[#06080b]">
      <MatrixField />
      {/* Fade the field out toward the copy so the text never sits on busy glyphs. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-r from-[#06080b]/90 via-[#06080b]/55 to-transparent" />
      <div className="stagger pointer-events-none relative mx-auto max-w-7xl px-6 py-14 sm:px-8 sm:py-20">
        <Eyebrow tone="hero">{eyebrow}</Eyebrow>
        <h1 className="mt-4 max-w-3xl font-serif text-4xl leading-[1.05] tracking-tight text-white sm:text-6xl">{title}</h1>
        {children ? <div className="mt-5 max-w-2xl text-base leading-relaxed text-[#aab2bd] sm:text-lg">{children}</div> : null}
      </div>
    </section>
  );
}

"use client";

import { useEffect, useRef } from "react";

const BLIPS = [
  { top: 26, left: 64, delay: 0 },
  { top: 68, left: 70, delay: 0.7 },
  { top: 40, left: 28, delay: 1.4 },
  { top: 76, left: 42, delay: 2.1 },
  { top: 20, left: 38, delay: 2.8 },
] as const;

/**
 * A full-viewport cover in front of the Radar feed's real content — not a one-shot animation.
 * Its reveal is driven directly by live scroll position (see the handler below), so scrolling
 * back up to the top always returns to it; nothing here "plays once" or needs a replay control.
 *
 * Mechanics: a tall (200svh) wrapper holds a `position: sticky` panel pinned just below the
 * masthead. For the first ~100svh of scroll the panel stays pinned while its own opacity/scale
 * track scroll progress; past that point it naturally unsticks and scrolls away with normal
 * document flow — no JS needed for the exit itself, which is what makes the reverse (scrolling
 * back up) work for free instead of needing a second, hand-written animation.
 *
 * `svh` (small viewport height), not `vh`: on mobile, `vh` includes the address bar's height and
 * jumps as it hides/shows while scrolling, which would make a pinned full-height panel jitter.
 */
export function RadarIntro() {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf = 0;
    function update() {
      raf = 0;
      const wrapper = wrapperRef.current;
      const panel = panelRef.current;
      if (!wrapper || !panel) return;
      // The panel is pinned (position: sticky) for roughly the first half of the wrapper's
      // height, then unsticks and scrolls away with it for the rest — so the progress driving
      // the fade must span the WRAPPER's full height, not just the pinned phase. Using a shorter
      // denominator (e.g. one viewport height) makes the panel hit opacity 0 while it's still
      // pinned on screen, then sit there fully invisible — but still blocking the view — for a
      // whole extra screen of scrolling before the real content finally appears. Found in review.
      const total = wrapper.offsetHeight;
      const progress = total > 0 ? Math.min(1, Math.max(0, window.scrollY / total)) : 1;
      panel.style.opacity = String(1 - progress);
      panel.style.transform = `scale(${1 - progress * 0.06}) translateY(${progress * -28}px)`;
    }
    function onScroll() {
      if (!raf) raf = requestAnimationFrame(update);
    }
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div ref={wrapperRef} className="relative h-[200svh]">
      <div
        ref={panelRef}
        className="sticky top-16 flex h-[calc(100svh-4rem)] flex-col items-center justify-center overflow-hidden bg-canvas px-6 text-center sm:top-20 sm:h-[calc(100svh-5rem)]"
      >
        <RadarScope />
        <div className="relative">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-accent">Startup Radar</p>
          <p className="mt-4 font-serif text-5xl leading-[1.05] tracking-tight text-ink sm:text-7xl">
            Startups, found
            <br />
            before they&rsquo;re obvious.
          </p>
          <p className="mx-auto mt-6 max-w-md text-base text-ink-muted sm:text-lg">
            A live radar over funding rounds, stealth launches and accelerator cohorts — surfaced by evidence, never a guess.
          </p>
        </div>
        <ScrollCue />
      </div>
    </div>
  );
}

function RadarScope() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <div className="relative h-[480px] w-[480px] sm:h-[640px] sm:w-[640px]">
        {[1, 0.72, 0.44].map((scale) => (
          <span
            key={scale}
            className="absolute inset-0 m-auto rounded-full border border-line-strong/70"
            style={{ width: `${scale * 100}%`, height: `${scale * 100}%` }}
          />
        ))}
        <div className="absolute inset-0 overflow-hidden rounded-full opacity-70">
          <div className="radar-sweep h-full w-full" />
        </div>
        {BLIPS.map((b) => (
          <span
            key={`${b.top}-${b.left}`}
            className="radar-blip absolute h-1.5 w-1.5 rounded-full bg-accent"
            style={{ top: `${b.top}%`, left: `${b.left}%`, animationDelay: `${b.delay}s` }}
          />
        ))}
      </div>
    </div>
  );
}

function ScrollCue() {
  return (
    <div className="scroll-cue absolute bottom-10 flex flex-col items-center gap-2 text-ink-faint">
      <span className="text-[11px] font-semibold uppercase tracking-[0.2em]">Scroll</span>
      <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4">
        <path d="M3 6L8 11L13 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </svg>
    </div>
  );
}

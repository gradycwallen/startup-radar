"use client";

import { useEffect, useRef, useState } from "react";
import { MatrixField } from "./matrix-field";

/**
 * The homepage's scroll-revealed cover. Deliberately its own fixed dark palette rather than the
 * site's light/dark theme tokens — a near-black "terminal" hero is the whole point of the brief
 * this was built to (a pointer-reactive character field, in the spirit of Claude Code's own idle
 * background), and it wouldn't read the same way re-skinned for light mode. The rest of the site
 * (Explore, Company Detail, and everything below this cover) is unaffected and still follows the
 * user's light/dark choice as before.
 *
 * Reveal mechanics unchanged from the previous version: a tall (200svh) wrapper holds a
 * `position: sticky` panel pinned just below the masthead. Scrolling fades/scales it based on live
 * scroll position (not a one-shot animation), so scrolling back up to the top always returns to
 * it. `svh`, not `vh`, so a mobile browser's address bar hiding/showing doesn't jitter the pinned
 * height.
 */
export function HomeIntro({ totalCount }: { totalCount: number }) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf = 0;
    function update() {
      raf = 0;
      const wrapper = wrapperRef.current;
      const panel = panelRef.current;
      if (!wrapper || !panel) return;
      // Progress must span the WRAPPER's full height, not just the panel's pinned phase — see
      // the git history for why a shorter denominator leaves a stretch where the panel is already
      // invisible but still blocking the view before real content appears.
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
        className="sticky top-16 flex h-[calc(100svh-4rem)] flex-col items-center justify-center overflow-hidden bg-[#06080b] px-6 text-center sm:top-20 sm:h-[calc(100svh-5rem)]"
      >
        <MatrixField />

        {/* pointer-events-none: nothing in here is interactive, and without this the text's own
            box (wider than it looks, since the flex column sizes to its content) was stealing
            pointermove events the canvas needs — found in review as a dead zone where the
            brightening effect silently stopped following the cursor under the copy. */}
        <div className="pointer-events-none relative z-10 max-w-xl">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-[#8fd8ff]">Startup Radar</p>
          <p className="mt-4 font-serif text-5xl leading-[1.05] tracking-tight text-white sm:text-7xl">
            Startups, found
            <br />
            before they&rsquo;re obvious.
          </p>
          <p className="mx-auto mt-6 max-w-md text-base text-[#aab2bd] sm:text-lg">
            Deterministic discovery intelligence for emerging startups — ranked by evidence, not hype.
          </p>
          <LiveStat total={totalCount} />
        </div>

        <ScrollCue />
      </div>
    </div>
  );
}

/** A terminal-prompt-styled stat line, not a dashboard numeral — keeps the hero simple (one real
 * fact, not a panel of them) while still making a claim the real stat strip below confirms rather
 * than contradicts: same `companies.length` the page passes everywhere else. Counts up on mount;
 * snaps straight to the final value under prefers-reduced-motion by giving the single tick a
 * zero-length duration rather than a separate synchronous setState branch (keeps every setValue
 * call inside the rAF callback, never directly in the effect body). */
function LiveStat({ total }: { total: number }) {
  const [value, setValue] = useState(0);

  useEffect(() => {
    if (total <= 0) return;
    const durationMs = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 1100;
    let raf = 0;
    const start = performance.now();
    function tick(now: number) {
      const t = durationMs === 0 ? 1 : Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(eased * total));
      if (t < 1) raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [total]);

  return (
    <p className="tabular mt-8 inline-flex items-center gap-2 font-mono text-sm text-[#8fd8ff]">
      <span aria-hidden className="text-[#5b6472]">
        &gt;
      </span>
      tracking {value} companies
      <span aria-hidden className="matrix-caret inline-block h-[1em] w-[0.5em] translate-y-[1px] bg-[#8fd8ff]" />
    </p>
  );
}

function ScrollCue() {
  return (
    <div className="scroll-cue pointer-events-none absolute bottom-10 z-10 flex flex-col items-center gap-2 text-[#5b6472]">
      <span className="text-[11px] font-semibold uppercase tracking-[0.2em]">Scroll</span>
      <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4">
        <path d="M3 6L8 11L13 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </svg>
    </div>
  );
}

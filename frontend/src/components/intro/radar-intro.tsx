"use client";

import { useEffect, useRef, useState } from "react";

export interface IntroSignal {
  name: string;
  domain: string;
}

// Six fixed slots around the ring, chosen to sit in the corners/sides rather than behind the
// centered text block — not trigonometry, just hand-placed points that read well at this circle
// size. A company maps to a slot by index, so the layout is deterministic (no hydration mismatch,
// no layout shift) even though which company lands in which slot changes with the real data.
const BLIP_SLOTS = [
  { top: 26, left: 64 },
  { top: 68, left: 70 },
  { top: 40, left: 28 },
  { top: 76, left: 42 },
  { top: 20, left: 38 },
  { top: 58, left: 14 },
] as const;

/**
 * A full-viewport cover in front of the Radar feed's real content — not a one-shot animation, and
 * not decorative-for-its-own-sake: everything it shows is real data from the same query the feed
 * below renders, so it functions as a live preview of the scan rather than an arbitrary mood
 * piece. `topSignals` are the same top-Momentum companies (see app/page.tsx) that lead the actual
 * feed, cycled through a "detected" readout; `totalCount` is the same number the real stat strip
 * shows below — scrolling past this cover into the feed shows exactly what it just claimed.
 *
 * Reveal mechanics: a tall (200svh) wrapper holds a `position: sticky` panel pinned just below the
 * masthead. Scrolling fades/scales it based on live scroll position (not a one-shot animation), so
 * scrolling back up to the top always returns to it; nothing here "plays once" or needs a replay
 * control. `svh` (small viewport height), not `vh`, so a mobile browser's address bar hiding/
 * showing doesn't jitter the pinned height.
 */
export function RadarIntro({ topSignals, totalCount }: { topSignals: IntroSignal[]; totalCount: number }) {
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
        <RadarScope signals={topSignals} />
        <div className="relative">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-accent">Startup Radar</p>
          <p className="mt-4 font-serif text-5xl leading-[1.05] tracking-tight text-ink sm:text-7xl">
            Startups, found
            <br />
            before they&rsquo;re obvious.
          </p>
          <p className="mx-auto mt-6 max-w-md text-base text-ink-muted sm:text-lg">
            Scout is scanning funding rounds, stealth launches and accelerator cohorts right now.
          </p>
          <DetectionReadout signals={topSignals} />
          <LiveCount total={totalCount} />
        </div>
        <ScrollCue />
      </div>
    </div>
  );
}

function RadarScope({ signals }: { signals: IntroSignal[] }) {
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
        {signals.map((s, i) => {
          const slot = BLIP_SLOTS[i % BLIP_SLOTS.length];
          return (
            <span
              key={s.domain}
              className="radar-blip absolute h-1.5 w-1.5 rounded-full bg-accent"
              style={{ top: `${slot.top}%`, left: `${slot.left}%`, animationDelay: `${i * 0.7}s` }}
            />
          );
        })}
      </div>
    </div>
  );
}

/** A single-line "detected" readout cycling through the real top-momentum companies passed in —
 * the thing that gives the radar motif an actual job: it's showing real signal, not scenery. One
 * name at a time (not all of them at once) avoids overlapping labels; the fade is a CSS animation
 * restarted by mounting a fresh element on each cycle (`key={current.domain}`), not a JS-driven
 * opacity loop. Respects prefers-reduced-motion by simply not cycling — the first company stays
 * put, still real data, just not animated. */
function DetectionReadout({ signals }: { signals: IntroSignal[] }) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (signals.length <= 1) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % signals.length), 2200);
    return () => clearInterval(id);
  }, [signals.length]);

  if (signals.length === 0) return null;
  const current = signals[index];

  return (
    <div className="mt-5 flex items-center justify-center gap-2 text-sm">
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
      <span className="font-semibold uppercase tracking-[0.15em] text-ink-faint">Detected</span>
      <span key={current.domain} className="hud-fade max-w-[14rem] truncate font-medium text-ink">
        {current.name}
      </span>
    </div>
  );
}

/** Counts up to the exact number the real stat strip shows after scrolling (app/page.tsx passes
 * the same `companies.length`) — styled to visually rhyme with that stat, so the number you see
 * here is confirmed, not contradicted, once the feed appears. Snaps straight to the final value
 * under prefers-reduced-motion rather than animating. */
function LiveCount({ total }: { total: number }) {
  const [value, setValue] = useState(0);

  useEffect(() => {
    if (total <= 0) return;
    // durationMs 0 under reduced motion, rather than a separate synchronous setValue(total)
    // branch: setState still only ever happens inside the rAF callback below, never directly in
    // the effect body itself — the first (and here, only) tick just lands exactly on `total`.
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
    <div className="mt-7">
      <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-faint">Companies on the radar</p>
      <p className="tabular mt-1 font-serif text-4xl text-ink sm:text-5xl">{value}</p>
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

"use client";

import { useEffect, useRef, useState } from "react";

/** A number that counts up from 0 the first time it scrolls into view — same easing and
 * reduced-motion handling as the hero's LiveStat. Renders the final value on the server, so the
 * real figure is always in the HTML and nothing reads "0" without JS. */
export function CountUp({ value, durationMs = 1100 }: { value: number; durationMs?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(value);

  useEffect(() => {
    const el = ref.current;
    if (!el || value <= 0 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    const observer = new IntersectionObserver(([entry]) => {
      // Still below the fold on the first callback: park at 0 so the count-up is what they see.
      if (!entry?.isIntersecting) return setShown(0);
      observer.disconnect();
      const start = performance.now();
      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / durationMs);
        setShown(Math.round((1 - Math.pow(1 - t, 3)) * value));
        if (t < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [value, durationMs]);

  return <span ref={ref}>{shown}</span>;
}

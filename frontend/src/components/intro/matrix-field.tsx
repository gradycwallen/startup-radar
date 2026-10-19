"use client";

import { useEffect, useRef } from "react";

const CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const CELL = 16; // px per grid cell
const RADIUS = 170; // px, pointer influence radius
const DECAY = 0.9; // heat multiplier per frame — controls fade-out speed
const LAG = 0.08; // pointer-follow smoothing — gives the "slight lag"
const AMBIENT_FRACTION = 0.0006; // fraction of cells whose glyph re-randomizes per frame

function randomChar() {
  return CHARSET[(Math.random() * CHARSET.length) | 0];
}

/**
 * Full-bleed, pointer-reactive character grid — the homepage hero's background (reference: the
 * Claude Code desktop app's own idle background). Canvas, not a grid of DOM `<span>`s: a few
 * thousand text nodes re-rendered on every pointer move would be far too slow. Canvas redrawing
 * the same cells every frame is the standard, cheap way to do this.
 *
 * Every cell keeps a `heat` value (0–1). Each frame: all cells decay a little (`* DECAY`), then
 * cells within `RADIUS` of the pointer — itself eased toward the real cursor, not snapped to it,
 * for the "slight lag" — get bumped up by distance falloff. That's the whole mechanic: "the bright
 * patch follows the pointer" and "fades smoothly after it leaves" fall out of the same per-frame
 * update rather than two separately-coded behaviors, so it's correct by construction in both
 * directions (no separate fade-out animation to get out of sync with the follow animation).
 *
 * Respects prefers-reduced-motion: draws a single static frame (a few pre-lit cells for texture,
 * no pointer reactivity, no loop) instead of animating.
 */
export function MatrixField() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvasEl = canvasRef.current;
    const ctxEl = canvasEl?.getContext("2d");
    if (!canvasEl || !ctxEl) return;
    // Rebind to explicitly non-nullable types: the nested closures below (resize/frame) outlive
    // this line, and TS doesn't carry the `if` guard's narrowing into a closure defined later in
    // the same scope — an explicit non-nullable type annotation sidesteps that entirely, since
    // there's no narrowing to lose in the first place.
    const canvas: HTMLCanvasElement = canvasEl;
    const ctx: CanvasRenderingContext2D = ctxEl;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);

    let cols = 0;
    let rows = 0;
    let chars: string[] = [];
    let heat = new Float32Array(0);
    let tint = new Float32Array(0);

    function resize() {
      const parent = canvas.parentElement;
      const width = parent ? parent.clientWidth : window.innerWidth;
      const height = parent ? parent.clientHeight : window.innerHeight;
      canvas.width = Math.ceil(width * dpr);
      canvas.height = Math.ceil(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      cols = Math.ceil(width / CELL) + 1;
      rows = Math.ceil(height / CELL) + 1;
      const total = cols * rows;
      chars = new Array(total);
      heat = new Float32Array(total);
      tint = new Float32Array(total);
      for (let i = 0; i < total; i++) {
        chars[i] = randomChar();
        tint[i] = Math.random();
        if (reduced && Math.random() < 0.02) heat[i] = Math.random() * 0.5;
      }
    }

    resize();
    window.addEventListener("resize", resize);
    // A mobile browser's address bar hiding/showing, or `100svh` simply not having resolved yet
    // on the very first layout pass, changes the panel's actual size without firing a `window`
    // resize event — observing the parent element directly catches those too.
    const observer = new ResizeObserver(() => resize());
    if (canvas.parentElement) observer.observe(canvas.parentElement);

    const pointer = { x: -9999, y: -9999, active: false };
    const lagged = { x: -9999, y: -9999 };

    function onPointerMove(e: PointerEvent) {
      const rect = canvas.getBoundingClientRect();
      pointer.x = e.clientX - rect.left;
      pointer.y = e.clientY - rect.top;
      pointer.active = true;
    }
    function onPointerLeave() {
      pointer.active = false;
    }
    if (!reduced) {
      canvas.addEventListener("pointermove", onPointerMove);
      canvas.addEventListener("pointerleave", onPointerLeave);
    }

    // h: current heat (0–1). t: a fixed per-cell bias toward cyan (most cells), electric blue, or
    // (rarely) white — assigned once at resize so each cell's color identity stays stable.
    function colorFor(h: number, t: number): string {
      const clamped = Math.min(1, h);
      const r0 = 92, g0 = 97, b0 = 104;
      let r1 = 134, g1 = 224, b1 = 255;
      if (t > 0.88) {
        r1 = 255;
        g1 = 255;
        b1 = 255;
      } else if (t > 0.6) {
        r1 = 96;
        g1 = 164;
        b1 = 255;
      }
      const r = Math.round(r0 + (r1 - r0) * clamped);
      const g = Math.round(g0 + (g1 - g0) * clamped);
      const b = Math.round(b0 + (b1 - b0) * clamped);
      return `rgba(${r},${g},${b},${0.3 + 0.7 * clamped})`;
    }

    let raf = 0;
    function frame() {
      if (!reduced) {
        if (pointer.active) {
          lagged.x += (pointer.x - lagged.x) * LAG;
          lagged.y += (pointer.y - lagged.y) * LAG;
        }

        for (let i = 0; i < heat.length; i++) heat[i] *= DECAY;

        const minCol = Math.max(0, Math.floor((lagged.x - RADIUS) / CELL));
        const maxCol = Math.min(cols - 1, Math.ceil((lagged.x + RADIUS) / CELL));
        const minRow = Math.max(0, Math.floor((lagged.y - RADIUS) / CELL));
        const maxRow = Math.min(rows - 1, Math.ceil((lagged.y + RADIUS) / CELL));
        for (let row = minRow; row <= maxRow; row++) {
          for (let col = minCol; col <= maxCol; col++) {
            const cx = col * CELL + CELL / 2;
            const cy = row * CELL + CELL / 2;
            const dx = cx - lagged.x;
            const dy = cy - lagged.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < RADIUS) {
              const falloff = 1 - dist / RADIUS;
              const idx = row * cols + col;
              const contribution = falloff * falloff;
              if (contribution > heat[idx]) heat[idx] = contribution;
            }
          }
        }

        const sampleCount = Math.max(1, Math.floor(chars.length * AMBIENT_FRACTION));
        for (let i = 0; i < sampleCount; i++) {
          chars[(Math.random() * chars.length) | 0] = randomChar();
        }
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.font = `${CELL - 4}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const idx = row * cols + col;
          const h = heat[idx];
          ctx.fillStyle = h > 0.02 ? colorFor(h, tint[idx]) : "rgba(118,124,136,0.22)";
          ctx.fillText(chars[idx], col * CELL + CELL / 2, row * CELL + CELL / 2);
        }
      }

      if (!reduced) raf = requestAnimationFrame(frame);
    }

    raf = requestAnimationFrame(frame);

    return () => {
      window.removeEventListener("resize", resize);
      observer.disconnect();
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return <canvas ref={canvasRef} aria-hidden className="absolute inset-0 h-full w-full" />;
}

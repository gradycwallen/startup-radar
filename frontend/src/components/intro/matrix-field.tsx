"use client";

import { useEffect, useRef } from "react";

const CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const CELL = 16; // px per grid cell
const RADIUS = 170; // px, pointer influence radius
const DECAY = 0.9; // heat multiplier per frame — controls fade-out speed
const LAG = 0.08; // pointer-follow smoothing — gives the "slight lag"
const AMBIENT_FRACTION = 0.0006; // fraction of cells whose glyph re-randomizes per frame

const PUSH = 14; // px, how far glyphs under the pointer are pushed outward (the lens)
const SWIRL = 5; // px, tangential twist added on top of the push, scaled by pointer speed
const SCRAMBLE = 0.14; // per-frame chance (× heat) that a hot glyph re-rolls
const RIPPLE_SPEED = 0.55; // px per ms a click ripple's ring expands
const RIPPLE_LIFE = 1400; // ms
const RIPPLE_BAND = 46; // px, thickness of a ripple ring
const MAX_RIPPLES = 4;
const IDLE_INTENSITY = 0.45; // brightness of the wandering glow when nobody is pointing

function randomChar() {
  return CHARSET[(Math.random() * CHARSET.length) | 0];
}

/**
 * Full-bleed, pointer-reactive character grid — the homepage hero's background (reference: the
 * Claude Code desktop app's own idle background), also used by PageBanner. Canvas, not a grid of
 * DOM `<span>`s: a few thousand text nodes re-rendered on every pointer move would be far too slow.
 *
 * Every cell keeps a `heat` value (0–1). Each frame: all cells decay a little (`* DECAY`), then
 * cells near the pointer — itself eased toward the real cursor for the "slight lag" — get bumped
 * up by distance falloff, so following and fading out are one mechanic, not two.
 *
 * On top of heat, the area under the pointer is distorted: glyphs are pushed outward like a lens
 * (plus a twist that grows with pointer speed), hot glyphs scramble, the hottest are drawn larger
 * with a faint chromatic split, and a click sends a ripple ring across the field. When no pointer
 * is over it (touch devices, or the cursor elsewhere), a dim glow wanders a slow Lissajous path
 * so the field never looks dead. The loop pauses while the canvas is off-screen.
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

    let width = 0;
    let height = 0;
    let cols = 0;
    let rows = 0;
    let chars: string[] = [];
    let heat = new Float32Array(0);
    let tint = new Float32Array(0);

    function resize() {
      const parent = canvas.parentElement;
      width = parent ? parent.clientWidth : window.innerWidth;
      height = parent ? parent.clientHeight : window.innerHeight;
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
      if (reduced) draw(0);
    }

    // A mobile browser's address bar hiding/showing, or `100svh` simply not having resolved yet
    // on the very first layout pass, changes the panel's actual size without firing a `window`
    // resize event — observing the parent element directly catches those too.
    const observer = new ResizeObserver(() => resize());
    if (canvas.parentElement) observer.observe(canvas.parentElement);

    const pointer = { x: -9999, y: -9999, active: false };
    const lagged = { x: -9999, y: -9999 };
    let speed = 0; // smoothed lagged-pointer speed, 0–1
    let presence = 0; // eases 0→1 while a real pointer is over the field, so idle ↔ live cross-fades
    const ripples: { x: number; y: number; born: number }[] = [];

    function localPoint(e: PointerEvent) {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }
    function onPointerMove(e: PointerEvent) {
      const p = localPoint(e);
      pointer.x = p.x;
      pointer.y = p.y;
      pointer.active = true;
    }
    function onPointerLeave() {
      pointer.active = false;
    }
    function onPointerDown(e: PointerEvent) {
      const p = localPoint(e);
      ripples.push({ ...p, born: performance.now() });
      if (ripples.length > MAX_RIPPLES) ripples.shift();
    }
    if (!reduced) {
      canvas.addEventListener("pointermove", onPointerMove);
      canvas.addEventListener("pointerleave", onPointerLeave);
      canvas.addEventListener("pointerdown", onPointerDown);
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

    /** Where the glow is centered and how strong it is: the eased real pointer, cross-faded with a
     * slow wandering path when nobody is pointing. */
    function source(now: number) {
      presence += ((pointer.active ? 1 : 0) - presence) * 0.05;
      const idleX = width * (0.5 + 0.32 * Math.sin(now / 5200));
      const idleY = height * (0.5 + 0.3 * Math.sin(now / 3700 + 1.3));
      const targetX = pointer.active ? pointer.x : idleX;
      const targetY = pointer.active ? pointer.y : idleY;
      if (lagged.x < -9000) {
        lagged.x = targetX;
        lagged.y = targetY;
      }
      const prevX = lagged.x;
      const prevY = lagged.y;
      lagged.x += (targetX - lagged.x) * LAG;
      lagged.y += (targetY - lagged.y) * LAG;
      const moved = Math.hypot(lagged.x - prevX, lagged.y - prevY);
      speed += (Math.min(1, moved / 18) - speed) * 0.12;
      return IDLE_INTENSITY + (1 - IDLE_INTENSITY) * presence;
    }

    function update(now: number) {
      const intensity = source(now);
      for (let i = 0; i < heat.length; i++) heat[i] *= DECAY;

      const reach = RADIUS * (1 + speed * 0.35);
      const minCol = Math.max(0, Math.floor((lagged.x - reach) / CELL));
      const maxCol = Math.min(cols - 1, Math.ceil((lagged.x + reach) / CELL));
      const minRow = Math.max(0, Math.floor((lagged.y - reach) / CELL));
      const maxRow = Math.min(rows - 1, Math.ceil((lagged.y + reach) / CELL));
      for (let row = minRow; row <= maxRow; row++) {
        for (let col = minCol; col <= maxCol; col++) {
          const dist = Math.hypot(col * CELL + CELL / 2 - lagged.x, row * CELL + CELL / 2 - lagged.y);
          if (dist >= reach) continue;
          const falloff = 1 - dist / reach;
          const idx = row * cols + col;
          const contribution = falloff * falloff * intensity;
          if (contribution > heat[idx]) heat[idx] = contribution;
        }
      }

      for (let i = ripples.length - 1; i >= 0; i--) {
        const age = now - ripples[i]!.born;
        if (age > RIPPLE_LIFE) ripples.splice(i, 1);
      }
      for (const ripple of ripples) {
        const age = now - ripple.born;
        const radius = age * RIPPLE_SPEED;
        const strength = 1 - age / RIPPLE_LIFE;
        const outer = radius + RIPPLE_BAND;
        const rMinCol = Math.max(0, Math.floor((ripple.x - outer) / CELL));
        const rMaxCol = Math.min(cols - 1, Math.ceil((ripple.x + outer) / CELL));
        const rMinRow = Math.max(0, Math.floor((ripple.y - outer) / CELL));
        const rMaxRow = Math.min(rows - 1, Math.ceil((ripple.y + outer) / CELL));
        for (let row = rMinRow; row <= rMaxRow; row++) {
          for (let col = rMinCol; col <= rMaxCol; col++) {
            const dist = Math.hypot(col * CELL + CELL / 2 - ripple.x, row * CELL + CELL / 2 - ripple.y);
            const band = 1 - Math.abs(dist - radius) / RIPPLE_BAND;
            if (band <= 0) continue;
            const idx = row * cols + col;
            const contribution = band * band * strength * 0.7;
            if (contribution > heat[idx]) heat[idx] = contribution;
          }
        }
      }

      for (let i = 0; i < heat.length; i++) {
        if (heat[i] > 0.3 && Math.random() < heat[i] * SCRAMBLE) chars[i] = randomChar();
      }
      const sampleCount = Math.max(1, Math.floor(chars.length * AMBIENT_FRACTION));
      for (let i = 0; i < sampleCount; i++) {
        chars[(Math.random() * chars.length) | 0] = randomChar();
      }
    }

    /** Offset for a glyph at (cx, cy): outward lens push + speed-scaled twist around the pointer,
     * plus an outward kick from any ripple ring passing through it. */
    function displacement(cx: number, cy: number, now: number): [number, number] {
      let ox = 0;
      let oy = 0;
      const dx = cx - lagged.x;
      const dy = cy - lagged.y;
      const dist = Math.hypot(dx, dy);
      if (dist < RADIUS && dist > 0.001) {
        const f = 1 - dist / RADIUS;
        const push = f * f * PUSH * (0.5 + 0.5 * presence) * (1 + speed * 0.6);
        const twist = f * f * SWIRL * speed;
        const ux = dx / dist;
        const uy = dy / dist;
        ox += ux * push - uy * twist;
        oy += uy * push + ux * twist;
      }
      for (const ripple of ripples) {
        const age = now - ripple.born;
        const rx = cx - ripple.x;
        const ry = cy - ripple.y;
        const d = Math.hypot(rx, ry);
        const band = 1 - Math.abs(d - age * RIPPLE_SPEED) / RIPPLE_BAND;
        if (band <= 0 || d < 0.001) continue;
        const kick = band * (1 - age / RIPPLE_LIFE) * 9;
        ox += (rx / d) * kick;
        oy += (ry / d) * kick;
      }
      return [ox, oy];
    }

    const BASE_FONT = `${CELL - 4}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
    const HOT_FONT = `${CELL}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
    const hotCells: number[] = [];

    function draw(now: number) {
      ctx.clearRect(0, 0, width, height);
      ctx.font = BASE_FONT;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      hotCells.length = 0;
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const idx = row * cols + col;
          const h = heat[idx];
          if (h > 0.55) {
            hotCells.push(idx);
            continue;
          }
          const cx = col * CELL + CELL / 2;
          const cy = row * CELL + CELL / 2;
          if (h > 0.02) {
            const [ox, oy] = reduced ? [0, 0] : displacement(cx, cy, now);
            ctx.fillStyle = colorFor(h, tint[idx]);
            ctx.fillText(chars[idx], cx + ox, cy + oy);
          } else {
            ctx.fillStyle = "rgba(118,124,136,0.22)";
            ctx.fillText(chars[idx], cx, cy);
          }
        }
      }

      // Hottest glyphs last, a size up, with a faint red/blue split either side — the one
      // deliberately "glitchy" touch, confined to the core of the glow.
      if (hotCells.length === 0) return;
      ctx.font = HOT_FONT;
      for (const idx of hotCells) {
        const col = idx % cols;
        const row = (idx - col) / cols;
        const cx = col * CELL + CELL / 2;
        const cy = row * CELL + CELL / 2;
        const [ox, oy] = reduced ? [0, 0] : displacement(cx, cy, now);
        const h = heat[idx];
        const split = 1 + h * 1.5;
        ctx.fillStyle = `rgba(255,90,150,${0.22 * h})`;
        ctx.fillText(chars[idx], cx + ox + split, cy + oy);
        ctx.fillStyle = `rgba(80,140,255,${0.28 * h})`;
        ctx.fillText(chars[idx], cx + ox - split, cy + oy);
        ctx.fillStyle = colorFor(h, tint[idx]);
        ctx.fillText(chars[idx], cx + ox, cy + oy);
      }
    }

    let raf = 0;
    let visible = true;
    function frame(now: number) {
      raf = 0;
      update(now);
      draw(now);
      if (visible) raf = requestAnimationFrame(frame);
    }

    const visibility = new IntersectionObserver(([entry]) => {
      visible = Boolean(entry?.isIntersecting);
      if (visible && !raf && !reduced) raf = requestAnimationFrame(frame);
    });

    resize();
    if (reduced) {
      draw(0);
    } else {
      visibility.observe(canvas);
      raf = requestAnimationFrame(frame);
    }

    return () => {
      observer.disconnect();
      visibility.disconnect();
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("pointerdown", onPointerDown);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return <canvas ref={canvasRef} aria-hidden className="absolute inset-0 h-full w-full" />;
}

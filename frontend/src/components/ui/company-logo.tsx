"use client";

import { useState } from "react";
import Image from "next/image";

/**
 * Zero-maintenance company logo: fetched from Google's public favicon service keyed by the
 * company's own `domain` (already resolved by Scout for every company) — nothing to upload or
 * curate per company, and a newly discovered company gets a logo automatically. Falls back to a
 * monogram (first letter of the name) if the image fails to load outright; a domain with no real
 * favicon still gets Google's own generic-globe icon rather than erroring, which reads fine in a
 * list of logos.
 */
// The service only recognizes a fixed set of size buckets (16/32/48/64/128/256) — any other value
// (e.g. a display size times a naive DPR multiplier) silently falls back to a blurry 16px icon
// instead of erroring. Always request the largest bucket and let CSS scale it down; the service
// itself already clamps to whatever resolution the domain's real favicon actually has.
function faviconUrl(domain: string) {
  const url = `https://${domain}`;
  return `https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=${encodeURIComponent(url)}&size=256`;
}

export function CompanyLogo({ domain, name, size = 32 }: { domain: string; name: string; size?: number }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <span
        aria-hidden
        className="flex shrink-0 items-center justify-center rounded-md border border-line/60 bg-accent-soft font-serif text-accent"
        style={{ width: size, height: size, fontSize: size * 0.42 }}
      >
        {name.charAt(0).toUpperCase()}
      </span>
    );
  }

  return (
    <Image
      src={faviconUrl(domain)}
      alt=""
      aria-hidden
      width={size}
      height={size}
      unoptimized
      onError={() => setFailed(true)}
      className="shrink-0 rounded-md border border-line/60 bg-surface object-contain p-1"
      style={{ width: size, height: size }}
    />
  );
}

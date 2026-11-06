"use client"; // Error boundaries must be Client Components.

import { useEffect } from "react";
import Link from "next/link";
import { Eyebrow } from "@/components/ui/eyebrow";

export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="mx-auto flex max-w-2xl flex-col items-center px-6 py-24 text-center">
      <Eyebrow>Error</Eyebrow>
      <h1 className="mt-2 font-serif text-2xl text-ink">Something interrupted this view</h1>
      <p className="mt-3 max-w-sm text-sm text-ink-muted">
        This didn&rsquo;t affect Startup Radar&rsquo;s data, nothing was written or changed. Try again, or head back to the Radar.
      </p>
      <div className="mt-6 flex gap-3">
        <button type="button" onClick={() => retry()} className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-canvas hover:bg-ink/90">
          Try again
        </button>
        <Link href="/" className="rounded-md border border-line px-4 py-2 text-sm font-medium text-ink hover:bg-line/40">
          Back to Radar
        </Link>
      </div>
    </main>
  );
}

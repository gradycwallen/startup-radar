"use client";

import { useState } from "react";

export function CopyProfileLink() {
  const [message, setMessage] = useState("");
  async function copy() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setMessage("Link copied");
    } catch {
      setMessage("Unable to copy. Please copy the address from your browser.");
    }
  }
  return <div className="flex flex-wrap items-center gap-3"><button type="button" onClick={copy} className="border border-line-strong px-3 py-2 text-xs font-semibold text-ink hover:border-accent">Copy profile link</button><span role="status" className="text-xs text-ink-muted">{message}</span></div>;
}

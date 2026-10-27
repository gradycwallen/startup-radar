import Link from "next/link";
import { Eyebrow } from "@/components/ui/eyebrow";

export default function NotFound() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col items-center px-6 py-24 text-center">
      <Eyebrow>404</Eyebrow>
      <h1 className="mt-2 font-serif text-2xl text-ink">Nothing on the radar here</h1>
      <p className="mt-3 max-w-sm text-sm text-ink-muted">This page doesn&rsquo;t exist, or the company you&rsquo;re looking for isn&rsquo;t in Startup Radar yet.</p>
      <Link href="/" className="mt-6 rounded-md bg-ink px-4 py-2 text-sm font-medium text-canvas hover:bg-ink/90">
        Back to Radar
      </Link>
    </main>
  );
}

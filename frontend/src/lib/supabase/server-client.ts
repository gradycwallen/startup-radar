import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-only Supabase access.
 *
 * SECURITY: this file imports `server-only`, so any attempt to import it from a Client Component
 * ("use client") fails at build time rather than silently shipping the service-role key to the
 * browser. It must stay that way — see root CLAUDE.md §7/§11 ("the service-role key must never be
 * exposed to browser code").
 *
 * Startup Radar's database has row-level security enabled with NO policies on either table (see
 * CLAUDE.md §3), so `anon`/`authenticated` cannot read anything at all — a browser-side client with
 * a public/anon key could never work here even in principle. The only way to read is the
 * `service_role` key, which is why this client is constructed exclusively on the server (React
 * Server Components and Route Handlers), read via plain (non-`NEXT_PUBLIC_`) env vars, and never
 * imported into any client bundle.
 *
 * This client only ever needs SELECT — nothing in the frontend calls .insert/.update/.upsert/
 * .delete/.rpc, matching the backend's own read-only posture for this phase.
 */

let cached: SupabaseClient | null | undefined;

/** Reduces a Supabase project URL to its origin, same as the backend's own `normalizeSupabaseUrl`
 * (repo root src/config.ts) — a value pasted with a trailing slash or an API path ("…/",
 * "…/rest/v1") otherwise breaks every request with "Invalid path specified". */
function normalizeSupabaseUrl(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : "";
  } catch {
    return "";
  }
}

/** Returns a server-only Supabase client, or null if credentials are not configured locally — the
 * caller (src/lib/data/companies.ts) falls back to mock data in that case rather than throwing. */
export function getServerSupabaseClient(): SupabaseClient | null {
  if (cached !== undefined) return cached;
  const url = normalizeSupabaseUrl(process.env.SUPABASE_URL);
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceRoleKey) {
    cached = null;
    return cached;
  }
  cached = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}

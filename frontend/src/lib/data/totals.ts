import "server-only";
import { getServerSupabaseClient } from "../supabase/server-client";

export interface SignalTotals {
  signals: number | null;
  observations: number | null;
  /** The most recent observation's observed_at, across every company — a real pulse on "when did
   * the daily collection run last touch this dataset," not a decorative animation. Null when
   * unavailable (no Supabase connection, or a read failure), never a fabricated/guessed time. */
  lastObservedAt: string | null;
}

export async function getSignalTotals(): Promise<SignalTotals> {
  const client = getServerSupabaseClient();
  if (!client) return { signals: null, observations: null, lastObservedAt: null };
  const [signals, observations, latest] = await Promise.all([
    client.from("signals").select("id", { count: "exact", head: true }),
    client.from("observations").select("id", { count: "exact", head: true }),
    client.from("observations").select("observed_at").order("observed_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (signals.error || observations.error) console.error("[data/totals] Supabase count failed:", signals.error ?? observations.error);
  if (latest.error) console.error("[data/totals] Supabase latest-observation read failed:", latest.error);
  return {
    signals: signals.error ? null : signals.count,
    observations: observations.error ? null : observations.count,
    lastObservedAt: latest.error ? null : (latest.data?.observed_at ?? null),
  };
}

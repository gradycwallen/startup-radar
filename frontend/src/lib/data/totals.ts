import "server-only";
import { getServerSupabaseClient } from "../supabase/server-client";

export async function getSignalTotals(): Promise<{ signals: number | null; observations: number | null }> {
  const client = getServerSupabaseClient();
  if (!client) return { signals: null, observations: null };
  const [signals, observations] = await Promise.all([
    client.from("signals").select("id", { count: "exact", head: true }),
    client.from("observations").select("id", { count: "exact", head: true }),
  ]);
  if (signals.error || observations.error) console.error("[data/totals] Supabase count failed:", signals.error ?? observations.error);
  return { signals: signals.error ? null : signals.count, observations: observations.error ? null : observations.count };
}

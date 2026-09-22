import { normalizeDomain } from "./domain.ts";

export interface HomepageCheck {
  /** Server answered: 2xx/3xx, or 401/403/429 (bot walls are common on real sites). */
  reachable: boolean;
  status?: number;
  finalUrl?: string;
  /** Registrable domain after following redirects. */
  finalDomain?: string | null;
  /** Page title + meta description + a slice of visible text; absent when blocked. */
  text?: string;
  error?: string;
}

/** `signal` lets a shutdown cut a slow homepage check short. */
export type HomepageChecker = (domain: string, signal?: AbortSignal) => Promise<HomepageCheck>;

const MAX_BYTES = 300_000;

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  void reader.cancel().catch(() => {});
  return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks));
}

function extractText(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "";
  const meta =
    /<meta[^>]+(?:name|property)=["'](?:description|og:description|og:site_name|og:title)["'][^>]*content=["']([^"']*)["']/gi;
  const metas: string[] = [];
  for (let m = meta.exec(html); m; m = meta.exec(html)) metas.push(m[1] ?? "");
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 20_000);
  return [title, ...metas, body].join(" ").trim();
}

/**
 * Read-only GET of a company's homepage. Follows redirects; never sends credentials.
 * `fetchImpl` is a seam so offline replays and tests can serve recorded responses instead of touching the network.
 */
export function createHomepageChecker(fetchImpl: typeof fetch = fetch): HomepageChecker {
  return async (domain, signal) => {
    let lastError = "unreachable";
    for (const host of [domain, `www.${domain}`]) {
      try {
        const res = await fetchImpl(`https://${host}/`, {
          redirect: "follow",
          signal: signal ? AbortSignal.any([AbortSignal.timeout(12_000), signal]) : AbortSignal.timeout(12_000),
          headers: {
            "user-agent": "StartupRadarScout/0.1 (verification; read-only)",
            accept: "text/html,application/xhtml+xml",
          },
        });
        const finalUrl = res.url;
        const finalDomain = normalizeDomain(finalUrl);
        const blocked = [401, 403, 429].includes(res.status);
        if (res.status >= 200 && res.status < 400) {
          return { reachable: true, status: res.status, finalUrl, finalDomain, text: extractText(await readCapped(res)) };
        }
        if (blocked) return { reachable: true, status: res.status, finalUrl, finalDomain };
        lastError = `http_${res.status}`;
      } catch (err) {
        lastError = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
      }
    }
    return { reachable: false, error: lastError };
  };
}

export const checkHomepage: HomepageChecker = createHomepageChecker();

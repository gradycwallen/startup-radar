import { FEED_REGISTRY, RssFeedProvider } from "./providers/rss-feed.ts";
import { GoogleNewsProvider } from "./providers/google-news.ts";
import { TechstarsProvider } from "./providers/techstars.ts";
import { YcDirectoryProvider } from "./providers/yc.ts";
import type { SourceProvider } from "./types.ts";

/**
 * Every V2-1 provider, independently constructed. To add a source, write a SourceProvider and add it here; to remove
 * or repair one, edit or delete its entry: nothing downstream depends on any particular provider.
 * (SEC Form D, GitHub, Hacker News, Product Hunt and the exploration provider are later phases.)
 */
export function defaultSourceProviders(): SourceProvider[] {
  return [
    ...FEED_REGISTRY.map((def) => new RssFeedProvider(def)),
    new GoogleNewsProvider(),
    new YcDirectoryProvider(),
    new TechstarsProvider(),
  ];
}

/** Apply --providers / --skip-providers filters; unknown ids are an error (a typo must not silently drop a source). */
export function selectProviders(all: readonly SourceProvider[], only?: readonly string[], skip?: readonly string[]): SourceProvider[] {
  const ids = new Set(all.map((p) => p.id));
  for (const id of [...(only ?? []), ...(skip ?? [])]) {
    if (!ids.has(id)) throw new Error(`Unknown provider "${id}". Valid: ${[...ids].join(", ")}`);
  }
  return all.filter((p) => (!only?.length || only.includes(p.id)) && !(skip ?? []).includes(p.id));
}

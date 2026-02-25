import { env } from "./env";
import { cacheGet, cacheSet } from "./cache";

export type SearchResult = { title: string; link: string; snippet: string };

type SerperResponse = {
  organic?: Array<{ title: string; link: string; snippet: string }>;
};

/**
 * Serper-backed web search with caching.
 * We keep the output minimal: title/link/snippet.
 */
export async function webSearch(query: string, k = 6): Promise<SearchResult[]> {
  if (!env.SERPER_API_KEY) throw new Error("SERPER_API_KEY is not set.");

  const norm = query.trim().toLowerCase();
  const cacheKey = `search:v1:${norm}:${k}`;

  const cached = await cacheGet(cacheKey);
  if (cached) return JSON.parse(cached) as SearchResult[];

  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": env.SERPER_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ q: query, num: k })
  });

  if (!res.ok) throw new Error(`Search failed (${res.status}): ${await res.text()}`);

  const data = (await res.json()) as SerperResponse;
  const organic = data.organic ?? [];
  const results = organic.slice(0, k).map((r) => ({ title: r.title, link: r.link, snippet: r.snippet }));

  await cacheSet(cacheKey, JSON.stringify(results), 30 * 60);
  return results;
}
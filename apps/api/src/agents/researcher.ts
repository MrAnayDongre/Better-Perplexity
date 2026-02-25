import { webSearch } from "../services/search";
import { fetchHtml } from "../services/fetch";
import { extractReadable } from "../services/extract";
import type { TraceEvent } from "../types/run";

export type EvidenceSource = {
  url: string;
  title: string;
  domain: string;
  excerpt: string;
  text: string;
  contentHash: string;
};

function domainOf(url: string): string {
  return new URL(url).hostname.replace(/^www\./, "");
}

function selectUrls(results: Array<{ title: string; link: string; snippet: string }>, max = 2) {
  const seenDomains = new Set<string>();
  const selected: Array<{ url: string; reason: string }> = [];

  for (const r of results) {
    let domain = "";
    try {
      domain = domainOf(r.link);
    } catch {
      continue;
    }
    if (seenDomains.has(domain)) continue;
    if (!r.snippet || r.snippet.length < 30) continue;

    seenDomains.add(domain);
    selected.push({ url: r.link, reason: "Top-ranked unique domain with informative snippet." });
    if (selected.length >= max) break;
  }
  return selected;
}

export type ResearchOptions = {
  budgetMs: number;
  perIntentUrls: number;
  concurrency: number;
  maxSources: number;
  minSources: number;
};

function nowMs() {
  return Date.now();
}

export async function research(
  intents: string[],
  opts: ResearchOptions
): Promise<{ trace: TraceEvent[]; sources: EvidenceSource[] }> {
  const trace: TraceEvent[] = [];
  const sources: EvidenceSource[] = [];

  const start = nowMs();
  const deadline = start + opts.budgetMs;

  const tasks: Array<{ url: string; reason: string }> = [];

  for (const q of intents) {
    const results = await webSearch(q, 6);
    trace.push({ type: "search", query: q, results: results.length });

    const selected = selectUrls(results, opts.perIntentUrls);
    trace.push({ type: "select", selected });

    tasks.push(...selected);
  }

  let idx = 0;

  function enoughEvidence() {
    if (sources.length >= opts.maxSources) return true;
    const totalChars = sources.reduce((a, s) => a + (s.text?.length ?? 0), 0);
    return sources.length >= opts.minSources && totalChars >= 2500;
  }

  async function worker() {
    while (idx < tasks.length) {
      if (nowMs() > deadline) return;
      if (enoughEvidence()) return;

      const cur = tasks[idx++];
      const page = await fetchHtml(cur.url);
      trace.push({ type: "fetch", url: cur.url, status: page.status });

      if (nowMs() > deadline) return;

      if (page.status < 200 || page.status >= 300) continue;
      if (!page.contentType.toLowerCase().includes("text/html")) continue;
      if (!page.html) continue;

      try {
        const doc = await extractReadable(page.html, cur.url);
        if (!doc.text || doc.text.length < 300) continue;

        sources.push({
          url: cur.url,
          title: doc.title,
          domain: domainOf(cur.url),
          excerpt: doc.excerpt,
          text: doc.text,
          contentHash: doc.contentHash
        });
      } catch {
        continue;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(opts.concurrency, tasks.length) }, () => worker()));
  trace.push({ type: "timing", ms: nowMs() - start });

  const seen = new Set<string>();
  const deduped = sources.filter((s) => {
    if (seen.has(s.contentHash)) return false;
    seen.add(s.contentHash);
    return true;
  });

  return { trace, sources: deduped.slice(0, opts.maxSources) };
}

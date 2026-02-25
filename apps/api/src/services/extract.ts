import { JSDOM, VirtualConsole } from "jsdom";
import { Readability } from "@mozilla/readability";
import crypto from "node:crypto";
import { cacheGet, cacheSet } from "./cache";

export type ExtractedDoc = { title: string; text: string; excerpt: string; contentHash: string };

function hashText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 24);
}

function extractCacheKey(url: string) {
  return `extract:v1:${url}`;
}

/**
 * Readability extraction using JSDOM with:
 * - CSS parse noise silenced
 * - caching of extracted article text (huge performance win)
 */
export async function extractReadable(html: string, url: string): Promise<ExtractedDoc> {
  const key = extractCacheKey(url);
  const cached = await cacheGet(key);
  if (cached) return JSON.parse(cached) as ExtractedDoc;

  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (err) => {
    const msg = String(err?.message ?? err);
    if (msg.includes("Could not parse CSS stylesheet")) return;
    // eslint-disable-next-line no-console
    console.error("JSDOM error:", msg);
  });

  const dom = new JSDOM(html, { url, virtualConsole });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  const title = article?.title?.trim() || new URL(url).hostname;
  const text = (article?.textContent ?? "").replace(/\s+\n/g, "\n").trim();
  const excerpt = text.slice(0, 400);
  const contentHash = hashText(text || html.slice(0, 2000));

  const doc: ExtractedDoc = { title, text, excerpt, contentHash };

  // Cache for 24h (extracted text changes less frequently than HTML noise)
  await cacheSet(key, JSON.stringify(doc), 24 * 60 * 60);

  return doc;
}

import { request, Agent } from "undici";
import { cacheGet, cacheSet } from "./cache";

export type FetchResult = {
  url: string;
  status: number;
  contentType: string;
  html: string;
};

const agent = new Agent({
  connect: {
    timeout: 4_000
  }
});

function cacheKey(url: string) {
  return `fetch:v2:${url}`;
}

function isHtml(contentType: string) {
  return contentType.toLowerCase().includes("text/html");
}

/**
 * Production rule: NEVER throw from this function. Return status=0 on failure.
 * Strict timeouts to avoid hanging the whole pipeline.
 */
export async function fetchHtml(url: string): Promise<FetchResult> {
  const cached = await cacheGet(cacheKey(url));
  if (cached) return JSON.parse(cached) as FetchResult;

  const abort = new AbortController();
  const hardTimeout = setTimeout(() => abort.abort(), 8_000);

  try {
    const res = await request(url, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Better-Perplexity/1.0",
        Accept: "text/html,application/xhtml+xml"
      },
      dispatcher: agent,
      signal: abort.signal,
      headersTimeout: 5_000,
      bodyTimeout: 7_000
    });

    const status = res.statusCode;
    const contentType = String(res.headers["content-type"] ?? "");

    let html = "";
    try {
      if (status >= 200 && status < 300 && isHtml(contentType)) {
        html = await res.body.text();
      } else {
        await res.body.text().catch(() => "");
      }
    } catch {
      html = "";
    }

    const out: FetchResult = { url, status, contentType, html };

    if (status >= 200 && status < 300 && html) {
      await cacheSet(cacheKey(url), JSON.stringify(out), 6 * 60 * 60);
    }

    return out;
  } catch {
    return { url, status: 0, contentType: "", html: "" };
  } finally {
    clearTimeout(hardTimeout);
  }
}

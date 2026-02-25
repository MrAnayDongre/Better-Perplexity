import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { env } from "./env";

/**
 * Rate limiting:
 * - Production: Upstash Redis-based ratelimit if configured.
 * - Local dev: in-memory sliding window.
 *
 * Keep the middleware minimal: deterministic, low overhead, no noisy try/catch.
 */
const hasUpstash = Boolean(env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN);

const redis = hasUpstash
  ? new Redis({ url: env.UPSTASH_REDIS_REST_URL!, token: env.UPSTASH_REDIS_REST_TOKEN! })
  : null;

const limiter = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(30, "1 m") // 30 req/min per IP
    })
  : null;

const memHits = new Map<string, { count: number; resetAt: number }>();

export async function checkRateLimit(ip: string): Promise<{ allowed: boolean; remaining: number }> {
  if (limiter) {
    const r = await limiter.limit(ip);
    return { allowed: r.success, remaining: r.remaining };
  }

  const now = Date.now();
  const windowMs = 60_000;
  const limit = 30;

  const cur = memHits.get(ip);
  if (!cur || now > cur.resetAt) {
    memHits.set(ip, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1 };
  }

  if (cur.count >= limit) return { allowed: false, remaining: 0 };

  cur.count += 1;
  memHits.set(ip, cur);
  return { allowed: true, remaining: limit - cur.count };
}
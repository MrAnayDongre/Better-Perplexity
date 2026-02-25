import { Redis } from "@upstash/redis";
import { env } from "./env";

/**
 * Cache strategy:
 * - Production: Upstash Redis (if configured).
 * - Local dev: in-memory fallback.
 *
 * We store values as strings to keep this layer generic and predictable.
 */
const hasUpstash = Boolean(env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN);

const redis = hasUpstash
  ? new Redis({ url: env.UPSTASH_REDIS_REST_URL!, token: env.UPSTASH_REDIS_REST_TOKEN! })
  : null;

type CacheValue = { value: string; expiresAt: number };
const mem = new Map<string, CacheValue>();

export async function cacheGet(key: string): Promise<string | null> {
  if (redis) {
    const v = await redis.get<string>(key);
    return v ?? null;
  }

  const hit = mem.get(key);
  if (!hit) return null;

  if (Date.now() > hit.expiresAt) {
    mem.delete(key);
    return null;
  }

  return hit.value;
}

export async function cacheSet(key: string, value: string, ttlSeconds: number): Promise<void> {
  if (redis) {
    await redis.set(key, value, { ex: ttlSeconds });
    return;
  }

  mem.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}
import "dotenv/config";
import express from "express";
import cors from "cors";
import { env } from "./services/env";
import { checkRateLimit } from "./services/rateLimit";
import { chatHandler } from "./routes/chat";
import { getRunHandler } from "./routes/runs";

/**
 * Express API service:
 * - CORS locked to the configured web origin
 * - Rate limiting per IP
 * - SSE streaming for /api/chat
 */
const app = express();

app.use(
  cors({
    origin: env.CORS_ORIGIN,
    credentials: false
  })
);

app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use(async (req, res, next) => {
  const ip =
    req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    "unknown";

  const r = await checkRateLimit(ip);
  res.setHeader("X-RateLimit-Remaining", String(r.remaining));

  if (!r.allowed) {
    res.status(429).json({ error: "Rate limit exceeded" });
    return;
  }

  next();
});

app.post("/api/chat", chatHandler);
app.get("/api/runs/:id", getRunHandler);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = err instanceof Error ? err.message : "Unknown error";
  if (res.headersSent) {
    // eslint-disable-next-line no-console
    console.error("Unhandled error after headers sent:", message);
    return;
  }
  res.status(500).json({ error: message });
});

app.listen(Number(env.PORT), () => {
  // eslint-disable-next-line no-console
  console.log(`API listening on http://localhost:${env.PORT}`);
});

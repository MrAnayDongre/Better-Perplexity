# Better-Perplexity

A Perplexity-style research assistant that feels like a product, not a demo. It searches the web, extracts readable evidence, streams progress over SSE, returns citations, and (in Reliability Mode) verifies claims against sources. The goal is simple: ship an AI system that is fast, inspectable, and debuggable.

**Live demo:** [https://better-perplexity.vercel.app](https://better-perplexity.vercel.app)
**API (health):** [https://better-perplexity.onrender.com/health](https://better-perplexity.onrender.com/health)
---

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [How it works](#how-it-works)
- [Tech stack](#tech-stack)
- [Monorepo layout](#monorepo-layout)
- [Local development](#local-development)
- [Environment variables](#environment-variables)
- [Deployment](#deployment)
- [Operational notes](#operational-notes)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [Roadmap](#roadmap)
- [License](#license)

---

## Features

- **Web research:** Deep search with citations and readable excerpts.
- **Pro UI:** Perplexity-inspired interface with Answer, Links, Trace, and Claims panels.
- **Reliability Mode:** Automatically extracts claims and checks them against evidence for fact-checking.
- **SSE Streaming:** Real-time progress updates and incremental UI rendering.
- **Smart Caching:** Fast repeated queries using Redis (optional).
- **Resilient Retrieval:** Built-in timeouts, domain deduplication, and concurrency limits.

---

## Architecture

Two services, one contract.

- **Web (Vercel)** React + Vite UI that initiates a chat request and renders structured SSE events.
- **API (Render)** Node + Express service that orchestrates the pipeline: plan → search → fetch → extract → answer → verify.
- **Search** Serper (Google Search API) used for fast, consistent search results.
- **LLM** Provider is configurable:
  - Local development uses **Ollama** (recommended, GPU-backed).
  - Deployed environments can use any hosted provider.

---

## How it works

A single question becomes a deterministic pipeline:

1. **Planner:** Produces 2–4 search intents for the user's query.
2. **Search:** Runs Serper searches for each intent and selects URLs (deduped by domain).
3. **Fetch + Extract:** Fetches pages with hard timeouts and converts HTML into clean text via Readability.
4. **Answer:** Drafts the final answer with citations like `Source[1]`.
5. **Reliability Mode (Optional):** Extracts claims from the answer and verifies them against the evidence pack.
6. **SSE Streaming:** API emits structured events (`meta`, `status`, `token`, `sources`, `trace`, `claims`, `done`) so the UI renders artifacts in real-time.

---

## Tech stack

- **Frontend:** React, Vite, Tailwind CSS, Framer Motion
- **Backend:** Node.js, Express, Zod
- **Search:** Serper (Google Search API)
- **Extraction:** JSDOM + Readability
- **DB / Persistence:** Prisma + SQLite (demo-oriented)
- **Cache / Rate limiting:** Upstash Redis + Ratelimit (optional)

---

## Monorepo layout

```text
better-perplexity/
├── apps/
│   ├── web/          # React UI (Vite)
│   └── api/          # Express API (SSE + retrieval + reliability)
├── pnpm-workspace.yaml
└── package.json
```

**Key backend files:**
- `apps/api/src/routes/chat.ts` — SSE endpoint and orchestration
- `apps/api/src/agents/researcher.ts` — retrieval + dedupe + concurrency
- `apps/api/src/agents/verifier.ts` — claim extraction + evidence checks
- `apps/api/src/services/search.ts` — Serper integration

**Key frontend file:**
- `apps/web/src/App.tsx` — UI, threads, SSE handling, and panels

---

## Local development

### Prerequisites

- Node.js **20+**
- pnpm **10+**
- (Recommended) [Ollama](https://ollama.com/) running locally

### Setup

1. **Install dependencies:**

```bash
pnpm install
```

2. **Start the API + Web together:**

```bash
pnpm dev
```

- **Web:** `http://localhost:5173`
- **API:** `http://localhost:8787`

---

## Environment variables

### Backend (`apps/api/.env`)

```env
PORT=8787
CORS_ORIGIN=http://localhost:5173

# Search
SERPER_API_KEY=YOUR_SERPER_KEY

# LLM provider selection
LLM_PROVIDER=ollama

# Ollama (local)
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3.1

# Optional: Upstash for caching/ratelimit
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=

# Prisma SQLite
DATABASE_URL=file:./dev.db
```

### Frontend (`apps/web/.env`)

```env
VITE_API_BASE=http://localhost:8787
```

*Note: `VITE_*` variables are public in the client build.*

---

## Deployment

### Frontend (Vercel)

1. Set environment variable: `VITE_API_BASE=https://your-api-url.onrender.com`
2. Deploy from `apps/web`:

```bash
cd apps/web
vercel --prod
```

### Backend (Render)

1. Set `DATABASE_URL=file:/tmp/bp.db` (SQLite on ephemeral disk).
2. Set `CORS_ORIGIN=https://your-app.vercel.app`.
3. Ensure `SERPER_API_KEY` is provided.
4. Health check endpoint: `GET /health`.

---

## Operational notes

- **Performance:** Web search is fast; page fetching is the bottleneck. We mitigate this using per-URL timeouts and limited concurrency.
- **Reliability Mode:** Prioritizes inspectability. Claims are short, explicit, and tied to evidence. Unsupported claims are flagged clearly.

---

## Troubleshooting

- **"Web searches require SERPER_API_KEY"**: Ensure the key is set in your backend `.env` or provider dashboard.
- **CORS errors**: Match `CORS_ORIGIN` exactly to your frontend URL (including `http://` or `https://`).
- **Ollama not reachable**: Confirm Ollama is running with `curl http://localhost:11434/api/tags`.
- **Database errors on Render**: SQLite requires a writable path. Use `file:/tmp/bp.db`.

---

## Security

- Do not commit `.env` files.
- Never place sensitive API keys in the frontend (`apps/web`).
- Enable Upstash rate limiting in production to prevent abuse.

---

## Roadmap

- [ ] Durable Postgres storage for multi-user persistence.
- [ ] Evaluation harness for factuality and citation coverage.
- [ ] Smarter retrieval: adaptive source count + early stopping.
- [ ] Improved ranking: domain quality signals and snippet scoring.
- [ ] UX polish: tighter citation interactions and smoother streaming.

---

## License

Apache-2.0 License. See [LICENSE](LICENSE) for details.

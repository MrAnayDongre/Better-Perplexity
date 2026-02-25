import type { Request, Response } from "express";
import { z } from "zod";
import { createId } from "@paralleldrive/cuid2";
import { prisma } from "../services/db";
import { getLLM, getLLMFast } from "../llm";
import { planQuery } from "../agents/planner";
import { research } from "../agents/researcher";
import { responderMessages, draftAnswer } from "../agents/responder";
import { extractClaims, verifyClaims } from "../agents/verifier";
import type { ClaimRecord, TraceEvent } from "../types/run";
import { cacheGet, cacheSet } from "../services/cache";

const SSE_KEEPALIVE_MS = 1000;

const ChatReqSchema = z.object({
  conversationId: z.string().optional(),
  message: z.string().min(1),
  mode: z.enum(["normal", "reliability"]).default("normal")
});

type CachedArtifact = {
  finalAnswer: string;
  sources: Array<{ url: string; title: string; domain: string; excerpt: string; contentHash: string }>;
  trace: TraceEvent[];
  claims: ClaimRecord[];
};

function sseHeaders(res: Response) {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  if (typeof res.flushHeaders === "function") res.flushHeaders();
}

function sseSend(res: Response, event: string, data: unknown) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sseStatus(res: Response, message: string, step?: number, total?: number) {
  sseSend(res, "status", { message, step, total });
}

function normalizeQuestion(q: string) {
  return q.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 300);
}

function artifactKey(mode: string, q: string) {
  return `artifact:v1:${mode}:${normalizeQuestion(q)}`;
}

function streamTextQuick(res: Response, text: string) {
  const chunkSize = 140;
  for (let i = 0; i < text.length; i += chunkSize) {
    sseSend(res, "token", { chunk: text.slice(i, i + chunkSize) });
  }
}

function mergeSourcesByHash<T extends { contentHash: string }>(a: T[], b: T[], cap: number): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const x of [...a, ...b]) {
    if (seen.has(x.contentHash)) continue;
    seen.add(x.contentHash);
    out.push(x);
    if (out.length >= cap) break;
  }
  return out;
}

async function persistRunFromArtifact(args: {
  conversationId: string;
  runId: string;
  mode: string;
  userMessage: string;
  artifact: CachedArtifact;
}) {
  await prisma.conversation.upsert({ where: { id: args.conversationId }, update: {}, create: { id: args.conversationId } });
  await prisma.message.create({ data: { id: createId(), conversationId: args.conversationId, role: "user", content: args.userMessage } });

  await prisma.run.create({
    data: {
      id: args.runId,
      conversationId: args.conversationId,
      mode: args.mode,
      userMessage: args.userMessage,
      finalAnswer: args.artifact.finalAnswer,
      traceJson: JSON.stringify(args.artifact.trace ?? []),
      claimsJson: JSON.stringify(args.artifact.claims ?? [])
    }
  });

  for (const s of args.artifact.sources ?? []) {
    await prisma.source.create({
      data: {
        id: createId(),
        runId: args.runId,
        url: s.url,
        title: s.title,
        domain: s.domain,
        excerpt: s.excerpt,
        contentHash: s.contentHash
      }
    });
  }

  await prisma.message.create({ data: { id: createId(), conversationId: args.conversationId, role: "assistant", content: args.artifact.finalAnswer } });
}

export async function chatHandler(req: Request, res: Response) {
  sseHeaders(res);

  const ka = setInterval(() => {
    try {
      res.write(`: ping\n\n`);
    } catch {
      // ignore
    }
  }, SSE_KEEPALIVE_MS);

  try {
    const body = ChatReqSchema.parse(req.body);

    const llm = getLLM();
    const llmFast = getLLMFast();

    const conversationId = body.conversationId ?? createId();
    const runId = createId();

    sseSend(res, "meta", { conversationId, runId, mode: body.mode });

    // TTFT
    sseStatus(res, "Starting…", 0, 4);
    sseSend(res, "token", { chunk: "Got it — pulling sources and drafting an answer…\n\n" });

    // --- CACHE HIT (FULL ARTIFACT) ---
    const ck = artifactKey(body.mode, body.message);
    const cached = await cacheGet(ck);
    if (cached) {
      const artifact = JSON.parse(cached) as CachedArtifact;

      sseStatus(res, "Cached answer", 4, 4);

      await persistRunFromArtifact({
        conversationId,
        runId,
        mode: body.mode,
        userMessage: body.message,
        artifact
      });

      if (body.mode === "reliability" && (artifact.claims?.length ?? 0) > 0) {
        sseSend(res, "claims", { claims: artifact.claims });
      }

      streamTextQuick(res, artifact.finalAnswer);
      sseSend(res, "done", { runId });
      clearInterval(ka);
      res.end();
      return;
    }

    await prisma.conversation.upsert({ where: { id: conversationId }, update: {}, create: { id: conversationId } });
    await prisma.message.create({ data: { id: createId(), conversationId, role: "user", content: body.message } });

    const trace: TraceEvent[] = [];
    const requiredSources = body.mode === "reliability" ? 3 : 2;

    sseStatus(res, "Planning searches…", 1, 4);
    const plan = await planQuery(llmFast, body.message);
    trace.push({ type: "planner", intents: plan.intents });

    sseStatus(res, "Searching & fetching sources…", 2, 4);

    const opts = {
      budgetMs: 7000,
      perIntentUrls: body.mode === "reliability" ? 3 : 2,
      concurrency: 3,
      maxSources: 6,
      minSources: requiredSources
    };

    const researched1 = await research(plan.intents, opts);
    trace.push(...researched1.trace);

    let sources = researched1.sources;
    if (body.mode === "reliability" && sources.length < requiredSources) {
      sseStatus(res, "Fetching extra sources…", 2, 4);
      const extraIntents = [...plan.intents, `${body.message} definition`, `${body.message} authoritative source`];
      const researched2 = await research(extraIntents, opts);
      trace.push(...researched2.trace);
      sources = mergeSourcesByHash(sources, researched2.sources, 6);
    }

    await prisma.run.create({
      data: {
        id: runId,
        conversationId,
        mode: body.mode,
        userMessage: body.message,
        traceJson: JSON.stringify(trace),
        claimsJson: JSON.stringify([]),
        finalAnswer: ""
      }
    });

    for (const s of sources) {
      await prisma.source.create({
        data: {
          id: createId(),
          runId,
          url: s.url,
          title: s.title,
          domain: s.domain,
          excerpt: s.excerpt,
          contentHash: s.contentHash
        }
      });
    }

    // ---------- NORMAL ----------
    if (body.mode === "normal") {
      sseStatus(res, "Writing answer…", 3, 4);

      const baseMessages = responderMessages({ userQuestion: body.message, mode: "normal", sources });
      const constrained = [
        ...baseMessages,
        { role: "system" as const, content: "Write a helpful answer. Cite sources as (Source[n]). Keep it concise." }
      ];

      // (Ollama provider streams by chunking completed text; still emit tokens)
      let finalText = "";
      await llm.streamChat({
        messages: constrained,
        temperature: 0.2,
        onToken: (chunk) => {
          finalText += chunk;
          sseSend(res, "token", { chunk });
        }
      });

      if (!finalText.trim()) {
        let fb = await llm.chat({ messages: constrained, temperature: 0.2 });
        if (!(fb.text ?? "").trim()) fb = await llmFast.chat({ messages: constrained, temperature: 0.2 });
        finalText = (fb.text ?? "").trim() || "I wasn't able to generate a response. Please try again.";
        streamTextQuick(res, finalText);
      }

      await prisma.message.create({ data: { id: createId(), conversationId, role: "assistant", content: finalText } });
      await prisma.run.update({
        where: { id: runId },
        data: { finalAnswer: finalText, traceJson: JSON.stringify(trace), claimsJson: JSON.stringify([]) }
      });

      const artifact: CachedArtifact = {
        finalAnswer: finalText,
        sources: sources.map((s) => ({ url: s.url, title: s.title, domain: s.domain, excerpt: s.excerpt, contentHash: s.contentHash })),
        trace,
        claims: []
      };
      await cacheSet(ck, JSON.stringify(artifact), 2 * 60 * 60);

      sseStatus(res, "Done", 4, 4);
      sseSend(res, "done", { runId });
      clearInterval(ka);
      res.end();
      return;
    }

    // ---------- RELIABILITY ----------
    sseStatus(res, "Drafting & verifying…", 3, 4);

    const draftMessages = responderMessages({ userQuestion: body.message, mode: "normal", sources });
    const draft = await draftAnswer(llmFast, draftMessages);

    const claims = await extractClaims(llmFast, body.message, draft);
    const safeClaims = (claims ?? []).filter(Boolean).slice(0, 4);

    let verified: ClaimRecord[] = [];
    if (safeClaims.length > 0) {
      verified = verifyClaims(safeClaims, sources);
      await prisma.run.update({
        where: { id: runId },
        data: { claimsJson: JSON.stringify(verified), traceJson: JSON.stringify(trace) }
      });
      sseSend(res, "claims", { claims: verified });
    }

    sseStatus(res, "Writing answer…", 3, 4);

    const finalMessages = responderMessages({
      userQuestion: body.message,
      mode: "reliability",
      sources,
      verifiedClaims: verified
    });

    const finalWithConstraint = [
      ...finalMessages,
      { role: "system" as const, content: "Write a helpful answer. Cite sources as (Source[n]) when using facts. Keep it concise." }
    ];

    let finalText = "";
    await llm.streamChat({
      messages: finalWithConstraint,
      temperature: 0.2,
      onToken: (chunk) => {
        finalText += chunk;
        sseSend(res, "token", { chunk });
      }
    });

    if (!finalText.trim()) {
      let fb = await llm.chat({ messages: finalWithConstraint, temperature: 0.2 });
      if (!(fb.text ?? "").trim()) fb = await llmFast.chat({ messages: finalWithConstraint, temperature: 0.2 });
      finalText = (fb.text ?? "").trim() || "I wasn't able to generate a response. Please try again.";
      streamTextQuick(res, finalText);
    }

    await prisma.message.create({ data: { id: createId(), conversationId, role: "assistant", content: finalText } });
    await prisma.run.update({ where: { id: runId }, data: { finalAnswer: finalText } });

    const artifact: CachedArtifact = {
      finalAnswer: finalText,
      sources: sources.map((s) => ({ url: s.url, title: s.title, domain: s.domain, excerpt: s.excerpt, contentHash: s.contentHash })),
      trace,
      claims: verified
    };
    await cacheSet(ck, JSON.stringify(artifact), 2 * 60 * 60);

    sseStatus(res, "Done", 4, 4);
    sseSend(res, "done", { runId });
    clearInterval(ka);
    res.end();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    sseSend(res, "error", { message });
    clearInterval(ka);
    res.end();
  }
}

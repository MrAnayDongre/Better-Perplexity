import type { Request, Response } from "express";
import { prisma } from "../services/db";

/**
 * GET /api/runs/:id
 * Returns the persisted run artifact used for replay + UI panels.
 */
export async function getRunHandler(req: Request, res: Response) {
  const raw = req.params.id;
  const id = Array.isArray(raw) ? raw[0] : raw;

  if (!id) {
    res.status(400).json({ error: "Missing run id" });
    return;
  }

  const run = await prisma.run.findUnique({
    where: { id },
    include: { sources: true }
  });

  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }

  res.json({
    id: run.id,
    conversationId: run.conversationId,
    mode: run.mode,
    userMessage: run.userMessage,
    finalAnswer: run.finalAnswer,
    trace: JSON.parse(run.traceJson),
    claims: JSON.parse(run.claimsJson),
    sources: run.sources.map((s: { url: string; title: string; domain: string; excerpt: string }) => ({
      url: s.url,
      title: s.title,
      domain: s.domain,
      excerpt: s.excerpt
    })),
    createdAt: run.createdAt
  });
}

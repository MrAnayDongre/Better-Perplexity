import { z } from "zod";
import { createId } from "@paralleldrive/cuid2";
import type { LLMProvider } from "../llm/provider";
import type { EvidenceSource } from "./researcher";
import type { ClaimRecord, ClaimSupportLabel } from "../types/run";

const ClaimsSchema = z.object({
  claims: z.array(z.string().min(8)).min(1).max(6)
});

function chunkText(text: string, maxLen = 900): string[] {
  const paras = text
    .split(/\n{2,}/g)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let buf = "";

  for (const p of paras) {
    const next = buf ? `${buf}\n\n${p}` : p;
    if (next.length > maxLen) {
      if (buf) chunks.push(buf);
      buf = p;
    } else {
      buf = next;
    }
  }
  if (buf) chunks.push(buf);
  return chunks.slice(0, 40);
}

function normalizeTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/g)
    .filter((t) => t.length >= 4);
}

/**
 * Deterministic evidence score:
 * ratio of overlapping claim tokens in chunk.
 */
function overlapScore(claim: string, chunk: string): number {
  const ct = new Set(normalizeTokens(claim));
  const dt = normalizeTokens(chunk);
  if (ct.size === 0 || dt.length === 0) return 0;

  let hit = 0;
  for (const w of dt) if (ct.has(w)) hit += 1;

  return Math.min(1, hit / Math.max(8, ct.size));
}

function labelFromScore(score: number): ClaimSupportLabel {
  if (score >= 0.75) return "supported";
  if (score >= 0.45) return "weak";
  return "unsupported";
}

/**
 * Extract factual claims from a draft answer.
 * Production rule: NEVER throw from this function. Return [] on failure.
 */
export async function extractClaims(llm: LLMProvider, userQuestion: string, draftAnswer: string): Promise<string[]> {
  try {
    const { json } = await llm.chat<{ claims: string[] }>({
      temperature: 0.2,
      messages: [
        {
          role: "user",
          content: [
            "Extract atomic, checkable factual claims from the assistant draft answer.",
            "Only include factual statements (no opinions).",
            "Output ONLY JSON.",
            "",
            "Question:",
            userQuestion,
            "",
            "Draft Answer:",
            draftAnswer
          ].join("\n")
        }
      ],
      json: {
        instruction: '{"claims":["..."]}',
        parse: (raw) => ClaimsSchema.parse(raw)
      }
    });

    return (json?.claims ?? []).filter(Boolean);
  } catch {
    return [];
  }
}

export function verifyClaims(claims: string[], sources: EvidenceSource[]): ClaimRecord[] {
  const sourceChunks = sources.map((s) => ({
    url: s.url,
    chunks: chunkText(s.text)
  }));

  return claims.map((claim) => {
    const evidenceScored: Array<{ sourceUrl: string; snippet: string; score: number }> = [];

    for (const s of sourceChunks) {
      let best = { snippet: "", score: 0 };
      for (const chunk of s.chunks) {
        const score = overlapScore(claim, chunk);
        if (score > best.score) best = { snippet: chunk.slice(0, 280), score };
      }
      if (best.score > 0) evidenceScored.push({ sourceUrl: s.url, snippet: best.snippet, score: best.score });
    }

    evidenceScored.sort((a, b) => b.score - a.score);
    const top = evidenceScored.slice(0, 3);
    const maxScore = top[0]?.score ?? 0;

    return {
      id: createId(),
      claim,
      score: Number(maxScore.toFixed(2)),
      label: labelFromScore(maxScore),
      evidence: top.map((e) => ({ sourceUrl: e.sourceUrl, snippet: e.snippet }))
    };
  });
}

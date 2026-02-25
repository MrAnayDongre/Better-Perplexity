import type { ChatMessage, LLMProvider } from "../llm/provider";
import type { EvidenceSource } from "./researcher";
import type { ClaimRecord } from "../types/run";

function clamp(s: string, max: number) {
  const t = (s ?? "").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

/**
 * Pack evidence for the model with strict caps to avoid huge contexts
 * (which can stall streaming and slow GPU inference).
 */
function evidencePack(sources: EvidenceSource[]): string {
  return sources
    .slice(0, 6)
    .map((s, i) => {
      // Keep: title + excerpt + a small slice of body text (not the whole page)
      const bodySlice = clamp(s.text, 600);
      return [
        `Source[${i + 1}]`,
        `URL: ${s.url}`,
        `Title: ${clamp(s.title, 160)}`,
        `Excerpt: ${clamp(s.excerpt, 300)}`,
        `Body: ${bodySlice}`
      ].join("\n");
    })
    .join("\n\n");
}

function claimsPack(claims: ClaimRecord[]): string {
  return claims.map((c, i) => `Claim[${i + 1}] (${c.label}, score=${c.score}): ${c.claim}`).join("\n");
}

export function responderMessages(args: {
  userQuestion: string;
  mode: "normal" | "reliability";
  sources: EvidenceSource[];
  verifiedClaims?: ClaimRecord[];
}): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "You are a research assistant. Answer clearly. Use citations inline as (Source[n]). Never invent sources."
    },
    {
      role: "user",
      content: [
        "Question:",
        args.userQuestion,
        "",
        "Evidence:",
        evidencePack(args.sources),
        "",
        args.mode === "reliability"
          ? [
              "Verified claims:",
              claimsPack(args.verifiedClaims ?? []),
              "",
              "Rules:",
              "- Prefer Supported claims.",
              "- If you include Weak claims, add a brief uncertainty note.",
              "- Do NOT state Unsupported claims as facts.",
              "- Always include citations as (Source[n]).",
              "- If 3+ sources are available, cite at least THREE distinct sources."
            ].join("\n")
          : "Rules:\n- Always include citations as (Source[n])."
      ].join("\n")
    }
  ];
}

export async function draftAnswer(llm: LLMProvider, messages: ChatMessage[]): Promise<string> {
  const { text } = await llm.chat({ messages, temperature: 0.2 });
  return text.trim();
}

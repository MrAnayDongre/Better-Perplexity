import { z } from "zod";
import type { LLMProvider } from "../llm/provider";
import type { ChatMessage } from "../llm/provider";

const IntentSchema = z.union([
  z.string().min(3),
  z.object({
    query: z.string().min(3),
    rationale: z.string().optional()
  })
]);

const PlanSchema = z.object({
  intents: z.array(IntentSchema).min(2).max(6),
  must_include: z.array(z.string()).default([]),
  time_sensitivity: z.enum(["none", "recent", "current"]).default("none")
});

export type Plan = {
  intents: string[];
  must_include: string[];
  time_sensitivity: "none" | "recent" | "current";
};

function normalizePlan(raw: z.infer<typeof PlanSchema>): Plan {
  const intents = raw.intents.map((i) => (typeof i === "string" ? i : i.query));
  return {
    intents,
    must_include: raw.must_include ?? [],
    time_sensitivity: raw.time_sensitivity ?? "none"
  };
}

/**
 * Planner should never throw in production. If JSON parsing fails,
 * fall back to a minimal plan.
 */
export async function planQuery(llm: LLMProvider, userQuestion: string): Promise<Plan> {
  const messages: ChatMessage[] = [
    {
      role: "user",
      content: [
        "Create a web research plan for the question below.",
        "Return 2-6 search intents optimized for authoritative sources and primary references.",
        "Output ONLY JSON.",
        "",
        "Return JSON with keys:",
        '- intents: array of strings (search queries). You MAY return objects { "query": "...", "rationale": "..." } but query must exist.',
        '- must_include: array of strings (optional)',
        '- time_sensitivity: one of "none" | "recent" | "current"',
        "",
        "Question:",
        userQuestion
      ].join("\n")
    }
  ];

  try {
    const { json } = await llm.chat<z.infer<typeof PlanSchema>>({
      messages,
      temperature: 0.2,
      json: {
        instruction:
          '{"intents":["search query 1","search query 2"],"must_include":["..."],"time_sensitivity":"none|recent|current"}',
        parse: (raw) => PlanSchema.parse(raw)
      }
    });

    return normalizePlan(json!);
  } catch {
    // Safe fallback plan
    const q = userQuestion.trim();
    return {
      intents: [
        q,
        `${q} primary source`,
        `${q} overview`
      ].slice(0, 3),
      must_include: [],
      time_sensitivity: "none"
    };
  }
}

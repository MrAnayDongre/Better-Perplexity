export type TraceEvent =
  | { type: "planner"; intents: string[] }
  | { type: "search"; query: string; results: number }
  | { type: "fetch"; url: string; status: number }
  | { type: "select"; selected: Array<{ url: string; reason: string }> }
  | { type: "timing"; ms: number };

export type ClaimSupportLabel = "supported" | "weak" | "unsupported";

export type ClaimRecord = {
  id: string;
  claim: string;
  label: ClaimSupportLabel;
  score: number;
  evidence: Array<{ sourceUrl: string; snippet: string }>;
};

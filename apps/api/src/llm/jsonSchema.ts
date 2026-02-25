export function jsonOnlySystemPrompt(instruction: string): string {
  return [
    "You MUST output ONLY valid JSON.",
    "No markdown. No prose. No code fences.",
    `JSON Spec: ${instruction}`
  ].join("\n");
}

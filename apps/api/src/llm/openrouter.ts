import { env } from "../services/env";
import { jsonOnlySystemPrompt } from "./jsonSchema";
import type { ChatMessage, LLMProvider } from "./provider";

function safeJsonParse(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    const firstObj = t.indexOf("{");
    const firstArr = t.indexOf("[");
    const start =
      firstObj === -1 ? firstArr : firstArr === -1 ? firstObj : Math.min(firstObj, firstArr);

    if (start === -1) throw new Error("Model did not return JSON.");

    const endObj = t.lastIndexOf("}");
    const endArr = t.lastIndexOf("]");
    const end = Math.max(endObj, endArr);

    if (end <= start) throw new Error("Model returned malformed JSON.");

    const slice = t.slice(start, end + 1);
    return JSON.parse(slice);
  }
}

/**
 * OpenRouter Chat Completions wrapper.
 */
export class OpenRouterProvider implements LLMProvider {
  private apiKey = env.OPENROUTER_API_KEY;
  private model = env.OPENROUTER_MODEL;

  private ensureKey() {
    if (!this.apiKey) throw new Error("OPENROUTER_API_KEY is not set.");
  }

  async chat<TJson = never>(opts: {
    messages: ChatMessage[];
    temperature?: number;
    json?: { instruction: string; parse: (raw: unknown) => TJson };
  }): Promise<{ text: string; json?: TJson }> {
    this.ensureKey();

    const messages = opts.json
      ? [{ role: "system" as const, content: jsonOnlySystemPrompt(opts.json.instruction) }, ...opts.messages]
      : opts.messages;

    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost",
        "X-Title": "Better-Perplexity"
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: opts.temperature ?? 0.2,
        stream: false
      })
    });

    if (!res.ok) throw new Error(`OpenRouter chat failed (${res.status}): ${await res.text()}`);

    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content ?? "";

    if (!opts.json) return { text };

    const raw = safeJsonParse(text);
    const parsed = opts.json.parse(raw);
    return { text, json: parsed };
  }

  async streamChat(opts: { messages: ChatMessage[]; temperature?: number; onToken: (chunk: string) => void }) {
    this.ensureKey();

    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost",
        "X-Title": "Better-Perplexity"
      },
      body: JSON.stringify({
        model: this.model,
        messages: opts.messages,
        temperature: opts.temperature ?? 0.2,
        stream: true
      })
    });

    if (!res.ok || !res.body) throw new Error(`OpenRouter stream failed (${res.status}): ${await res.text()}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";

      for (const frame of frames) {
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;

        const payload = line.slice("data: ".length).trim();
        if (payload === "[DONE]") return;

        const obj = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
        const chunk = obj.choices?.[0]?.delta?.content ?? "";
        if (chunk) opts.onToken(chunk);
      }
    }
  }
}

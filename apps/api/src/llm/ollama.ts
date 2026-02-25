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

    return JSON.parse(t.slice(start, end + 1));
  }
}

/**
 * Ollama Chat API wrapper.
 *
 * IMPORTANT:
 * - Many Ollama builds/configs stream JSONL fine, but it's also easy to get into
 *   situations where parsing yields empty chunks (proxy buffering, format mismatch).
 * - For demo reliability, we "stream" by doing a normal completion then chunking output.
 */
export class OllamaProvider implements LLMProvider {
  private baseUrl = env.OLLAMA_BASE_URL;
  private model: string;

  constructor(modelOverride?: string) {
    this.model = modelOverride ?? env.OLLAMA_MODEL;
  }

  private options(temperature?: number) {
    return {
      ...(temperature != null ? { temperature } : {}),
      ...(process.env.OLLAMA_NUM_PREDICT ? { num_predict: Number(process.env.OLLAMA_NUM_PREDICT) } : {}),
      ...(process.env.OLLAMA_TOP_P ? { top_p: Number(process.env.OLLAMA_TOP_P) } : {}),
      ...(process.env.OLLAMA_REPEAT_PENALTY ? { repeat_penalty: Number(process.env.OLLAMA_REPEAT_PENALTY) } : {})
    };
  }

  async chat<TJson = never>(opts: {
    messages: ChatMessage[];
    temperature?: number;
    json?: { instruction: string; parse: (raw: unknown) => TJson };
  }): Promise<{ text: string; json?: TJson }> {
    const messages = opts.json
      ? [{ role: "system" as const, content: jsonOnlySystemPrompt(opts.json.instruction) }, ...opts.messages]
      : opts.messages;

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: false,
        options: this.options(opts.temperature)
      })
    });

    if (!res.ok) throw new Error(`Ollama chat failed (${res.status}): ${await res.text()}`);

    const data = (await res.json()) as any;

// Ollama can return different shapes depending on version/endpoint.
// Prefer chat shape, then fallback to legacy generate shape.
const text =
  (data?.message?.content as string | undefined) ??
  (data?.response as string | undefined) ??
  (data?.choices?.[0]?.message?.content as string | undefined) ??
  "";

    if (!opts.json) return { text };

    const raw = safeJsonParse(text);
    const parsed = opts.json.parse(raw);
    return { text, json: parsed };
  }

  async streamChat(opts: { messages: ChatMessage[]; temperature?: number; onToken: (chunk: string) => void }) {
    // "Fake" stream: get full text then chunk it out.
    const { text } = await this.chat({ messages: opts.messages, temperature: opts.temperature });

    const chunkSize = 60;
    for (let i = 0; i < text.length; i += chunkSize) {
      opts.onToken(text.slice(i, i + chunkSize));
      // tiny yield so UI feels live without slowing too much
      await new Promise((r) => setTimeout(r, 5));
    }
  }
}

import { env } from "../services/env";
import type { LLMProvider } from "./provider";
import { OllamaProvider } from "./ollama";
import { OpenRouterProvider } from "./openrouter";

export function getLLM(): LLMProvider {
  return env.LLM_PROVIDER === "openrouter" ? new OpenRouterProvider() : new OllamaProvider(env.OLLAMA_MODEL);
}

/**
 * Fast LLM for cheap steps (planning / claim extraction).
 * - For OpenRouter, we just reuse the same provider.
 * - For Ollama, use OLLAMA_MODEL_FAST if present.
 */
export function getLLMFast(): LLMProvider {
  if (env.LLM_PROVIDER === "openrouter") return new OpenRouterProvider();
  const fast = process.env.OLLAMA_MODEL_FAST || env.OLLAMA_MODEL;
  return new OllamaProvider(fast);
}

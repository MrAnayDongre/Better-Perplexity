import { z } from "zod";

const EnvSchema = z.object({
  PORT: z.string().default("8787"),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),

  LLM_PROVIDER: z.enum(["ollama", "openrouter"]).default("ollama"),

  OLLAMA_BASE_URL: z.string().default("http://localhost:11434"),
  OLLAMA_MODEL: z.string().default("llama3.1"),

  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().default("anthropic/claude-3.5-sonnet"),

  SERPER_API_KEY: z.string().optional(),

  UPSTASH_REDIS_REST_URL: z.string().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional()
});

export const env = EnvSchema.parse(process.env);

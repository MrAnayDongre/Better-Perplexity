export type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type LLMJsonSpec<T> = {
  /**
   * Short JSON schema-like instruction. The model must output ONLY JSON.
   */
  instruction: string;

  /**
   * Parse/validate JSON object into T (e.g., via Zod).
   * This should throw if invalid.
   */
  parse: (raw: unknown) => T;
};

export type ChatOptions<TJson> = {
  messages: ChatMessage[];
  temperature?: number;

  /**
   * If provided, the model is instructed to output ONLY JSON and the output
   * is parsed/validated via json.parse(...).
   */
  json?: LLMJsonSpec<TJson>;
};

export interface LLMProvider {
  chat<TJson = never>(opts: ChatOptions<TJson>): Promise<{ text: string; json?: TJson }>;

  /**
   * Stream incremental assistant text chunks in-order.
   * Used for the final user-visible answer.
   */
  streamChat(opts: {
    messages: ChatMessage[];
    temperature?: number;
    onToken: (chunk: string) => void;
  }): Promise<void>;
}
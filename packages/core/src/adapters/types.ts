import type { ChatChunk, ChatRequest, ProviderName } from '../types';

export interface LLMAdapter {
  readonly name: ProviderName;
  readonly supportsTools: boolean;
  /** True if the adapter natively handles ContentBlock arrays with type='document' (PDFs). */
  readonly supportsPDFs?: boolean;
  chat(request: ChatRequest): AsyncIterable<ChatChunk>;
  estimateTokens(text: string): number;
  testConnection(): Promise<{ ok: boolean; error?: string }>;
}

export interface AdapterConfig {
  apiKey: string;
  baseUrl?: string;
  model: string;
  fetchImpl?: typeof fetch; // for tests
  /** Provider inactivity timeout; defaults to MINDBASE_LLM_TIMEOUT_MS (120000). */
  timeoutMs?: number;
}

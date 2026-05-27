export const PROVIDER_IDS = ["openai", "cloudflare"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const TOOLS = ["search", "contents", "answer", "research"] as const;
export type Tool = (typeof TOOLS)[number];
export type Tools = Partial<Record<Tool, ProviderId>>;

export interface ExecutionSettings {
  requestTimeoutMs?: number;
  retryCount?: number;
  retryDelayMs?: number;
  researchTimeoutMs?: number;
}

export interface Settings extends ExecutionSettings {}

export type ProviderCredentials = Record<string, string>;

export interface Provider<TOptions = Record<string, unknown>> {
  credentials?: ProviderCredentials;
  options?: TOptions;
  settings?: ExecutionSettings;
}

export interface OpenAISearchOptions {
  model?: string;
  instructions?: string;
}

export interface OpenAIAnswerOptions {
  model?: string;
  instructions?: string;
}

export interface OpenAIResearchOptions {
  model?: string;
  instructions?: string;
  max_tool_calls?: number;
}

export interface OpenAIOptions {
  search?: OpenAISearchOptions;
  answer?: OpenAIAnswerOptions;
  research?: OpenAIResearchOptions;
}

export type OpenAIAuthHeader = "bearer" | "api-key" | "both";

export interface OpenAI extends Provider<OpenAIOptions> {
  baseUrl?: string;
  /**
   * Defaults to `api-key` for Azure-looking hosts and `bearer` otherwise.
   * `both` is available for OpenAI-compatible gateways that accept either.
   */
  authHeader?: OpenAIAuthHeader;
}

export interface Cloudflare extends Provider<Record<string, unknown>> {
  accountId?: string;
}

export interface Providers {
  openai?: OpenAI;
  cloudflare?: Cloudflare;
}

export interface WebProviders {
  tools?: Tools;
  settings?: Settings;
  providers?: Providers;
}

export type ProviderConfigMap = {
  openai: OpenAI;
  cloudflare: Cloudflare;
};

export type ProviderConfig<TProviderId extends ProviderId = ProviderId> =
  ProviderConfigMap[TProviderId];

export type ProviderCapabilityStatus =
  | { state: "ready" }
  | { state: "deferred_secret" }
  | { state: "missing_api_key" }
  | { state: "invalid_config"; detail: string };

export interface ProviderCapabilityStatusOptions {
  resolveSecrets?: boolean;
}

export interface ProviderContext {
  cwd: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  idempotencyKey?: string;
  fetch?: typeof fetch;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

export interface SearchResponse {
  provider: ProviderId;
  results: SearchResult[];
}

export interface ContentsAnswer {
  url: string;
  content?: string;
  summary?: unknown;
  metadata?: Record<string, unknown>;
  error?: string;
}

export interface ContentsResponse {
  provider: ProviderId;
  answers: ContentsAnswer[];
}

export interface ToolOutput {
  provider: ProviderId;
  text: string;
  itemCount?: number;
  metadata?: Record<string, unknown>;
}

export interface SearchDetails {
  tool: "web_search";
  provider: ProviderId;
  queryCount: number;
  failedQueryCount: number;
  resultCount: number;
}

export interface ContentsDetails {
  tool: "web_contents";
  provider: ProviderId;
  itemCount?: number;
}

export interface AnswerDetails {
  tool: "web_answer";
  provider: ProviderId;
  itemCount?: number;
  queryCount: number;
  failedQueryCount: number;
}

export interface ResearchDetails {
  tool: "web_research";
  provider: ProviderId;
}

export type ToolDetails =
  | SearchDetails
  | ContentsDetails
  | AnswerDetails
  | ResearchDetails;

export interface WebResearchRequest {
  tool: "web_research";
  id: string;
  provider: ProviderId;
  input: string;
  outputPath: string;
  startedAt: string;
  progress?: string;
}

export interface WebResearchResult extends WebResearchRequest {
  status: "completed" | "failed";
  completedAt: string;
  elapsedMs: number;
  itemCount?: number;
  error?: string;
}

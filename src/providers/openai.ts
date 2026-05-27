import { resolveConfigValue } from "../config-values.js";
import {
  DEFAULT_RESEARCH_POLL_INTERVAL_MS,
  DEFAULT_RESEARCH_TIMEOUT_MS,
  fetchJson,
  formatErrorMessage,
  sleep,
  throwIfAborted,
} from "../http.js";
import type {
  OpenAI,
  OpenAIAnswerOptions,
  OpenAIAuthHeader,
  OpenAIResearchOptions,
  OpenAISearchOptions,
  ProviderCapabilityStatus,
  ProviderCapabilityStatusOptions,
  ProviderContext,
  SearchResponse,
  ToolOutput,
} from "../types.js";
import { formatConfigValueError, isSecretReference } from "../config-values.js";

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1/";
export const DEFAULT_SEARCH_MODEL = "gpt-4.1";
export const DEFAULT_ANSWER_MODEL = "gpt-4.1";
export const DEFAULT_RESEARCH_MODEL = "o4-mini-deep-research";

const OPENAI_PROVIDER_ID = "openai" as const;

const searchResultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["sources"],
  properties: {
    sources: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "url", "snippet"],
        properties: {
          title: { type: "string" },
          url: { type: "string" },
          snippet: { type: "string" },
        },
      },
    },
  },
} as const;

interface OpenAIResponseLike {
  id?: string;
  model?: string;
  status?:
    | "completed"
    | "failed"
    | "in_progress"
    | "cancelled"
    | "queued"
    | "incomplete";
  output_text?: string;
  error?: { message?: string } | string | null;
  incomplete_details?: { reason?: "max_output_tokens" | "content_filter" | string } | null;
  output?: Array<{
    type?: string;
    content?: Array<{
      type?: string;
      text?: string;
      annotations?: Array<{
        type?: string;
        title?: string;
        url?: string;
        start_index?: number;
        end_index?: number;
      }>;
    }>;
  }>;
}

export function createOpenAITemplate(): OpenAI {
  return {
    credentials: { api: "OPENAI_API_KEY" },
    options: {
      search: { model: DEFAULT_SEARCH_MODEL },
      answer: { model: DEFAULT_ANSWER_MODEL },
      research: { model: DEFAULT_RESEARCH_MODEL },
    },
  };
}

export function getOpenAICapabilityStatus(
  config: OpenAI | undefined,
  options: ProviderCapabilityStatusOptions = {},
): ProviderCapabilityStatus {
  return getConfigSecretStatus(config?.credentials?.api, "API key", options);
}

export async function searchOpenAI(
  query: string,
  maxResults: number,
  config: OpenAI,
  context: ProviderContext,
  options?: Record<string, unknown>,
): Promise<SearchResponse> {
  const response = await createOpenAIResponse(
    buildOpenAISearchRequest(query, maxResults, config, options),
    config,
    context,
  );
  return parseSearchResponse(response, maxResults);
}

export async function answerOpenAI(
  query: string,
  config: OpenAI,
  context: ProviderContext,
  options?: Record<string, unknown>,
): Promise<ToolOutput> {
  const response = await createOpenAIResponse(
    buildOpenAIAnswerRequest(query, config, options),
    config,
    context,
  );
  return ensureCompletedResponse(response, "answer");
}

export async function researchOpenAI(
  input: string,
  config: OpenAI,
  context: ProviderContext,
  options?: Record<string, unknown>,
): Promise<ToolOutput> {
  const timeoutMs = config.settings?.researchTimeoutMs ?? DEFAULT_RESEARCH_TIMEOUT_MS;
  const startedAt = Date.now();
  context.onProgress?.("Starting research via OpenAI");

  const created = await createOpenAIResponse(
    buildOpenAIResearchRequest(input, config, options),
    config,
    context,
  );
  const id = readNonEmptyString(created.id);
  if (!id) throw new Error("OpenAI research did not return a response id.");
  context.onProgress?.(`OpenAI research started: ${id}`);

  while (true) {
    throwIfAborted(context.signal, "OpenAI research aborted.");
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`OpenAI research exceeded ${Math.floor(timeoutMs / 1000)}s.`);
    }

    await sleep(DEFAULT_RESEARCH_POLL_INTERVAL_MS, context.signal);
    let response: OpenAIResponseLike;
    try {
      response = await retrieveOpenAIResponse(id, config, context);
    } catch (error) {
      context.onProgress?.(`OpenAI research poll failed transiently: ${formatErrorMessage(error)}`);
      continue;
    }

    const status = response.status ?? "completed";
    context.onProgress?.(`OpenAI research status: ${status}`);

    if (status === "completed") return formatResponseOutput(response, "research");
    if (status === "failed") throw new Error(readErrorMessage(response) ?? "research failed");
    if (status === "cancelled") throw new Error("research was canceled");
    if (status === "incomplete") throw new Error(formatIncompleteError(response, "research"));
  }
}

export function buildOpenAISearchRequest(
  query: string,
  maxResults: number,
  config: OpenAI,
  options?: Record<string, unknown>,
): Record<string, unknown> {
  const mergedOptions = resolveOpenAISearchOptions(config, options);
  const model = mergedOptions.model ?? DEFAULT_SEARCH_MODEL;
  const instructions = mergedOptions.instructions;

  return {
    model,
    input: [
      "Search the public web and return only the most relevant sources for the user's query.",
      `Return at most ${maxResults} sources.`,
      "Prefer official, primary, or highly reputable sources when available.",
      "Each snippet should be short, specific, and grounded in the retrieved source.",
      "Return only data matching the provided JSON schema.",
      "",
      `User query: ${query}`,
    ].join("\n"),
    tools: [{ type: "web_search_preview" }],
    text: {
      format: {
        type: "json_schema",
        name: "openai_web_search_results",
        schema: searchResultSchema,
        strict: true,
      },
    },
    ...(instructions ? { instructions } : {}),
  };
}

export function buildOpenAIAnswerRequest(
  query: string,
  config: OpenAI,
  options?: Record<string, unknown>,
): Record<string, unknown> {
  const mergedOptions = resolveOpenAIAnswerOptions(config, options);
  const model = mergedOptions.model ?? DEFAULT_ANSWER_MODEL;
  const instructions = mergedOptions.instructions;

  return {
    model,
    input: query,
    tools: [{ type: "web_search_preview" }],
    ...(instructions ? { instructions } : {}),
  };
}

export function buildOpenAIResearchRequest(
  input: string,
  config: OpenAI,
  options?: Record<string, unknown>,
): Record<string, unknown> {
  const mergedOptions = resolveOpenAIResearchOptions(config, options);
  const model = mergedOptions.model ?? DEFAULT_RESEARCH_MODEL;
  const instructions = mergedOptions.instructions;
  const maxToolCalls = mergedOptions.max_tool_calls;

  return {
    model,
    input,
    background: true,
    tools: [{ type: "web_search_preview" }],
    ...(instructions ? { instructions } : {}),
    ...(maxToolCalls ? { max_tool_calls: maxToolCalls } : {}),
  };
}

export async function createOpenAIResponse(
  body: Record<string, unknown>,
  config: OpenAI,
  context: ProviderContext,
): Promise<OpenAIResponseLike> {
  return await fetchJson<OpenAIResponseLike>(
    buildOpenAIUrl(config, "responses"),
    {
      method: "POST",
      headers: buildOpenAIHeaders(config, context.idempotencyKey),
      body: JSON.stringify(body),
    },
    context,
    config.settings,
  );
}

export async function retrieveOpenAIResponse(
  id: string,
  config: OpenAI,
  context: ProviderContext,
): Promise<OpenAIResponseLike> {
  return await fetchJson<OpenAIResponseLike>(
    buildOpenAIUrl(config, `responses/${encodeURIComponent(id)}`),
    {
      method: "GET",
      headers: buildOpenAIHeaders(config),
    },
    context,
    config.settings,
  );
}

export function buildOpenAIUrl(config: OpenAI, path: string): string {
  const baseUrl = resolveConfigValue(config.baseUrl) ?? DEFAULT_OPENAI_BASE_URL;
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export function buildOpenAIHeaders(
  config: OpenAI,
  idempotencyKey?: string,
): Record<string, string> {
  const apiKey = resolveConfigValue(config.credentials?.api);
  if (!apiKey) throw new Error("OpenAI provider is missing an API key.");

  const authHeader = resolveOpenAIAuthHeader(config);
  return {
    "content-type": "application/json",
    ...(authHeader === "bearer" || authHeader === "both"
      ? { authorization: `Bearer ${apiKey}` }
      : {}),
    ...(authHeader === "api-key" || authHeader === "both" ? { "api-key": apiKey } : {}),
    ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
  };
}

export function resolveOpenAIAuthHeader(config: OpenAI): OpenAIAuthHeader {
  if (config.authHeader) return config.authHeader;
  const baseUrl = resolveConfigValue(config.baseUrl) ?? DEFAULT_OPENAI_BASE_URL;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (host.endsWith(".openai.azure.com") || host.endsWith(".cognitiveservices.azure.com")) {
      return "api-key";
    }
  } catch {
    // Invalid baseUrl is reported later by fetch URL construction.
  }
  return "bearer";
}

function resolveOpenAISearchOptions(
  config: OpenAI,
  options?: Record<string, unknown>,
): OpenAISearchOptions {
  const mergedOptions = { ...(config.options?.search ?? {}), ...(options ?? {}) };
  return {
    model: readNonEmptyString(mergedOptions.model),
    instructions: readNonEmptyString(mergedOptions.instructions),
  };
}

function resolveOpenAIAnswerOptions(
  config: OpenAI,
  options?: Record<string, unknown>,
): OpenAIAnswerOptions {
  const mergedOptions = { ...(config.options?.answer ?? {}), ...(options ?? {}) };
  return {
    model: readNonEmptyString(mergedOptions.model),
    instructions: readNonEmptyString(mergedOptions.instructions),
  };
}

function resolveOpenAIResearchOptions(
  config: OpenAI,
  options?: Record<string, unknown>,
): OpenAIResearchOptions {
  const mergedOptions = { ...(config.options?.research ?? {}), ...(options ?? {}) };
  return {
    model: readNonEmptyString(mergedOptions.model),
    instructions: readNonEmptyString(mergedOptions.instructions),
    max_tool_calls: readPositiveInteger(mergedOptions.max_tool_calls),
  };
}

function parseSearchResponse(response: OpenAIResponseLike, maxResults: number): SearchResponse {
  const status = response.status ?? "completed";
  if (status === "failed") throw new Error(readErrorMessage(response) ?? "search failed");
  if (status === "cancelled") throw new Error("search was canceled");
  if (status === "incomplete") throw new Error(formatIncompleteError(response, "search"));
  if (status !== "completed") throw new Error(`search did not complete (status: ${status})`);

  const payload = parseSearchPayload(getOutputText(response));
  return {
    provider: OPENAI_PROVIDER_ID,
    results: payload.sources.slice(0, maxResults).map((source) => ({
      title: source.title.trim(),
      url: source.url.trim(),
      snippet: trimSnippet(source.snippet),
    })),
  };
}

function ensureCompletedResponse(
  response: OpenAIResponseLike,
  operation: "answer" | "research",
): ToolOutput {
  const status = response.status ?? "completed";
  if (status === "completed") return formatResponseOutput(response, operation);
  if (status === "failed") throw new Error(readErrorMessage(response) ?? `${operation} failed`);
  if (status === "cancelled") throw new Error(`${operation} was canceled`);
  if (status === "incomplete") throw new Error(formatIncompleteError(response, operation));
  throw new Error(`${operation} did not complete (status: ${status})`);
}

function formatResponseOutput(
  response: OpenAIResponseLike,
  operation: "answer" | "research",
): ToolOutput {
  const lines: string[] = [];
  lines.push(getOutputText(response) || `OpenAI ${operation} completed without textual output.`);

  const citations = extractUrlCitations(response);
  if (citations.length > 0) {
    lines.push("", "Sources:");
    for (const [index, citation] of citations.entries()) {
      lines.push(`${index + 1}. ${citation.title}`);
      lines.push(`   ${citation.url}`);
    }
  }

  return {
    provider: OPENAI_PROVIDER_ID,
    text: lines.join("\n").trimEnd(),
    itemCount: citations.length,
    metadata: {
      responseId: response.id,
      model: response.model,
      citations,
    },
  };
}

function extractUrlCitations(response: OpenAIResponseLike): Array<{
  title: string;
  url: string;
  startIndex: number;
  endIndex: number;
}> {
  const citations: Array<{
    title: string;
    url: string;
    startIndex: number;
    endIndex: number;
  }> = [];
  const seen = new Set<string>();

  for (const item of response.output ?? []) {
    if (item.type !== "message" || !item.content) continue;
    for (const content of item.content) {
      if (content.type !== "output_text" || !content.annotations) continue;
      for (const annotation of content.annotations) {
        if (annotation.type !== "url_citation") continue;
        const title = readNonEmptyString(annotation.title);
        const url = readNonEmptyString(annotation.url);
        const startIndex = readInteger(annotation.start_index);
        const endIndex = readInteger(annotation.end_index);
        if (!title || !url || startIndex === undefined || endIndex === undefined) continue;
        const key = `${title}\0${url}\0${startIndex}\0${endIndex}`;
        if (seen.has(key)) continue;
        seen.add(key);
        citations.push({ title, url, startIndex, endIndex });
      }
    }
  }

  return citations;
}

function parseSearchPayload(text: string): {
  sources: Array<{ title: string; url: string; snippet: string }>;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`search returned invalid JSON: ${(error as Error).message}`);
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("sources" in parsed) ||
    !Array.isArray((parsed as { sources?: unknown }).sources)
  ) {
    throw new Error("search output must include a 'sources' array");
  }

  return {
    sources: (parsed as { sources: unknown[] }).sources.map((source, index) => {
      if (typeof source !== "object" || source === null) {
        throw new Error(`search source at index ${index} must be an object`);
      }
      const entry = source as Record<string, unknown>;
      const title = readNonEmptyString(entry.title);
      const url = readNonEmptyString(entry.url);
      const snippet = readNonEmptyString(entry.snippet);
      if (!title) throw new Error(`search source at index ${index} is missing title`);
      if (!url) throw new Error(`search source at index ${index} is missing url`);
      if (!snippet) throw new Error(`search source at index ${index} is missing snippet`);
      return { title, url, snippet };
    }),
  };
}

function getOutputText(response: OpenAIResponseLike): string {
  const direct = readNonEmptyString(response.output_text);
  if (direct) return direct.trim();

  const parts: string[] = [];
  for (const item of response.output ?? []) {
    if (item.type !== "message" || !item.content) continue;
    for (const content of item.content) {
      if (content.type === "output_text" && typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }
  return parts.join("\n").trim();
}

function readErrorMessage(response: OpenAIResponseLike): string | undefined {
  if (typeof response.error === "string") return response.error;
  return readNonEmptyString(response.error?.message);
}

function formatIncompleteError(
  response: OpenAIResponseLike,
  operation: "search" | "answer" | "research",
): string {
  const reason = response.incomplete_details?.reason;
  return reason ? `${operation} ended incomplete (${reason})` : `${operation} ended incomplete`;
}

function getConfigSecretStatus(
  reference: string | undefined,
  label: string,
  options: ProviderCapabilityStatusOptions,
): ProviderCapabilityStatus {
  if (!reference) return { state: "missing_api_key" };
  if (options.resolveSecrets === false && isSecretReference(reference)) {
    return { state: "deferred_secret" };
  }
  try {
    return resolveConfigValue(reference) ? { state: "ready" } : { state: "missing_api_key" };
  } catch (error) {
    return { state: "invalid_config", detail: `${label}: ${formatConfigValueError(error)}` };
  }
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function readInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function trimSnippet(input: string | undefined, maxLength = 300): string {
  const text = (input ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionAPI,
  type ExtensionContext,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createDefaultConfig, getConfigPath, loadConfig, supportsTool, writeConfigFile } from "./config.js";
import { formatErrorMessage } from "./http.js";
import { contentsCloudflare, createCloudflareTemplate, getCloudflareCapabilityStatus } from "./providers/cloudflare.js";
import { answerOpenAI, createOpenAITemplate, getOpenAICapabilityStatus, researchOpenAI, searchOpenAI } from "./providers/openai.js";
import {
  buildAnswerBatchError,
  buildSearchBatchError,
  clampResults,
  formatAnswerResponses,
  formatSearchResponses,
  normalizeQueries,
  renderContentsAnswers,
  type AnswerQueryOutcome,
  type SearchQueryOutcome,
} from "./render.js";
import type {
  AnswerDetails,
  Cloudflare,
  ContentsDetails,
  ExecutionSettings,
  OpenAI,
  ProviderCapabilityStatus,
  ProviderConfig,
  ProviderId,
  SearchDetails,
  SearchResponse,
  Tool,
  ToolDetails,
  ToolOutput,
  WebProviders,
  WebResearchRequest,
  WebResearchResult,
} from "./types.js";
import { PROVIDER_IDS, TOOLS } from "./types.js";

const DEFAULT_MAX_RESULTS = 5;
const MAX_ALLOWED_RESULTS = 20;
const MAX_SEARCH_QUERIES = 10;
const RESEARCH_ARTIFACTS_DIR = join(".pi", "artifacts", "research");
const WEB_RESEARCH_RESULT_MESSAGE_TYPE = "web-research-result";
const pendingResearchTasks = new Set<Promise<void>>();

const CAPABILITY_TOOL_NAMES: Record<Tool, string> = {
  search: "web_search",
  contents: "web_contents",
  answer: "web_answer",
  research: "web_research",
};
const MANAGED_TOOL_NAMES = Object.values(CAPABILITY_TOOL_NAMES);

interface SearchToolRequest {
  queries: string[];
  maxResults?: number;
  options?: Record<string, unknown>;
}

interface AnswerToolRequest {
  queries: string[];
  options?: Record<string, unknown>;
}

interface ContentsToolRequest {
  urls: string[];
  options?: Record<string, unknown>;
}

interface ResearchToolRequest {
  input: string;
  options?: Record<string, unknown>;
}

type ToolUpdateCallback =
  | ((update: { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }) => void)
  | undefined;

export default function webProvidersAzCfExtension(pi: ExtensionAPI) {
  pi.registerCommand("web-providers", {
    description: "Show or initialize minimal web providers config",
    handler: async (args, ctx) => {
      if (args.trim() === "init") {
        const path = await writeConfigFile(createDefaultConfig());
        ctx.ui.notify(`Wrote ${path}`, "info");
        await refreshManagedTools(pi, ctx.cwd, { addAvailable: true });
        return;
      }
      ctx.ui.notify(`Config: ${getConfigPath()} (use /web-providers init to write a template)`, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    await refreshManagedToolsOnStartup(pi, ctx.cwd, { addAvailable: true });
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    await refreshManagedToolsOnStartup(pi, ctx.cwd, { addAvailable: false });
  });
}

async function refreshManagedToolsOnStartup(
  pi: ExtensionAPI,
  cwd: string,
  options: { addAvailable: boolean },
): Promise<void> {
  try {
    await refreshManagedTools(pi, cwd, options);
  } catch (error) {
    pi.sendMessage({
      customType: "web-providers-config-error",
      content: `web-providers config error: ${formatErrorMessage(error).replace(getConfigPath(), "~/.pi/agent/web-providers.json")}`,
      display: true,
    });
    await syncManagedToolAvailability(
      pi,
      new Set(pi.getActiveTools().filter((toolName) => !MANAGED_TOOL_NAMES.includes(toolName))),
    );
  }
}

async function refreshManagedTools(
  pi: ExtensionAPI,
  cwd: string,
  options: { addAvailable: boolean },
): Promise<void> {
  const config = await loadConfig();
  const available = getAvailableTools(config, cwd);

  if (available.search) registerWebSearchTool(pi, available.search);
  if (available.contents) registerWebContentsTool(pi, available.contents);
  if (available.answer) registerWebAnswerTool(pi, available.answer);
  if (available.research) registerWebResearchTool(pi, available.research);

  const nextActiveTools = new Set(pi.getActiveTools());
  const availableToolNames = new Set(
    (Object.keys(available) as Tool[]).map((tool) => CAPABILITY_TOOL_NAMES[tool]),
  );
  for (const toolName of MANAGED_TOOL_NAMES) {
    if (availableToolNames.has(toolName)) {
      if (options.addAvailable) nextActiveTools.add(toolName);
    } else {
      nextActiveTools.delete(toolName);
    }
  }

  await syncManagedToolAvailability(pi, nextActiveTools);
}

async function syncManagedToolAvailability(
  pi: ExtensionAPI,
  nextActiveTools: ReadonlySet<string>,
): Promise<void> {
  const activeTools = pi.getActiveTools();
  const changed = activeTools.length !== nextActiveTools.size || activeTools.some((name) => !nextActiveTools.has(name));
  if (changed) pi.setActiveTools(Array.from(nextActiveTools));
}

function getAvailableTools(config: WebProviders, cwd: string): Partial<Record<Tool, ProviderId>> {
  const available: Partial<Record<Tool, ProviderId>> = {};
  for (const tool of TOOLS) {
    const providerId = config.tools?.[tool];
    if (!providerId || !supportsTool(providerId, tool)) continue;
    const status = getProviderCapabilityStatus(config, cwd, providerId, { resolveSecrets: false });
    if (isProviderCapabilityExposable(status)) available[tool] = providerId;
  }
  return available;
}

function registerWebSearchTool(pi: ExtensionAPI, providerId: ProviderId): void {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: `Find likely sources on the public web for up to ${MAX_SEARCH_QUERIES} queries in a single call and return titles, URLs, and snippets grouped by query. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} when needed.`,
    promptGuidelines: [
      "Use web_search to find likely web sources; batch related searches when grouped comparison matters.",
    ],
    parameters: Type.Object(
      {
        queries: Type.Array(Type.String({ minLength: 1 }), {
          minItems: 1,
          maxItems: MAX_SEARCH_QUERIES,
          description: `One or more search queries to run in one call (max ${MAX_SEARCH_QUERIES})`,
        }),
        maxResults: Type.Optional(
          Type.Integer({ minimum: 1, maximum: MAX_ALLOWED_RESULTS, description: `Maximum results per query (default: ${DEFAULT_MAX_RESULTS})` }),
        ),
        options: Type.Optional(openAIOptionsSchema("search")),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return await executeSearchTool({
        config: await loadConfig(),
        explicitProvider: providerId,
        request: params as SearchToolRequest,
        context: { cwd: ctx.cwd, signal: signal ?? undefined, progress: createProgressEmitter(onUpdate) },
      });
    },
  });
}

function registerWebContentsTool(pi: ExtensionAPI, providerId: ProviderId): void {
  pi.registerTool({
    name: "web_contents",
    label: "Web Contents",
    description: "Read and extract the main markdown contents of one or more web pages via Cloudflare Browser Rendering.",
    promptGuidelines: ["Use web_contents when source pages need direct inspection."],
    parameters: Type.Object(
      {
        urls: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "One or more URLs to extract" }),
        options: Type.Optional(cloudflareContentsOptionsSchema()),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return await executeContentsTool({
        config: await loadConfig(),
        explicitProvider: providerId,
        request: params as ContentsToolRequest,
        context: { cwd: ctx.cwd, signal: signal ?? undefined, progress: createProgressEmitter(onUpdate) },
      });
    },
  });
}

function registerWebAnswerTool(pi: ExtensionAPI, providerId: ProviderId): void {
  pi.registerTool({
    name: "web_answer",
    label: "Web Answer",
    description: `Answer one or more simple factual questions using web-grounded evidence (up to ${MAX_SEARCH_QUERIES} per call). Prefer web_search plus web_contents when source selection matters, and web_research for multi-step investigations.`,
    promptGuidelines: [
      "Use web_answer as a quick grounded-answer shortcut for simple factual questions, not as a replacement for inspecting sources.",
    ],
    parameters: Type.Object(
      {
        queries: Type.Array(Type.String({ minLength: 1 }), {
          minItems: 1,
          maxItems: MAX_SEARCH_QUERIES,
          description: `One or more questions to answer in one call (max ${MAX_SEARCH_QUERIES})`,
        }),
        options: Type.Optional(openAIOptionsSchema("answer")),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return await executeAnswerTool({
        config: await loadConfig(),
        explicitProvider: providerId,
        request: params as AnswerToolRequest,
        context: { cwd: ctx.cwd, signal: signal ?? undefined, progress: createProgressEmitter(onUpdate) },
      });
    },
  });
}

function registerWebResearchTool(pi: ExtensionAPI, providerId: ProviderId): void {
  pi.registerTool({
    name: "web_research",
    label: "Web Research",
    description: "Start a long-running web research job. Returns immediately with a dispatch notice; the final report is saved to a file and posted later as a custom message.",
    promptGuidelines: [
      "Use web_research for deeper investigations that can finish asynchronously.",
      "Do not expect the final report in the same turn; tell the user that web research has started.",
    ],
    parameters: Type.Object(
      {
        input: Type.String({ minLength: 1, description: "Research brief or question" }),
        options: Type.Optional(openAIOptionsSchema("research")),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return await dispatchWebResearch({
        pi,
        config: await loadConfig(),
        explicitProvider: providerId,
        request: params as ResearchToolRequest,
        context: ctx,
      });
    },
  });
}

async function executeSearchTool({
  config,
  explicitProvider,
  request,
  context,
}: {
  config: WebProviders;
  explicitProvider?: ProviderId;
  request: SearchToolRequest;
  context: { cwd: string; signal?: AbortSignal; progress?: (message: string) => void; fetch?: typeof fetch };
}) {
  const provider = resolveProviderForTool(config, context.cwd, "search", explicitProvider);
  const providerConfig = getEffectiveProviderConfig(config, provider.id);
  const queries = normalizeQueries(request.queries);
  const maxResults = clampResults(request.maxResults, MAX_ALLOWED_RESULTS, DEFAULT_MAX_RESULTS);

  const settled = await Promise.allSettled(
    queries.map(async (query) => {
      context.progress?.(`Searching via ${provider.label}: ${query}`);
      return await searchOpenAI(query, maxResults, providerConfig as OpenAI, {
        cwd: context.cwd,
        signal: context.signal,
        onProgress: context.progress,
        fetch: context.fetch,
      }, request.options);
    }),
  );

  const outcomes: SearchQueryOutcome[] = settled.map((result, index) =>
    result.status === "fulfilled"
      ? { query: queries[index] ?? "", response: result.value }
      : { query: queries[index] ?? "", error: formatProviderError(result.reason) },
  );

  if (outcomes.every((outcome) => outcome.error !== undefined)) throw buildSearchBatchError(outcomes, provider.label);

  const text = await truncateAndSave(formatSearchResponses(outcomes), "web-search");
  const details: SearchDetails = {
    tool: "web_search",
    provider: provider.id,
    queryCount: outcomes.length,
    failedQueryCount: outcomes.filter((outcome) => outcome.error !== undefined).length,
    resultCount: outcomes.reduce((sum, outcome) => sum + (outcome.response?.results.length ?? 0), 0),
  };
  return { content: [{ type: "text" as const, text }], details };
}

async function executeAnswerTool({
  config,
  explicitProvider,
  request,
  context,
}: {
  config: WebProviders;
  explicitProvider?: ProviderId;
  request: AnswerToolRequest;
  context: { cwd: string; signal?: AbortSignal; progress?: (message: string) => void; fetch?: typeof fetch };
}) {
  const provider = resolveProviderForTool(config, context.cwd, "answer", explicitProvider);
  const providerConfig = getEffectiveProviderConfig(config, provider.id);
  const queries = normalizeQueries(request.queries);

  const settled = await Promise.allSettled(
    queries.map(async (query) => {
      context.progress?.(`Answering via ${provider.label}: ${query}`);
      return await answerOpenAI(query, providerConfig as OpenAI, {
        cwd: context.cwd,
        signal: context.signal,
        onProgress: context.progress,
        fetch: context.fetch,
      }, request.options);
    }),
  );

  const outcomes: AnswerQueryOutcome[] = settled.map((result, index) =>
    result.status === "fulfilled"
      ? { query: queries[index] ?? "", text: result.value.text, itemCount: result.value.itemCount }
      : { query: queries[index] ?? "", error: formatProviderError(result.reason) },
  );

  if (outcomes.every((outcome) => outcome.error !== undefined)) throw buildAnswerBatchError(outcomes, provider.label);

  const text = await truncateAndSave(formatAnswerResponses(outcomes), "web-answer");
  const successful = outcomes.filter((outcome) => outcome.error === undefined);
  const details: AnswerDetails = {
    tool: "web_answer",
    provider: provider.id,
    itemCount: successful.length === 1 ? successful[0]?.itemCount : undefined,
    queryCount: outcomes.length,
    failedQueryCount: outcomes.filter((outcome) => outcome.error !== undefined).length,
  };
  return { content: [{ type: "text" as const, text }], details };
}

async function executeContentsTool({
  config,
  explicitProvider,
  request,
  context,
}: {
  config: WebProviders;
  explicitProvider?: ProviderId;
  request: ContentsToolRequest;
  context: { cwd: string; signal?: AbortSignal; progress?: (message: string) => void; fetch?: typeof fetch };
}) {
  const provider = resolveProviderForTool(config, context.cwd, "contents", explicitProvider);
  const providerConfig = getEffectiveProviderConfig(config, provider.id);
  const urls = request.urls.map((url, index) => {
    const trimmed = url.trim();
    if (!trimmed) throw new Error(`urls[${index}] must be a non-empty string.`);
    return trimmed;
  });
  if (urls.length === 0) throw new Error("urls must contain at least one item.");

  context.progress?.(`Fetching contents via ${provider.label} for ${urls.length} URL(s)`);
  const response = await contentsCloudflare(urls, providerConfig as Cloudflare, {
    cwd: context.cwd,
    signal: context.signal,
    onProgress: context.progress,
    fetch: context.fetch,
  }, request.options);
  const rendered = await truncateAndSave(renderContentsAnswers(response.answers), "web-contents");
  const details: ContentsDetails = {
    tool: "web_contents",
    provider: response.provider,
    itemCount: response.answers.length,
  };
  return { content: [{ type: "text" as const, text: rendered }], details };
}

async function dispatchWebResearch({
  pi,
  config,
  explicitProvider,
  request,
  context,
}: {
  pi: Pick<ExtensionAPI, "sendMessage">;
  config: WebProviders;
  explicitProvider?: ProviderId;
  request: ResearchToolRequest;
  context: Pick<ExtensionContext, "cwd">;
}) {
  const provider = resolveProviderForTool(config, context.cwd, "research", explicitProvider);
  const providerConfig = getEffectiveProviderConfig(config, provider.id);
  const webResearchRequest = createWebResearchRequest(context.cwd, provider.id, request.input);

  trackPendingResearchTask(
    runDispatchedWebResearch({
      pi,
      request: webResearchRequest,
      providerConfig,
      input: request.input,
      options: request.options,
      cwd: context.cwd,
    }),
  );

  return {
    content: [{ type: "text" as const, text: `Started web research via ${provider.label}.` }],
    details: webResearchRequest,
  };
}

async function runDispatchedWebResearch({
  pi,
  request,
  providerConfig,
  input,
  options,
  cwd,
}: {
  pi: Pick<ExtensionAPI, "sendMessage">;
  request: WebResearchRequest;
  providerConfig: ProviderConfig;
  input: string;
  options?: Record<string, unknown>;
  cwd: string;
}): Promise<void> {
  let result: WebResearchResult;
  let reportText = "";
  try {
    const response = await researchOpenAI(input, providerConfig as OpenAI, {
      cwd,
      onProgress: (message) => {
        request.progress = message;
      },
    }, options);
    const completedAt = new Date().toISOString();
    result = {
      ...request,
      status: "completed",
      completedAt,
      elapsedMs: Math.max(0, Date.parse(completedAt) - Date.parse(request.startedAt)),
      itemCount: response.itemCount,
    };
    reportText = response.text;
  } catch (error) {
    const completedAt = new Date().toISOString();
    result = {
      ...request,
      status: "failed",
      completedAt,
      elapsedMs: Math.max(0, Date.parse(completedAt) - Date.parse(request.startedAt)),
      error: formatErrorMessage(error),
    };
  }

  await writeWebResearchArtifact(result, reportText);
  pi.sendMessage({
    customType: WEB_RESEARCH_RESULT_MESSAGE_TYPE,
    content: formatWebResearchResultMessage(result, reportText),
    display: true,
    details: result,
  });
}

function resolveProviderForTool(
  config: WebProviders,
  cwd: string,
  tool: Tool,
  explicitProvider?: ProviderId,
): { id: ProviderId; label: string } {
  const providerId = explicitProvider ?? config.tools?.[tool];
  if (!providerId) {
    throw new Error(`No provider is configured for '${tool}'. Run /web-providers init or edit ${getConfigPath()}.`);
  }
  if (!supportsTool(providerId, tool)) throw new Error(`Provider '${providerId}' does not support '${tool}'.`);
  const status = getProviderCapabilityStatus(config, cwd, providerId);
  if (!isProviderCapabilityReady(status)) {
    throw new Error(`Provider '${providerId}' is not available: ${formatProviderCapabilityStatus(status)}.`);
  }
  return { id: providerId, label: providerId === "openai" ? "OpenAI" : "Cloudflare" };
}

function getProviderCapabilityStatus(
  config: WebProviders,
  _cwd: string,
  providerId: ProviderId,
  options = { resolveSecrets: true } as { resolveSecrets?: boolean },
): ProviderCapabilityStatus {
  const providerConfig = getEffectiveProviderConfig(config, providerId);
  return providerId === "openai"
    ? getOpenAICapabilityStatus(providerConfig as OpenAI, options)
    : getCloudflareCapabilityStatus(providerConfig as Cloudflare, options);
}

function isProviderCapabilityReady(status: ProviderCapabilityStatus): boolean {
  return status.state === "ready";
}

function isProviderCapabilityExposable(status: ProviderCapabilityStatus): boolean {
  return status.state === "ready" || status.state === "deferred_secret";
}

function formatProviderCapabilityStatus(status: ProviderCapabilityStatus): string {
  switch (status.state) {
    case "ready":
      return "ready";
    case "deferred_secret":
      return "secret resolves on first use";
    case "missing_api_key":
      return "missing API key";
    case "invalid_config":
      return status.detail;
  }
}

function getEffectiveProviderConfig<TProviderId extends ProviderId>(
  config: WebProviders,
  providerId: TProviderId,
): ProviderConfig<TProviderId> {
  const defaults = (providerId === "openai" ? createOpenAITemplate() : createCloudflareTemplate()) as ProviderConfig<TProviderId>;
  const overrides = (config.providers?.[providerId] ?? {}) as Partial<ProviderConfig<TProviderId>>;
  const merged = {
    ...defaults,
    ...overrides,
    credentials: mergeNestedObjects(defaults.credentials, overrides.credentials),
    options: mergeNestedObjects(defaults.options, overrides.options),
  } as ProviderConfig<TProviderId>;
  const settings = mergeExecutionSettings(config.settings, mergeExecutionSettings(defaults.settings, overrides.settings));
  if (settings) merged.settings = settings;
  else delete merged.settings;
  return merged;
}

function mergeExecutionSettings(
  base: ExecutionSettings | undefined,
  overrides: ExecutionSettings | undefined,
): ExecutionSettings | undefined {
  const merged: ExecutionSettings = {
    requestTimeoutMs: overrides?.requestTimeoutMs ?? base?.requestTimeoutMs,
    retryCount: overrides?.retryCount ?? base?.retryCount,
    retryDelayMs: overrides?.retryDelayMs ?? base?.retryDelayMs,
    researchTimeoutMs: overrides?.researchTimeoutMs ?? base?.researchTimeoutMs,
  };
  return Object.values(merged).some((value) => value !== undefined) ? merged : undefined;
}

function mergeNestedObjects<T>(base: T | undefined, overrides: T | undefined): T | undefined {
  if (base === undefined) return overrides;
  if (overrides === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(overrides)) return overrides;
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    result[key] = isPlainObject(result[key]) && isPlainObject(value) ? mergeNestedObjects(result[key], value) : value;
  }
  return result as T;
}

async function truncateAndSave(text: string, prefix: string): Promise<string> {
  const truncation = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  if (!truncation.truncated) return truncation.content;

  const dir = join(tmpdir(), `pi-web-providers-az-cf-${prefix}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const fullPath = join(dir, "output.txt");
  await writeFile(fullPath, text, "utf-8");
  return (
    truncation.content +
    `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines ` +
    `(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). ` +
    `Full output saved to: ${fullPath}]`
  );
}

function openAIOptionsSchema(capability: "search" | "answer" | "research") {
  return Type.Object(
    {
      model: Type.Optional(Type.String({ description: "OpenAI-compatible Responses API model/deployment to use." })),
      instructions: Type.Optional(Type.String({ description: "Optional instructions that shape source selection and output style." })),
      ...(capability === "research"
        ? {
            max_tool_calls: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum built-in tool calls for a research run." })),
          }
        : {}),
    },
    { additionalProperties: false },
  );
}

function cloudflareContentsOptionsSchema() {
  return Type.Object(
    {
      cacheTTL: Type.Optional(Type.Integer({ minimum: 0, description: "Cloudflare Browser Rendering cache TTL query parameter." })),
      gotoOptions: Type.Optional(
        Type.Object(
          {
            waitUntil: Type.Optional(
              Type.Union([
                Type.Literal("load"),
                Type.Literal("domcontentloaded"),
                Type.Literal("networkidle0"),
                Type.Literal("networkidle2"),
              ]),
            ),
          },
          { additionalProperties: true },
        ),
      ),
    },
    { additionalProperties: true },
  );
}

function createProgressEmitter(onUpdate: ToolUpdateCallback): ((message: string) => void) | undefined {
  if (!onUpdate) return undefined;
  return (message: string) => onUpdate({ content: [{ type: "text", text: message }], details: {} });
}

function createWebResearchRequest(cwd: string, provider: ProviderId, input: string): WebResearchRequest {
  const startedAt = new Date().toISOString();
  return {
    tool: "web_research",
    id: randomUUID(),
    provider,
    input,
    outputPath: buildWebResearchArtifactPath(cwd, input, startedAt),
    startedAt,
  };
}

function buildWebResearchArtifactPath(cwd: string, input: string, startedAt: string): string {
  const timestamp = startedAt.replaceAll(":", "-").replace(".", "-");
  const slug = slugify(input);
  return join(cwd, RESEARCH_ARTIFACTS_DIR, `${timestamp}-${slug}.md`);
}

function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || "research";
}

async function writeWebResearchArtifact(result: WebResearchResult, reportText: string): Promise<void> {
  await mkdir(dirname(result.outputPath), { recursive: true });
  const header = [
    `# Web Research: ${result.input}`,
    "",
    `- Provider: ${result.provider}`,
    `- Status: ${result.status}`,
    `- Started: ${result.startedAt}`,
    `- Completed: ${result.completedAt}`,
    `- Elapsed: ${result.elapsedMs}ms`,
    ...(result.error ? [`- Error: ${result.error}`] : []),
    "",
    "---",
    "",
  ].join("\n");
  await writeFile(result.outputPath, `${header}${reportText}`.trimEnd() + "\n", "utf-8");
}

function formatWebResearchResultMessage(result: WebResearchResult, reportText: string): string {
  if (result.status === "failed") {
    return `web_research failed via ${result.provider}: ${result.error ?? "Unknown error."}\n\nReport path: ${result.outputPath}`;
  }
  return `web_research completed via ${result.provider}.\n\nReport path: ${result.outputPath}\n\n${reportText}`;
}

function trackPendingResearchTask(task: Promise<void>): void {
  pendingResearchTasks.add(task);
  task.finally(() => pendingResearchTasks.delete(task)).catch(() => {});
}

async function waitForPendingResearchTasks(): Promise<void> {
  await Promise.allSettled([...pendingResearchTasks]);
}

function formatProviderError(error: unknown): string {
  return formatErrorMessage(error).replace(/\.$/, "");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const __test__ = {
  executeSearchTool,
  executeAnswerTool,
  executeContentsTool,
  getAvailableTools,
  getEffectiveProviderConfig,
  waitForPendingResearchTasks,
};

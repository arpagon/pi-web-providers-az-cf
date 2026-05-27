import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { resolveConfigValue, resolveEnvMap } from "./config-values.js";
import type {
  Cloudflare,
  ExecutionSettings,
  OpenAI,
  OpenAIAuthHeader,
  ProviderConfig,
  ProviderId,
  Settings,
  Tool,
  Tools,
  WebProviders,
} from "./types.js";
import { PROVIDER_IDS, TOOLS } from "./types.js";

export { resolveConfigValue, resolveEnvMap } from "./config-values.js";

const CONFIG_FILE_NAME = "web-providers.json";

export function getConfigPath(): string {
  return join(getAgentDir(), CONFIG_FILE_NAME);
}

export function createDefaultConfig(): WebProviders {
  return {
    tools: {
      search: "openai",
      contents: "cloudflare",
      answer: "openai",
      research: "openai",
    },
    providers: {
      openai: {
        baseUrl: "https://YOUR_AZURE_RESOURCE.cognitiveservices.azure.com/openai/v1/",
        credentials: { api: "AZURE_OPENAI_API_KEY" },
        options: {
          search: { model: "gpt-4.1" },
          answer: { model: "gpt-4.1" },
          research: { model: "o4-mini-deep-research" },
        },
      },
      cloudflare: {
        credentials: { api: "CLOUDFLARE_API_TOKEN" },
        accountId: "CLOUDFLARE_ACCOUNT_ID",
      },
    },
  };
}

export async function loadConfig(): Promise<WebProviders> {
  return readConfigFile(getConfigPath());
}

export async function readConfigFile(path: string): Promise<WebProviders> {
  try {
    const content = await readFile(path, "utf-8");
    const raw = parseJson(content, path);
    const migrated = migrateLegacyCredentialConfig(raw);
    const config = normalizeConfig(migrated.config, path);
    if (migrated.changed) {
      await writeFile(path, serializeConfig(config), "utf-8");
    }
    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function writeConfigFile(config: WebProviders): Promise<string> {
  const path = getConfigPath();
  await mkdir(dirname(path), { recursive: true });
  const cleaned = structuredClone(config);
  cleanupConfig(cleaned);
  await writeFile(path, serializeConfig(cleaned), "utf-8");
  return path;
}

export function parseConfig(text: string, source = CONFIG_FILE_NAME): WebProviders {
  return normalizeConfig(
    migrateLegacyCredentialConfig(parseJson(text, source)).config,
    source,
  );
}

export function parseProviderConfig(
  providerId: ProviderId,
  text: string,
  source = CONFIG_FILE_NAME,
): ProviderConfig {
  const raw = parseJson(text, source);
  if (!isPlainObject(raw)) {
    throw new Error(`Provider config in ${source} must be a JSON object.`);
  }
  const wrapper = normalizeConfig({ providers: { [providerId]: raw } }, source);
  const parsed = wrapper.providers?.[providerId];
  if (!parsed) throw new Error(`Failed to parse provider '${providerId}' in ${source}.`);
  return parsed;
}

export function serializeConfig(config: WebProviders): string {
  return `${JSON.stringify(toPublicConfig(config), null, 2)}\n`;
}

function parseJson(text: string, source: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in ${source}: ${(error as Error).message}`);
  }
}

interface LegacyCredentialMigrationResult {
  config: unknown;
  changed: boolean;
}

function migrateLegacyCredentialConfig(raw: unknown): LegacyCredentialMigrationResult {
  if (!isPlainObject(raw) || !isPlainObject(raw.providers)) {
    return { config: raw, changed: false };
  }

  let changed = false;
  const config = structuredClone(raw) as Record<string, unknown>;
  const providers = config.providers as Record<string, unknown>;

  for (const [providerId, provider] of Object.entries(providers)) {
    if (!isPlainObject(provider)) continue;
    const legacyKey = providerId === "cloudflare" ? "apiToken" : "apiKey";
    const legacyValue = provider[legacyKey];
    if (legacyValue === undefined) continue;

    const credentials = isPlainObject(provider.credentials)
      ? { ...provider.credentials }
      : {};
    if (credentials.api === undefined) credentials.api = legacyValue;
    provider.credentials = credentials;
    delete provider[legacyKey];
    changed = true;
  }

  return { config, changed };
}

function normalizeConfig(raw: unknown, source: string): WebProviders {
  const configObject = requireObject(raw, `Config in ${source} must be a JSON object.`);
  const config: WebProviders = {};

  if (configObject.tools !== undefined) {
    config.tools = parseToolProviderMapping(configObject.tools, source, "tools");
  }

  if (configObject.settings !== undefined) {
    config.settings = parseSettingsConfig(configObject.settings, source, "settings");
  }

  if (configObject.providers !== undefined) {
    const providers = requireObject(
      configObject.providers,
      `'providers' in ${source} must be a JSON object.`,
    );
    // This package intentionally only implements the allowlisted providers below.
    // Extra provider blocks are ignored so a shared upstream-compatible config can
    // keep unrelated provider settings without expanding this extension's runtime
    // surface. Tool mappings are still strict and cannot route to unknown providers.
    config.providers = {};
    for (const providerId of PROVIDER_IDS) {
      const value = providers[providerId];
      if (value !== undefined) {
        config.providers[providerId] = normalizeProvider(providerId, value, source) as never;
      }
    }
  }

  cleanupConfig(config);
  return config;
}

function normalizeProvider(
  providerId: ProviderId,
  raw: unknown,
  source: string,
): ProviderConfig {
  const provider = parseProviderObject(raw, source, providerId);
  switch (providerId) {
    case "openai":
      return parseOpenAIProvider(provider, source);
    case "cloudflare":
      return parseCloudflareProvider(provider, source);
  }
}

function parseProviderObject(
  raw: unknown,
  source: string,
  providerId: ProviderId,
): Record<string, unknown> {
  const provider = requireObject(
    raw,
    `'providers.${providerId}' in ${source} must be a JSON object.`,
  );
  if (provider.tools !== undefined) {
    throw new Error(
      `'providers.${providerId}.tools' in ${source} is not supported. Use top-level 'tools' mappings instead.`,
    );
  }
  if (provider.enabled !== undefined) {
    throw new Error(
      `'providers.${providerId}.enabled' in ${source} is not supported. Use top-level 'tools' mappings to route or disable capabilities.`,
    );
  }
  return provider;
}

function parseOpenAIProvider(provider: Record<string, unknown>, source: string): OpenAI {
  const unknownKeys = Object.keys(provider).filter(
    (key) => !["credentials", "baseUrl", "authHeader", "options", "settings"].includes(key),
  );
  if (unknownKeys.length > 0) {
    throw new Error(`'providers.openai' in ${source} must be a valid provider config.`);
  }

  return {
    credentials: readOptionalStringMap(provider.credentials, source, "providers.openai.credentials"),
    baseUrl: readOptionalString(provider.baseUrl, source, "providers.openai.baseUrl"),
    authHeader: parseOptionalLiteral(
      provider.authHeader,
      source,
      "providers.openai.authHeader",
      ["bearer", "api-key", "both"] as const,
    ) as OpenAIAuthHeader | undefined,
    options: parseOpenAIOptions(provider.options, source, "providers.openai.options"),
    settings: parseOptionalExecutionSettings(provider.settings, source, "providers.openai.settings"),
  };
}

function parseCloudflareProvider(
  provider: Record<string, unknown>,
  source: string,
): Cloudflare {
  const unknownKeys = Object.keys(provider).filter(
    (key) => !["credentials", "accountId", "options", "settings"].includes(key),
  );
  if (unknownKeys.length > 0) {
    throw new Error(`'providers.cloudflare' in ${source} must be a valid provider config.`);
  }

  return {
    credentials: readOptionalStringMap(provider.credentials, source, "providers.cloudflare.credentials"),
    accountId: readOptionalString(provider.accountId, source, "providers.cloudflare.accountId"),
    options: readOptionalObject(provider.options, source, "providers.cloudflare.options"),
    settings: parseOptionalExecutionSettings(
      provider.settings,
      source,
      "providers.cloudflare.settings",
    ),
  };
}

function parseOpenAIOptions(
  value: unknown,
  source: string,
  field: string,
): OpenAI["options"] | undefined {
  if (value === undefined) return undefined;
  const options = requireObject(value, `'${field}' in ${source} must be a JSON object.`);
  const unknownKeys = Object.keys(options).filter(
    (key) => !["search", "answer", "research"].includes(key),
  );
  if (unknownKeys.length > 0) {
    throw new Error(`'${field}' in ${source} only supports these keys: search, answer, research.`);
  }

  return {
    search: parseOpenAICapabilityOptions(options.search, source, `${field}.search`, false),
    answer: parseOpenAICapabilityOptions(options.answer, source, `${field}.answer`, false),
    research: parseOpenAICapabilityOptions(options.research, source, `${field}.research`, true),
  };
}

function parseOpenAICapabilityOptions(
  value: unknown,
  source: string,
  field: string,
  allowMaxToolCalls: boolean,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const options = requireObject(value, `'${field}' in ${source} must be a JSON object.`);
  const allowed = allowMaxToolCalls
    ? ["model", "instructions", "max_tool_calls"]
    : ["model", "instructions"];
  const unknownKeys = Object.keys(options).filter((key) => !allowed.includes(key));
  if (unknownKeys.length > 0) {
    throw new Error(`'${field}' in ${source} only supports these keys: ${allowed.join(", ")}.`);
  }

  return {
    model: readOptionalString(options.model, source, `${field}.model`),
    instructions: readOptionalString(options.instructions, source, `${field}.instructions`),
    ...(allowMaxToolCalls
      ? {
          max_tool_calls: parseOptionalPositiveInteger(
            options.max_tool_calls,
            source,
            `${field}.max_tool_calls`,
          ),
        }
      : {}),
  };
}

function parseToolProviderMapping(value: unknown, source: string, field: string): Tools {
  const mapping = requireObject(value, `'${field}' in ${source} must be a JSON object.`);
  const parsed: Tools = {};

  for (const [key, entry] of Object.entries(mapping)) {
    if (!TOOLS.includes(key as Tool)) {
      throw new Error(`Unknown tools in ${source}: ${key}.`);
    }
    parsed[key as Tool] = parseToolProviderMappingEntry(
      key as Tool,
      entry,
      source,
      `${field}.${key}`,
    );
  }

  return parsed;
}

function parseToolProviderMappingEntry(
  tool: Tool,
  value: unknown,
  source: string,
  field: string,
): ProviderId {
  const providerId = parseLiteral(value, source, field, PROVIDER_IDS);
  if (!supportsTool(providerId, tool)) {
    throw new Error(`'${field}' in ${source} must name a provider that supports '${tool}'.`);
  }
  return providerId;
}

export function supportsTool(providerId: ProviderId, tool: Tool): boolean {
  return providerId === "openai"
    ? tool === "search" || tool === "answer" || tool === "research"
    : tool === "contents";
}

function parseSettingsConfig(value: unknown, source: string, field: string): Settings {
  return parseExecutionSettings(value, source, field);
}

function parseOptionalExecutionSettings(
  value: unknown,
  source: string,
  field: string,
): ExecutionSettings | undefined {
  return value === undefined ? undefined : parseExecutionSettings(value, source, field);
}

function parseExecutionSettings(value: unknown, source: string, field: string): Settings {
  const settings = requireObject(value, `'${field}' in ${source} must be a JSON object.`);
  const unknownKeys = Object.keys(settings).filter(
    (key) =>
      key !== "requestTimeoutMs" &&
      key !== "retryCount" &&
      key !== "retryDelayMs" &&
      key !== "researchTimeoutMs",
  );
  if (unknownKeys.length > 0) {
    throw new Error(`'${field}' in ${source} must be a JSON object.`);
  }

  return {
    requestTimeoutMs: parseOptionalPositiveInteger(
      settings.requestTimeoutMs,
      source,
      `${field}.requestTimeoutMs`,
    ),
    retryCount: parseOptionalNonNegativeInteger(settings.retryCount, source, `${field}.retryCount`),
    retryDelayMs: parseOptionalPositiveInteger(
      settings.retryDelayMs,
      source,
      `${field}.retryDelayMs`,
    ),
    researchTimeoutMs: parseOptionalPositiveInteger(
      settings.researchTimeoutMs,
      source,
      `${field}.researchTimeoutMs`,
    ),
  };
}

function toPublicConfig(config: WebProviders): Record<string, unknown> {
  return {
    ...(config.tools ? { tools: config.tools } : {}),
    ...(config.settings ? { settings: config.settings } : {}),
    ...(config.providers && Object.keys(config.providers).length > 0
      ? { providers: config.providers }
      : {}),
  };
}

function readOptionalString(value: unknown, source: string, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`'${field}' in ${source} must be a string.`);
  return value;
}

function readOptionalObject(
  value: unknown,
  source: string,
  field: string,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  return requireObject(value, `'${field}' in ${source} must be a JSON object.`);
}

function readOptionalStringMap(
  value: unknown,
  source: string,
  field: string,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const map = requireObject(value, `'${field}' in ${source} must be a JSON object.`);
  for (const [key, entry] of Object.entries(map)) {
    if (typeof entry !== "string") {
      throw new Error(`'${field}.${key}' in ${source} must be a string.`);
    }
  }
  return map as Record<string, string>;
}

function parseOptionalPositiveInteger(
  value: unknown,
  source: string,
  field: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`'${field}' in ${source} must be a positive integer.`);
  }
  return value;
}

function parseOptionalNonNegativeInteger(
  value: unknown,
  source: string,
  field: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`'${field}' in ${source} must be a non-negative integer.`);
  }
  return value;
}

function parseOptionalLiteral<T extends readonly string[]>(
  value: unknown,
  source: string,
  field: string,
  allowed: T,
): T[number] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`'${field}' in ${source} must be one of: ${allowed.join(", ")}.`);
  }
  return value as T[number];
}

function parseLiteral<T extends readonly string[]>(
  value: unknown,
  source: string,
  field: string,
  allowed: T,
): T[number] {
  const parsed = parseOptionalLiteral(value, source, field, allowed);
  if (parsed === undefined) {
    throw new Error(`'${field}' in ${source} must be one of: ${allowed.join(", ")}.`);
  }
  return parsed;
}

function cleanupConfig(config: WebProviders): void {
  cleanupNestedEmptyObjects(config as unknown as Record<string, unknown>);
}

function cleanupNestedEmptyObjects(value: Record<string, unknown>): void {
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) {
      delete value[key];
      continue;
    }
    if (Array.isArray(entry)) {
      if (entry.length === 0) delete value[key];
      continue;
    }
    if (isPlainObject(entry)) {
      cleanupNestedEmptyObjects(entry);
      if (Object.keys(entry).length === 0) delete value[key];
    }
  }
}

function requireObject(value: unknown, message: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error(message);
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

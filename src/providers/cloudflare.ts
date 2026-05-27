import { formatConfigValueError, isSecretReference, resolveConfigValue } from "../config-values.js";
import { fetchJson } from "../http.js";
import type {
  Cloudflare,
  ContentsResponse,
  ProviderCapabilityStatus,
  ProviderCapabilityStatusOptions,
  ProviderContext,
} from "../types.js";

const CLOUDFLARE_PROVIDER_ID = "cloudflare" as const;
const DEFAULT_CLOUDFLARE_BASE_URL = "https://api.cloudflare.com/client/v4";

interface CloudflareApiResponse<T> {
  success?: boolean;
  result?: T;
  errors?: Array<{ message?: string; code?: number } | string>;
  messages?: unknown[];
}

export function createCloudflareTemplate(): Cloudflare {
  return {
    credentials: { api: "CLOUDFLARE_API_TOKEN" },
    accountId: "CLOUDFLARE_ACCOUNT_ID",
    options: {
      gotoOptions: {
        waitUntil: "networkidle0",
      },
    },
  };
}

export function getCloudflareCapabilityStatus(
  config: Cloudflare | undefined,
  options: ProviderCapabilityStatusOptions = {},
): ProviderCapabilityStatus {
  const apiStatus = getConfigSecretStatus(config?.credentials?.api, "API token", options);
  if (apiStatus.state !== "ready" && apiStatus.state !== "deferred_secret") return apiStatus;

  const accountIdStatus = getConfigSecretStatus(config?.accountId, "account ID", options);
  if (accountIdStatus.state !== "ready" && accountIdStatus.state !== "deferred_secret") {
    return accountIdStatus.state === "missing_api_key"
      ? { state: "invalid_config", detail: "Missing account ID" }
      : accountIdStatus;
  }

  return apiStatus.state === "deferred_secret" || accountIdStatus.state === "deferred_secret"
    ? { state: "deferred_secret" }
    : { state: "ready" };
}

export async function contentsCloudflare(
  urls: string[],
  config: Cloudflare,
  context: ProviderContext,
  options?: Record<string, unknown>,
): Promise<ContentsResponse> {
  const defaults = isPlainObject(config.options) ? config.options : {};
  const mergedOptions = {
    ...defaults,
    ...(options ?? {}),
  };

  const answers = await Promise.all(
    urls.map(async (url) => {
      try {
        const markdown = await fetchCloudflareMarkdown(url, config, context, mergedOptions);
        return { url, content: markdown };
      } catch (error) {
        return { url, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );

  return {
    provider: CLOUDFLARE_PROVIDER_ID,
    answers,
  };
}

export async function fetchCloudflareMarkdown(
  url: string,
  config: Cloudflare,
  context: ProviderContext,
  options: Record<string, unknown> = {},
): Promise<string> {
  const request = buildCloudflareMarkdownRequest(url, config, options);
  const response = await fetchJson<CloudflareApiResponse<string> | string>(
    request.url,
    {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
    },
    context,
    config.settings,
  );

  if (typeof response === "string") return response;
  if (response.success === false) {
    throw new Error(formatCloudflareErrors(response.errors) || "Cloudflare markdown request failed.");
  }
  if (typeof response.result === "string") return response.result;
  throw new Error("Cloudflare markdown response did not include markdown text.");
}

export function buildCloudflareMarkdownRequest(
  targetUrl: string,
  config: Cloudflare,
  options: Record<string, unknown> = {},
): {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  const apiToken = resolveConfigValue(config.credentials?.api);
  if (!apiToken) throw new Error("Cloudflare provider is missing an API token.");

  const accountId = resolveConfigValue(config.accountId);
  if (!accountId) throw new Error("Cloudflare provider is missing an account ID.");

  const { cacheTTL, ...bodyOptions } = options;
  const endpoint = new URL(
    `${DEFAULT_CLOUDFLARE_BASE_URL}/accounts/${encodeURIComponent(accountId)}/browser-rendering/markdown`,
  );
  if (cacheTTL !== undefined) endpoint.searchParams.set("cacheTTL", String(cacheTTL));

  return {
    url: endpoint.toString(),
    headers: {
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
    },
    body: {
      ...bodyOptions,
      url: targetUrl,
    },
  };
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

function formatCloudflareErrors(errors: CloudflareApiResponse<unknown>["errors"]): string {
  if (!errors || errors.length === 0) return "";
  return errors
    .map((entry) => {
      if (typeof entry === "string") return entry;
      const code = entry.code === undefined ? "" : `${entry.code}: `;
      return `${code}${entry.message ?? "Cloudflare error"}`;
    })
    .join("; ");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

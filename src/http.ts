import type { ExecutionSettings, ProviderContext } from "./types.js";

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_RETRY_COUNT = 3;
export const DEFAULT_RETRY_DELAY_MS = 2_000;
export const DEFAULT_RESEARCH_TIMEOUT_MS = 1_800_000;
export const DEFAULT_RESEARCH_POLL_INTERVAL_MS = 3_000;

const MAX_RETRY_DELAY_MS = 30_000;

export interface RequestPolicy extends ExecutionSettings {}

export class HttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string, message?: string) {
    super(message ?? buildHttpErrorMessage(status, body));
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}

export async function fetchJson<T = unknown>(
  url: string,
  init: RequestInit,
  context: ProviderContext,
  settings?: RequestPolicy,
): Promise<T> {
  const response = await fetchWithPolicy(url, init, context, settings);
  const text = await response.text();
  if (!text.trim()) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`Invalid JSON response from ${url}: ${(error as Error).message}`);
  }
}

export async function fetchText(
  url: string,
  init: RequestInit,
  context: ProviderContext,
  settings?: RequestPolicy,
): Promise<string> {
  const response = await fetchWithPolicy(url, init, context, settings);
  return await response.text();
}

export async function fetchWithPolicy(
  url: string,
  init: RequestInit,
  context: ProviderContext,
  settings?: RequestPolicy,
): Promise<Response> {
  const maxAttempts = Math.max(1, (settings?.retryCount ?? DEFAULT_RETRY_COUNT) + 1);
  const retryDelayMs = settings?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    throwIfAborted(context.signal);
    const attemptSignal = createAttemptSignal(
      context.signal,
      settings?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    );

    try {
      const fetchImpl = context.fetch ?? globalThis.fetch;
      const response = await fetchImpl(url, {
        ...init,
        signal: attemptSignal.signal,
      });
      if (!response.ok) {
        const body = await safeReadResponseText(response);
        throw new HttpError(response.status, body);
      }
      return response;
    } catch (error) {
      if (!shouldRetry(error) || attempt >= maxAttempts) throw normalizeError(error);
      const delayMs = Math.min(retryDelayMs * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
      context.onProgress?.(
        `Request failed (${formatErrorMessage(error)}). Retrying in ${formatDuration(delayMs)} (attempt ${attempt + 1}/${maxAttempts}).`,
      );
      await sleep(delayMs, context.signal);
    } finally {
      attemptSignal.cleanup();
    }
  }

  throw new Error(`Request failed: ${url}`);
}

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(getAbortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function throwIfAborted(signal?: AbortSignal, message = "Operation aborted."): void {
  if (signal?.aborted) throw getAbortError(signal, message);
}

export function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error);
}

export function formatDuration(ms: number): string {
  if (ms >= 60_000) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${seconds}s`;
  }
  if (ms >= 1000) return `${Math.floor(ms / 1000)}s`;
  return `${ms}ms`;
}

function shouldRetry(error: unknown): boolean {
  if (error instanceof HttpError) {
    return error.status === 429 || error.status === 500 || error.status === 502 || error.status === 503 || error.status === 504;
  }
  const message = formatErrorMessage(error).toLowerCase();
  if (!message || message === "operation aborted.") return false;
  return /429|500|502|503|504|econnreset|ehostunreach|eai_again|enotfound|etimedout|fetch failed|gateway timeout|internal error|network|overloaded|rate limit|socket hang up|temporarily unavailable|timeout|unavailable/.test(
    message,
  );
}

function createAttemptSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number | undefined,
): { signal?: AbortSignal; cleanup: () => void } {
  if (!parent && timeoutMs === undefined) return { signal: undefined, cleanup: () => {} };

  const controller = new AbortController();
  if (parent?.aborted) controller.abort(getAbortError(parent));

  const onAbort = () => controller.abort(getAbortError(parent));
  parent?.addEventListener("abort", onAbort, { once: true });

  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          controller.abort(new Error(`Request timed out after ${formatDuration(timeoutMs)}.`));
        }, timeoutMs);

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

function getAbortError(signal: AbortSignal | undefined, message = "Operation aborted."): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  if (typeof reason === "string" && reason.length > 0) return new Error(reason);
  return new Error(message);
}

async function safeReadResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(formatErrorMessage(error));
}

function buildHttpErrorMessage(status: number, body: string): string {
  const detail = extractErrorDetail(body);
  return detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`;
}

function extractErrorDetail(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      const error = record.error;
      if (typeof error === "string") return error;
      if (typeof error === "object" && error !== null && "message" in error) {
        const message = (error as { message?: unknown }).message;
        if (typeof message === "string") return message;
      }
      const errors = record.errors;
      if (Array.isArray(errors) && errors.length > 0) {
        return errors
          .map((entry) =>
            typeof entry === "object" && entry !== null && "message" in entry
              ? String((entry as { message?: unknown }).message)
              : String(entry),
          )
          .join("; ");
      }
      const message = record.message;
      if (typeof message === "string") return message;
    }
  } catch {
    // Fall through to raw text.
  }
  return trimmed.slice(0, 500);
}

import type { ContentsAnswer, SearchResponse } from "./types.js";

export function formatSearchResponses(
  outcomes: SearchQueryOutcome[],
): string {
  return outcomes
    .map((outcome, index) => formatSearchOutcomeSection(outcome, index, outcomes.length))
    .join("\n\n");
}

export type SearchQueryOutcome =
  | { query: string; response: SearchResponse; error?: undefined }
  | { query: string; error: string; response?: undefined };

function formatSearchOutcomeSection(
  outcome: SearchQueryOutcome,
  index: number,
  total: number,
): string {
  const body = outcome.response
    ? formatSearchResponseMarkdown(outcome.response)
    : `Search failed: ${outcome.error ?? "Unknown error."}`;
  if (total === 1) return body;
  return `## Query ${index + 1}: ${formatHeading(outcome.query)}\n\n${body}`;
}

export function formatSearchResponseMarkdown(response: SearchResponse): string {
  if (response.results.length === 0) return "No results found.";
  return response.results
    .map((result, index) => {
      const lines = [`${index + 1}. ${formatMarkdownLink(result.title, result.url)}`];
      if (result.snippet) lines.push(`   ${escapeMarkdownText(cleanSingleLine(result.snippet))}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

export type AnswerQueryOutcome =
  | { query: string; text: string; itemCount?: number; error?: undefined }
  | { query: string; error: string; text?: undefined; itemCount?: undefined };

export function formatAnswerResponses(outcomes: AnswerQueryOutcome[]): string {
  return outcomes
    .map((outcome, index) => formatAnswerOutcomeSection(outcome, index, outcomes.length))
    .join("\n\n");
}

function formatAnswerOutcomeSection(
  outcome: AnswerQueryOutcome,
  index: number,
  total: number,
): string {
  const body = outcome.text ?? `Answer failed: ${outcome.error ?? "Unknown error."}`;
  if (total === 1) return body;
  return `## Question ${index + 1}: ${formatHeading(outcome.query)}\n\n${body}`;
}

export function renderContentsAnswers(answers: ContentsAnswer[]): string {
  if (answers.length === 0) return "No contents found.";
  return answers.map((answer, index) => renderContentsAnswer(answer, index)).join("\n\n").trim() || "No contents found.";
}

export function renderContentsAnswer(answer: ContentsAnswer, index?: number): string {
  const heading = answer.error !== undefined ? `Error: ${answer.url || "Untitled"}` : answer.url || "Untitled";
  const lines = [`## ${index === undefined ? "" : `${index + 1}. `}${heading}`.trim()];
  const body = answer.error !== undefined ? answer.error.trim() : (answer.content?.trim() ?? "");
  if (body) lines.push("", body);
  if (answer.summary !== undefined) {
    const summaryText = renderUnknown(answer.summary);
    if (summaryText) lines.push("", "### Summary", "", summaryText);
  }
  return lines.join("\n").trimEnd();
}

export function buildSearchBatchError(outcomes: SearchQueryOutcome[], providerLabel: string): Error {
  const failed = outcomes.filter((outcome) => outcome.error !== undefined);
  if (failed.length === 1) return new Error(`${providerLabel}: ${failed[0]?.error ?? "search failed"}.`);
  const summary = failed
    .map((outcome, index) => `${index + 1}. ${formatQuotedPreview(outcome.query, 40)} — ${outcome.error}`)
    .join("; ");
  return new Error(`${providerLabel} search failed for ${failed.length} queries: ${summary}`);
}

export function buildAnswerBatchError(outcomes: AnswerQueryOutcome[], providerLabel: string): Error {
  const failed = outcomes.filter((outcome) => outcome.error !== undefined);
  if (failed.length === 1) return new Error(`${providerLabel}: ${failed[0]?.error ?? "answer failed"}.`);
  const summary = failed
    .map((outcome, index) => `${index + 1}. ${formatQuotedPreview(outcome.query, 40)} — ${outcome.error}`)
    .join("; ");
  return new Error(`${providerLabel} answer failed for ${failed.length} questions: ${summary}`);
}

export function normalizeQueries(values: string[], fieldName = "queries"): string[] {
  if (values.length === 0) throw new Error(`${fieldName} must contain at least one item.`);
  return values.map((value, index) => {
    const normalized = value.trim();
    if (normalized.length === 0) throw new Error(`${fieldName}[${index}] must be a non-empty string.`);
    return normalized;
  });
}

export function clampResults(value: number | undefined, maximum = 20, defaultValue = 5): number {
  if (value === undefined) return Math.min(defaultValue, maximum);
  return Math.min(Math.max(Math.trunc(value), 1), maximum);
}

function formatHeading(query: string): string {
  return `"${escapeMarkdownText(cleanSingleLine(query))}"`;
}

function formatMarkdownLink(label: string, url: string): string {
  return `[${escapeMarkdownLinkLabel(label)}](<${url}>)`;
}

function escapeMarkdownLinkLabel(text: string): string {
  return cleanSingleLine(text).replaceAll("\\", "\\\\").replaceAll("]", "\\]");
}

function escapeMarkdownText(text: string): string {
  return text
    .replaceAll("\\", "\\\\")
    .replaceAll("*", "\\*")
    .replaceAll("_", "\\_")
    .replaceAll("`", "\\`")
    .replaceAll("#", "\\#")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
}

function cleanSingleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function formatQuotedPreview(text: string, maxLength = 80): string {
  return `"${truncateInline(cleanSingleLine(text), maxLength)}"`;
}

function truncateInline(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function renderUnknown(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value === undefined) return "";
  return `\`\`\`json\n${JSON.stringify(value, null, 2).trim()}\n\`\`\``;
}

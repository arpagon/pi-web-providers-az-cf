import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const forbiddenRuntimeDeps = [
  "@anthropic-ai/claude-agent-sdk",
  "@google/genai",
  "@mendable/firecrawl-js",
  "@openai/codex-sdk",
  "@perplexity-ai/perplexity_ai",
  "@tavily/core",
  "cloudflare",
  "exa-js",
  "linkup-sdk",
  "openai",
  "parallel-web",
  "valyu-js",
];

describe("package dependency policy", () => {
  it("keeps runtime dependencies empty and SDKs out of dependencies", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf-8")) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies ?? {}).toEqual({});
    for (const dep of forbiddenRuntimeDeps) {
      expect(pkg.dependencies?.[dep]).toBeUndefined();
    }
  });
});

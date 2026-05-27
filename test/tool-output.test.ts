import { describe, expect, it, vi } from "vitest";
import { __test__ } from "../src/index.js";
import type { WebProviders } from "../src/types.js";

function jsonResponse(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("managed tool execution", () => {
  it("groups batched search output and preserves partial failures", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          id: "resp_1",
          model: "gpt-4.1",
          status: "completed",
          output_text: JSON.stringify({
            sources: [
              { title: "Result A", url: "https://example.com/a", snippet: "Snippet A" },
            ],
          }),
          output: [],
          error: null,
          incomplete_details: null,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ error: { message: "rate limited" } }, { status: 429 }),
      );

    const config: WebProviders = {
      providers: {
        openai: {
          baseUrl: "https://api.openai.test/v1/",
          credentials: { api: "literal-key" },
          settings: { retryCount: 0 },
        },
      },
    };

    const result = await __test__.executeSearchTool({
      config,
      explicitProvider: "openai",
      request: { queries: ["query a", "query b"], maxResults: 1 },
      context: { cwd: process.cwd(), fetch: fetchMock as unknown as typeof fetch },
    } as never);

    expect(result.content[0]?.text).toContain('## Query 1: "query a"');
    expect(result.content[0]?.text).toContain("1. [Result A](<https://example.com/a>)");
    expect(result.content[0]?.text).toContain('## Query 2: "query b"');
    expect(result.content[0]?.text).toContain("Search failed: HTTP 429: rate limited");
    expect(result.details).toEqual({
      tool: "web_search",
      provider: "openai",
      queryCount: 2,
      failedQueryCount: 1,
      resultCount: 1,
    });
  });

  it("groups batched answer output", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          id: "resp_1",
          model: "gpt-4.1",
          status: "completed",
          output_text: "Answer A",
          output: [],
          error: null,
          incomplete_details: null,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: "resp_2",
          model: "gpt-4.1",
          status: "completed",
          output_text: "Answer B",
          output: [],
          error: null,
          incomplete_details: null,
        }),
      );

    const result = await __test__.executeAnswerTool({
      config: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.test/v1/",
            credentials: { api: "literal-key" },
            settings: { retryCount: 0 },
          },
        },
      } satisfies WebProviders,
      explicitProvider: "openai",
      request: { queries: ["question a", "question b"] },
      context: { cwd: process.cwd(), fetch: fetchMock as unknown as typeof fetch },
    } as never);

    expect(result.content[0]?.text).toContain('## Question 1: "question a"');
    expect(result.content[0]?.text).toContain("Answer A");
    expect(result.content[0]?.text).toContain('## Question 2: "question b"');
    expect(result.content[0]?.text).toContain("Answer B");
    expect(result.details).toEqual({
      tool: "web_answer",
      provider: "openai",
      itemCount: undefined,
      queryCount: 2,
      failedQueryCount: 0,
    });
  });

  it("renders Cloudflare contents output", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ success: true, result: "# Example" }));
    const result = await __test__.executeContentsTool({
      config: {
        providers: {
          cloudflare: {
            credentials: { api: "literal-token" },
            accountId: "account-id",
            settings: { retryCount: 0 },
          },
        },
      } satisfies WebProviders,
      explicitProvider: "cloudflare",
      request: { urls: ["https://example.com"] },
      context: { cwd: process.cwd(), fetch: fetchMock as unknown as typeof fetch },
    } as never);

    expect(result.content[0]?.text).toContain("## 1. https://example.com");
    expect(result.content[0]?.text).toContain("# Example");
    expect(result.details).toEqual({ tool: "web_contents", provider: "cloudflare", itemCount: 1 });
  });
});

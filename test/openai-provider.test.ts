import { describe, expect, it, vi } from "vitest";
import {
  answerOpenAI,
  buildOpenAIHeaders,
  buildOpenAIResearchRequest,
  buildOpenAISearchRequest,
  buildOpenAIUrl,
  resolveOpenAIAuthHeader,
  searchOpenAI,
} from "../src/providers/openai.js";
import type { OpenAI, ProviderContext } from "../src/types.js";

function jsonResponse(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("OpenAI-compatible provider", () => {
  it("builds the structured search request like upstream", () => {
    const request = buildOpenAISearchRequest(
      "openai deep research",
      3,
      { options: { search: { model: "gpt-4.1" } } },
      { instructions: "Prefer official sources." },
    );

    expect(request).toEqual({
      model: "gpt-4.1",
      input: [
        "Search the public web and return only the most relevant sources for the user's query.",
        "Return at most 3 sources.",
        "Prefer official, primary, or highly reputable sources when available.",
        "Each snippet should be short, specific, and grounded in the retrieved source.",
        "Return only data matching the provided JSON schema.",
        "",
        "User query: openai deep research",
      ].join("\n"),
      tools: [{ type: "web_search_preview" }],
      text: {
        format: {
          type: "json_schema",
          name: "openai_web_search_results",
          schema: expect.objectContaining({ required: ["sources"] }),
          strict: true,
        },
      },
      instructions: "Prefer official sources.",
    });
  });

  it("posts search requests with fetch and parses sources", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        id: "resp_search_1",
        model: "gpt-4.1",
        status: "completed",
        output_text: JSON.stringify({
          sources: [
            {
              title: "OpenAI Docs",
              url: "https://platform.openai.com/docs",
              snippet: " Official docs with extra whitespace. ",
            },
          ],
        }),
        output: [],
        error: null,
        incomplete_details: null,
      }),
    );
    const config: OpenAI = {
      baseUrl: "https://api.openai.test/v1/",
      credentials: { api: "literal-key" },
      options: { search: { model: "gpt-4.1" } },
      settings: { retryCount: 0 },
    };
    const context: ProviderContext = { cwd: process.cwd(), fetch: fetchMock as unknown as typeof fetch };

    const result = await searchOpenAI("openai docs", 1, config, context, undefined);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = (fetchMock.mock.calls as any)[0];
    expect(firstCall[0]).toBe("https://api.openai.test/v1/responses");
    expect(firstCall[1]).toMatchObject({
      method: "POST",
      headers: {
        authorization: "Bearer literal-key",
        "content-type": "application/json",
      },
    });
    expect(JSON.parse(String(firstCall[1].body))).toMatchObject({
      model: "gpt-4.1",
      tools: [{ type: "web_search_preview" }],
    });
    expect(result).toEqual({
      provider: "openai",
      results: [
        {
          title: "OpenAI Docs",
          url: "https://platform.openai.com/docs",
          snippet: "Official docs with extra whitespace.",
        },
      ],
    });
  });

  it("uses api-key auth by default for Azure-looking base URLs", () => {
    const config: OpenAI = {
      baseUrl: "https://my-resource.cognitiveservices.azure.com/openai/v1/",
      credentials: { api: "azure-key" },
    };
    expect(resolveOpenAIAuthHeader(config)).toBe("api-key");
    expect(buildOpenAIHeaders(config)).toEqual({
      "api-key": "azure-key",
      "content-type": "application/json",
    });
    expect(buildOpenAIUrl(config, "responses")).toBe(
      "https://my-resource.cognitiveservices.azure.com/openai/v1/responses",
    );
  });

  it("preserves citations for grounded answers", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        id: "resp_answer_1",
        model: "gpt-4.1",
        status: "completed",
        output_text: "Grounded answer",
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "Grounded answer",
                annotations: [
                  {
                    type: "url_citation",
                    title: "Answer Source",
                    url: "https://example.com/source",
                    start_index: 0,
                    end_index: 8,
                  },
                ],
              },
            ],
          },
        ],
        error: null,
        incomplete_details: null,
      }),
    );

    const result = await answerOpenAI(
      "What changed?",
      {
        baseUrl: "https://api.openai.test/v1/",
        credentials: { api: "literal-key" },
        options: { answer: { model: "gpt-4.1" } },
        settings: { retryCount: 0 },
      },
      { cwd: process.cwd(), fetch: fetchMock as unknown as typeof fetch },
      { instructions: "Use citations." },
    );

    const firstCall = (fetchMock.mock.calls as any)[0];
    expect(JSON.parse(String(firstCall[1].body))).toEqual({
      model: "gpt-4.1",
      input: "What changed?",
      tools: [{ type: "web_search_preview" }],
      instructions: "Use citations.",
    });
    expect(result.text).toBe("Grounded answer\n\nSources:\n1. Answer Source\n   https://example.com/source");
    expect(result.itemCount).toBe(1);
  });

  it("builds background research requests", () => {
    const request = buildOpenAIResearchRequest(
      "Investigate Responses API",
      { options: { research: { model: "o3-deep-research" } } },
      { max_tool_calls: 5, instructions: "Prefer primary sources." },
    );
    expect(request).toEqual({
      model: "o3-deep-research",
      input: "Investigate Responses API",
      background: true,
      tools: [{ type: "web_search_preview" }],
      instructions: "Prefer primary sources.",
      max_tool_calls: 5,
    });
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  buildCloudflareMarkdownRequest,
  contentsCloudflare,
} from "../src/providers/cloudflare.js";
import type { Cloudflare, ProviderContext } from "../src/types.js";

function jsonResponse(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("Cloudflare provider", () => {
  it("builds direct Browser Rendering markdown requests", () => {
    const request = buildCloudflareMarkdownRequest(
      "https://example.com",
      {
        credentials: { api: "literal-token" },
        accountId: "account-id",
      },
      {
        cacheTTL: 0,
        gotoOptions: { waitUntil: "networkidle0" },
      },
    );

    expect(request).toEqual({
      url: "https://api.cloudflare.com/client/v4/accounts/account-id/browser-rendering/markdown?cacheTTL=0",
      headers: {
        authorization: "Bearer literal-token",
        "content-type": "application/json",
      },
      body: {
        gotoOptions: { waitUntil: "networkidle0" },
        url: "https://example.com",
      },
    });
  });

  it("extracts markdown and keeps per-URL errors local to each answer", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ success: true, result: "# Example\n\nRendered" }))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            success: false,
            errors: [{ code: 10000, message: "render failed" }],
          },
          { status: 200 },
        ),
      );
    const config: Cloudflare = {
      credentials: { api: "literal-token" },
      accountId: "account-id",
      options: { gotoOptions: { waitUntil: "networkidle0" } },
      settings: { retryCount: 0 },
    };
    const context: ProviderContext = { cwd: process.cwd(), fetch: fetchMock as unknown as typeof fetch };

    const result = await contentsCloudflare(
      ["https://example.com", "https://bad.example"],
      config,
      context,
      { cacheTTL: 0 },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      gotoOptions: { waitUntil: "networkidle0" },
      url: "https://example.com",
    });
    expect(result).toEqual({
      provider: "cloudflare",
      answers: [
        { url: "https://example.com", content: "# Example\n\nRendered" },
        { url: "https://bad.example", error: "10000: render failed" },
      ],
    });
  });

  it("reports missing account IDs before making requests", async () => {
    await expect(
      contentsCloudflare(
        ["https://example.com"],
        { credentials: { api: "literal-token" } },
        { cwd: process.cwd(), fetch: vi.fn() as unknown as typeof fetch },
      ),
    ).resolves.toEqual({
      provider: "cloudflare",
      answers: [
        {
          url: "https://example.com",
          error: "Cloudflare provider is missing an account ID.",
        },
      ],
    });
  });
});

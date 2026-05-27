import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDefaultConfig,
  parseConfig,
  readConfigFile,
  resolveConfigValue,
  serializeConfig,
} from "../src/config.js";

const cleanupDirs: string[] = [];

afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (!dir) continue;
    await import("node:fs/promises").then(({ rm }) => rm(dir, { recursive: true, force: true }));
  }
  delete process.env.TEST_PI_WEB_PROVIDERS_SECRET;
});

describe("config parsing", () => {
  it("parses the target OpenAI + Cloudflare config shape", () => {
    const parsed = parseConfig(
      JSON.stringify({
        tools: {
          search: "openai",
          contents: "cloudflare",
          answer: "openai",
          research: "openai",
        },
        settings: {
          requestTimeoutMs: 45000,
          retryCount: 2,
          retryDelayMs: 1000,
          researchTimeoutMs: 1800000,
        },
        providers: {
          cloudflare: {
            credentials: { api: "CLOUDFLARE_API_TOKEN" },
            accountId: "CLOUDFLARE_ACCOUNT_ID",
            options: { gotoOptions: { waitUntil: "networkidle0" } },
          },
          openai: {
            baseUrl: "https://example.openai.azure.com/openai/v1/",
            credentials: { api: "AZURE_OPENAI_API_KEY" },
            options: {
              search: { model: "gpt-4.1" },
              answer: { model: "gpt-4.1", instructions: "Be concise." },
              research: { model: "o4-mini-deep-research", max_tool_calls: 12 },
            },
          },
        },
      }),
      "test-config.json",
    );

    expect(parsed.tools).toEqual({
      search: "openai",
      contents: "cloudflare",
      answer: "openai",
      research: "openai",
    });
    expect(parsed.providers?.openai?.baseUrl).toBe("https://example.openai.azure.com/openai/v1/");
    expect(parsed.providers?.openai?.options?.research?.max_tool_calls).toBe(12);
    expect(parsed.providers?.cloudflare?.accountId).toBe("CLOUDFLARE_ACCOUNT_ID");
    expect(parsed.settings?.requestTimeoutMs).toBe(45000);
  });

  it("ignores unused providers outside the allowlist", () => {
    const parsed = parseConfig(
      JSON.stringify({ providers: { exa: { credentials: { api: "EXA_API_KEY" } } } }),
      "test-config.json",
    );
    expect(parsed.providers).toBeUndefined();
  });

  it("rejects unsupported tool/provider mappings", () => {
    expect(() =>
      parseConfig(JSON.stringify({ tools: { contents: "openai" } }), "test-config.json"),
    ).toThrow(/must name a provider that supports 'contents'/);
    expect(() =>
      parseConfig(JSON.stringify({ tools: { search: "cloudflare" } }), "test-config.json"),
    ).toThrow(/must name a provider that supports 'search'/);
  });

  it("migrates legacy apiKey/apiToken fields when reading a file", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-providers-az-cf-config-"));
    cleanupDirs.push(root);
    const path = join(root, "web-providers.json");
    await mkdir(root, { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        providers: {
          openai: { apiKey: "OPENAI_API_KEY" },
          cloudflare: { apiToken: "CLOUDFLARE_API_TOKEN", accountId: "CLOUDFLARE_ACCOUNT_ID" },
        },
      }),
      "utf-8",
    );

    const loaded = await readConfigFile(path);
    expect(loaded.providers?.openai?.credentials?.api).toBe("OPENAI_API_KEY");
    expect(loaded.providers?.cloudflare?.credentials?.api).toBe("CLOUDFLARE_API_TOKEN");
    expect(JSON.parse(await readFile(path, "utf-8"))).toEqual({
      providers: {
        openai: { credentials: { api: "OPENAI_API_KEY" } },
        cloudflare: { credentials: { api: "CLOUDFLARE_API_TOKEN" }, accountId: "CLOUDFLARE_ACCOUNT_ID" },
      },
    });
  });

  it("serializes the sparse default template in example-compatible shape", () => {
    const serialized = JSON.parse(serializeConfig(createDefaultConfig()));
    expect(serialized.tools).toEqual({
      search: "openai",
      contents: "cloudflare",
      answer: "openai",
      research: "openai",
    });
    expect(serialized.providers.openai.credentials.api).toBe("AZURE_OPENAI_API_KEY");
    expect(serialized.providers.cloudflare.credentials.api).toBe("CLOUDFLARE_API_TOKEN");
  });

  it("resolves literal, env, and command-backed config values", async () => {
    process.env.TEST_PI_WEB_PROVIDERS_SECRET = "from-env";
    expect(resolveConfigValue("literal-secret")).toBe("literal-secret");
    expect(resolveConfigValue("TEST_PI_WEB_PROVIDERS_SECRET")).toBe("from-env");
    expect(resolveConfigValue("MISSING_UPPERCASE_SECRET")).toBeUndefined();

    const root = await mkdtemp(join(tmpdir(), "pi-web-providers-az-cf-secret-"));
    cleanupDirs.push(root);
    const marker = join(root, "marker.txt");
    const script = join(root, "secret.js");
    await writeFile(
      script,
      [
        'const { appendFileSync } = require("node:fs");',
        'appendFileSync(process.argv[2], "x");',
        'process.stdout.write("from-command");',
      ].join("\n"),
      "utf-8",
    );
    const command = `!node ${JSON.stringify(script)} ${JSON.stringify(marker)}`;
    expect(resolveConfigValue(command)).toBe("from-command");
    expect(resolveConfigValue(command)).toBe("from-command");
    expect(await readFile(marker, "utf-8")).toBe("x");
  });
});

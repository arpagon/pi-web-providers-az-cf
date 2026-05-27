# pi-web-providers-az-cf

Minimal Pi web providers extension for the provider set used in this environment:

| Pi tool | Provider |
| --- | --- |
| `web_search` | OpenAI-compatible / Azure OpenAI Responses API |
| `web_answer` | OpenAI-compatible / Azure OpenAI Responses API |
| `web_research` | OpenAI-compatible / Azure OpenAI Responses API |
| `web_contents` | Cloudflare Browser Rendering markdown endpoint |

This package is intentionally not a general provider marketplace. It is inspired by `mavam/pi-web-providers`, but keeps a narrow allowlist and uses direct `fetch` calls instead of vendor SDK runtime dependencies.

## Runtime dependency policy

Runtime `dependencies` are currently empty. This is a preference, not dogma: future runtime dependencies should be added only when their maintenance/correctness benefits clearly justify their supply-chain surface.

Current SDK tradeoff:

- `openai`: acceptable if needed later; official SDK has no runtime dependencies, but is large for our tiny Responses API subset.
- `cloudflare`: avoided; the SDK pulls a much larger dependency tree and generated client surface for one markdown endpoint.

## Configuration

The extension reads `~/.pi/agent/web-providers.json`, compatible with the shape used by upstream:

```json
{
  "tools": {
    "search": "openai",
    "contents": "cloudflare",
    "answer": "openai",
    "research": "openai"
  },
  "providers": {
    "cloudflare": {
      "credentials": { "api": "CLOUDFLARE_API_TOKEN" },
      "accountId": "CLOUDFLARE_ACCOUNT_ID"
    },
    "openai": {
      "baseUrl": "https://YOUR_AZURE_RESOURCE.cognitiveservices.azure.com/openai/v1/",
      "credentials": { "api": "AZURE_OPENAI_API_KEY" },
      "options": {
        "search": { "model": "gpt-4.1" },
        "answer": { "model": "gpt-4.1" },
        "research": { "model": "o4-mini-deep-research" }
      }
    }
  }
}
```

Credential values can be:

- literal strings,
- environment variable names such as `AZURE_OPENAI_API_KEY`, or
- `!command` references whose stdout is used as the secret.

Do not commit real secrets.

### OpenAI/Azure auth headers

`providers.openai.authHeader` is optional:

```json
{ "authHeader": "bearer" }
```

Allowed values:

- `bearer`
- `api-key`
- `both`

If omitted, the extension uses `api-key` for Azure-looking hosts ending in `.openai.azure.com` or `.cognitiveservices.azure.com`, and `Authorization: Bearer` otherwise.

## Commands

```text
/web-providers
```

Shows the config path.

```text
/web-providers init
```

Writes a template config to `~/.pi/agent/web-providers.json`.

## Development

```sh
npm install
npm run check
npm test
npm run build
```

Live Pi smoke test through tmux:

```sh
npm run e2e:pi
```

The smoke test uses the real local Pi config and may spend provider quota. Override the tool/prompt if needed:

```sh
PI_WEB_PROVIDERS_E2E_TOOL=web_search \
PI_WEB_PROVIDERS_E2E_PROMPT='Use web_search exactly once for query "OpenAI Responses API" with maxResults 1.' \
npm run e2e:pi
```

## Publishing

The package is published from GitHub Actions using npm trusted publishing/OIDC.

Trusted publisher settings on npm should match:

- provider: GitHub Actions
- repository: `arpagon/pi-web-providers-az-cf`
- workflow filename: `publish.yml`
- environment: `npm`
- allowed action: `npm publish`

Create a version commit/tag and push the tag to publish:

```sh
npm version patch
git push --follow-tags
```

## Non-goals

The following providers are intentionally out of scope unless explicitly re-approved:

```text
brave, claude, codex, custom, exa, firecrawl, gemini, linkup, ollama,
parallel, perplexity, serper, tavily, valyu
```

# AGENTS.md — pi-web-providers-az-cf

This file is intentionally self-contained. Future Pi sessions may start in this directory with no conversation context.

## Project summary

Repository/project name:

```text
arpagon/pi-web-providers-az-cf
```

This project is a minimal, security-oriented Pi extension inspired by `mavam/pi-web-providers`, but scoped only to the providers actually used by the owner:

- Azure OpenAI / OpenAI-compatible Responses API for:
  - search
  - answer
  - research
- Cloudflare Browser Rendering markdown endpoint for:
  - contents extraction

The main goal is to reduce npm/bun supply-chain attack surface compared with upstream `mavam/pi-web-providers`, which supports many providers and therefore pulls many provider SDKs.

Do **not** broaden provider support unless the user explicitly asks.

## Language and response style

- The user may speak Spanish.
- Respond in English unless the user explicitly requests otherwise.
- Keep explanations concise but clear.
- When modifying files, mention paths clearly.

## Primary design philosophy

This is not a generic web-provider marketplace. It is an allowlisted, minimal Pi extension.

Principles:

1. **Only two provider families**
   - OpenAI-compatible/Azure OpenAI
   - Cloudflare Browser Rendering

2. **Small runtime trust boundary**
   - Prefer direct `fetch` against REST APIs when the API surface is small.
   - Avoid vendor SDK runtime dependencies when practical, but this is a tradeoff rather than a hard ban.
   - Ideally keep `dependencies` empty.
   - The current decision is direct `fetch` for both providers. The official `openai` SDK is acceptable to reconsider later because it has no runtime dependencies; the official `cloudflare` SDK is not attractive here because it adds a large generated API surface and transitive dependency tree for one markdown endpoint.
   - `devDependencies` for TypeScript/build/test tooling are okay.
   - `peerDependencies` for Pi packages and `typebox` are okay if needed by the extension API.

3. **NPM-published with builds**
   - This should be buildable and publishable like the owner's other Pi packages.
   - NPM auth/2FA/publishing details are deferred.
   - Tentative npm package name: `pi-web-providers-az-cf` unless the user changes it.

4. **No accidental upstream dependency import**
   - Do not copy upstream `package.json` wholesale.
   - Do not retain unused provider modules.
   - Do not import unused providers statically or dynamically.

5. **Config compatibility**
   - The local Pi config shape to support is:

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
      "baseUrl": "https://.../openai/v1/",
      "credentials": { "api": "..." },
      "options": {
        "search": { "model": "..." },
        "answer": { "model": "..." },
        "research": { "model": "..." }
      }
    }
  }
}
```

Do not copy real secrets from `~/.pi/agent/web-providers.json` into repository files.

## Important local paths

Current project directory:

```text
~/Workspace/arpagon/pi-web-providers-az-cf
```

Upstream reference cache:

```text
~/Workspace/.cache/thirdparty/github.com/mavam/pi-web-providers
```

Refresh upstream reference with:

```bash
bash /home/arpagon/.pi/agent/skills/thirdparty/checkout.sh mavam/pi-web-providers --force-update --path-only
```

Relevant local Pi config:

```text
~/.pi/agent/settings.json
~/.pi/agent/web-providers.json
```

Other local Pi extension projects to inspect for style:

```text
~/Workspace/arpagon/pi-animations
~/Workspace/arpagon/pi-annotate
~/Workspace/arpagon/pi-anthropic-vertex
~/Workspace/arpagon/pi-context-zone
~/Workspace/arpagon/pi-rewind
~/Workspace/arpagon/pi-web-providers
~/Workspace/arpagon/pi-worktree-tui-status
```

Reference fork philosophy example:

```text
~/Workspace/arpagon/visual-explainer/FORK.md
```

## Upstream reference state at project creation

At project creation time, `mavam/pi-web-providers` in the third-party cache was:

```text
8793b28 Release v3.2.0
2026-05-24 19:43:37 +0000
```

Use upstream as reference material only. Do not edit the cache directly.

## Providers that must stay out by default

Do not add code, config UI, package dependencies, or tests for these unless the user explicitly changes scope:

```text
brave
claude
codex
custom
exa
firecrawl
gemini
linkup
ollama
parallel
perplexity
serper
tavily
valyu
```

Avoid these upstream runtime dependencies unless explicitly approved:

```text
@anthropic-ai/claude-agent-sdk
@google/genai
@mendable/firecrawl-js
@openai/codex-sdk
@perplexity-ai/perplexity_ai
@tavily/core
cloudflare
exa-js
linkup-sdk
openai
parallel-web
valyu-js
```

Note: `openai` and `cloudflare` SDKs are intentionally avoided in the initial implementation; prefer direct `fetch` to reduce dependency surface. This is not a permanent ban: document and re-evaluate the SDK tradeoff before adding any runtime dependency.

## Expected implementation direction

The likely extension should provide/register Pi tools equivalent to upstream's managed web tools:

- `web_search`
- `web_contents`
- `web_answer`
- `web_research`

But implementation should be much smaller than upstream.

Suggested source layout:

```text
src/
├── index.ts              # Pi extension entrypoint
├── config.ts             # Load ~/.pi/agent/web-providers.json-compatible config
├── http.ts               # Small fetch helper, timeout/error handling
├── providers/
│   ├── openai.ts         # OpenAI-compatible/Azure Responses API calls
│   └── cloudflare.ts     # Cloudflare markdown endpoint calls
├── render.ts             # Formatting results for Pi output
└── types.ts              # Narrow local types
```

This is a suggestion, not mandatory.

## Build/package expectations

Use a normal npm-publishable package shape.

Expected baseline:

```json
{
  "name": "pi-web-providers-az-cf",
  "version": "0.1.0",
  "type": "module",
  "files": ["dist", "README.md", "FORK.md"],
  "exports": { ".": "./dist/index.js" },
  "scripts": {
    "build": "...",
    "check": "tsc --noEmit",
    "test": "...",
    "prepack": "npm run build"
  }
}
```

Use the current Pi package namespace seen in installed upstream when needed:

```text
@earendil-works/pi-coding-agent
@earendil-works/pi-tui
@earendil-works/pi-ai
```

Older local projects may still reference `@mariozechner/*`; avoid introducing new `@mariozechner/*` imports unless needed for legacy compatibility.

## Testing expectations

Before switching Pi to this extension, verify at minimum:

1. Typecheck passes.
2. Build passes.
3. Unit tests for config parsing and request building pass.
4. No unused provider dependencies are present in `package.json`.
5. A local Pi session can load the extension.
6. Each configured tool works or fails with a clear actionable error:
   - `web_search`
   - `web_answer`
   - `web_research`
   - `web_contents`

Avoid live API tests by default unless explicitly requested, because they may spend quota and require secrets.

## Secret handling

The user said moving inline credentials to environment variables is not a priority. Still:

- Never commit real API keys.
- Never copy real keys into docs, tests, fixtures, or examples.
- Use placeholders in examples.
- Do not rewrite the user's `~/.pi/agent/web-providers.json` unless explicitly asked.

## Suggested first tasks

If starting fresh in this directory:

1. Read `FORK.md`.
2. Refresh/read upstream reference if needed:

```bash
bash /home/arpagon/.pi/agent/skills/thirdparty/checkout.sh mavam/pi-web-providers --path-only
```

3. Inspect upstream extension registration and tool behavior:

```bash
rg "registerTool|web_search|web_contents|web_answer|web_research|registerCommand" ~/Workspace/.cache/thirdparty/github.com/mavam/pi-web-providers/src
```

4. Inspect local extension style:

```bash
find ~/Workspace/arpagon/pi-worktree-tui-status -maxdepth 2 -type f | sort
find ~/Workspace/arpagon/pi-anthropic-vertex -maxdepth 2 -type f | sort
```

5. Create minimal package skeleton.
6. Implement only Azure/OpenAI-compatible and Cloudflare paths.

## Do not do without explicit user approval

- Do not switch `~/.pi/agent/settings.json` to this package before implementation/testing.
- Do not publish to npm.
- Do not delete old forks/checkouts.
- Do not edit `~/Workspace/.cache/thirdparty/...` directly.
- Do not add extra providers.
- Do not add broad SDK dependencies just because upstream uses them.

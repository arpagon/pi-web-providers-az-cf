# Fork / Vivefork: arpagon/pi-web-providers-az-cf

## Purpose

`arpagon/pi-web-providers-az-cf` is a security-minimal Pi extension inspired by [`mavam/pi-web-providers`](https://github.com/mavam/pi-web-providers), but intentionally limited to the web providers actually used in this environment:

| Tool | Provider |
| --- | --- |
| `web_search` / search | Azure OpenAI / OpenAI-compatible Responses API |
| `web_answer` / answer | Azure OpenAI / OpenAI-compatible Responses API |
| `web_research` / research | Azure OpenAI / OpenAI-compatible Responses API |
| `web_contents` / contents | Cloudflare Browser Rendering markdown endpoint |

This is not meant to be a general-purpose provider zoo. It is meant to be a small, auditable, npm-published Pi extension with a narrow trust boundary.

## Origin

Reference upstream:

```text
mavam/pi-web-providers
```

Local third-party cache path:

```text
~/Workspace/.cache/thirdparty/github.com/mavam/pi-web-providers
```

At project creation time, the cached upstream was:

```text
8793b28 Release v3.2.0
2026-05-24 19:43:37 +0000
```

Refresh upstream reference material with:

```bash
bash /home/arpagon/.pi/agent/skills/thirdparty/checkout.sh mavam/pi-web-providers --force-update --path-only
```

Do not edit the third-party cache directly. Treat it as read-only reference material.

## Why this exists

The upstream extension is powerful, but it installs and exposes many provider integrations that are not needed here. That increases npm/bun supply-chain attack surface and makes auditing harder.

Examples of upstream provider/runtime dependency surface that this project should avoid unless explicitly re-approved:

```text
@anthropic-ai/claude-agent-sdk
@google/genai
@mendable/firecrawl-js
@openai/codex-sdk
@perplexity-ai/perplexity_ai
@tavily/core
exa-js
linkup-sdk
parallel-web
valyu-js
provider SDKs for unused providers
```

The intended design is allowlist-based: if a provider is not Azure OpenAI/OpenAI-compatible or Cloudflare Browser Rendering, it should not exist in the runtime package.

## Security and maintenance philosophy

1. **Minimum provider set**
   - Keep only OpenAI-compatible/Azure OpenAI and Cloudflare.
   - No Brave, Claude, Codex, custom, Exa, Firecrawl, Gemini, Linkup, Ollama, Parallel, Perplexity, Serper, Tavily, Valyu, or other providers.

2. **Minimum runtime dependencies**
   - Prefer direct `fetch` calls to the relevant REST APIs when the API surface is small and stable.
   - Runtime dependencies should ideally be empty, but this is a tradeoff, not dogma.
   - SDKs may be re-evaluated when they materially reduce correctness or maintenance risk without adding much supply-chain surface.
   - Current assessment: the official `openai` SDK is acceptable if needed later because it has no runtime dependencies, but direct `fetch` is still simpler for the small Responses API subset used here; the official `cloudflare` SDK remains unattractive for this project because it brings a much larger generated API surface and dependency tree for one markdown endpoint.
   - Peer/dev dependencies for Pi APIs, TypeScript, tests, and build tooling are acceptable.
   - Any new runtime dependency must be justified in writing.

3. **NPM-published with builds**
   - This should still behave like the user's other Pi packages: buildable, testable, and eventually publishable to npm.
   - NPM publishing/auth/2FA details are intentionally deferred.
   - Tentative package name: `pi-web-providers-az-cf` unless changed before publishing.

4. **Upstream as inspiration, not inherited trust**
   - Upstream UX/API ideas can be copied or reimplemented deliberately.
   - Do not mechanically sync all source or dependencies from upstream.
   - Prefer small hand-written modules over broad upstream carry-over.

5. **Explicit configuration compatibility**
   - The target local Pi config currently maps:
     - `search` -> `openai`
     - `answer` -> `openai`
     - `research` -> `openai`
     - `contents` -> `cloudflare`
   - The extension should remain compatible with this shape of `~/.pi/agent/web-providers.json`.
   - Do not copy secrets from `~/.pi/agent/web-providers.json` into repository files.

## Expected project shape

Likely structure:

```text
.
├── AGENTS.md
├── FORK.md
├── package.json
├── README.md
├── src/
│   ├── index.ts
│   ├── config.ts
│   ├── providers/
│   │   ├── cloudflare.ts
│   │   └── openai.ts
│   └── types.ts
├── test/
├── tsconfig.json
└── bun.lock / package-lock.json
```

The structure may change, but the provider surface should not expand without an explicit decision.

## Relationship to the old fork

There is an older local fork/checkouts named `pi-web-providers` under paths such as:

```text
~/Workspace/arpagon/pi-web-providers
~/.pi/agent/git/github.com/arpagon/pi-web-providers
```

Those are historical reference material only. This project is intended to be cleaner and narrower, not a continuation of every old patch.

## Install target

Once implemented, Pi should eventually switch from:

```json
"git:github.com/mavam/pi-web-providers"
```

to this project, probably one of:

```json
"git:github.com/arpagon/pi-web-providers-az-cf"
```

or, after npm publication:

```json
"npm:pi-web-providers-az-cf"
```

Exact install method can be decided later.

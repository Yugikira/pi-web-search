# pi-web-search

Provider-native `web_search` and `url_context` extension for Pi (Gemini, Google Antigravity, DeepSeek, xAI Grok, OpenAI/Azure/Codex/Copilot Responses, Anthropic, Ollama Cloud, OpenCode Zen/Go, and Exa fallback). Upstream fork of `ttttmr/pi-web-search`; preserve existing source layout (`src/`, `tests/`).

## Commands (`pnpm`)

```bash
pnpm install
pnpm test
pnpm run typecheck
# Live provider smoke tests (require credentials):
pnpm run test:real:web-search
pnpm run test:real:url-context
```

## Invariants

- **No silent model hopping:** When the active model lacks native search, return an error rather than scanning other configured models (unless explicitly overridden via `~/.pi/agent/web-search.json` or Exa fallback).
- **Credentials stay out of git:** Do not commit OAuth client secrets or API keys in `src/providers/antigravity.ts`; supply them via env vars or `~/.pi/agent/web-search.json`.

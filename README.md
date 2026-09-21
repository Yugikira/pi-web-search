# pi-web-search

Provider-native web search for [pi](https://pi.dev) with Gemini + URL Context, Google Antigravity, DeepSeek, xAI Grok, OpenAI Responses variants, Anthropic, Ollama Cloud, OpenCode Zen/Go, and Exa fallback.

## Tools

### `web_search`

Search the web using your currently selected model. Automatically picks the right provider API:

| Provider | API |
|---|---|
| Google Gemini | Grounding with Google Search |
| Google Antigravity | Cloud Code Assist `v1internal` grounding (`gemini-2.5-flash`) |
| DeepSeek | Anthropic Messages API `web_search` (`/anthropic/v1/messages`) |
| xAI Grok | Responses API `web_search` |
| OpenAI | Responses API web search |
| Azure OpenAI | Responses API web search (`azure-openai-responses`) |
| OpenAI Codex | Codex Responses API web search (`openai-codex-responses`) |
| GitHub Copilot | OpenAI Responses API web search via Copilot credentials |
| Anthropic | Messages API web search |
| Ollama Cloud | Ollama web search API (`/api/web_search`, standalone REST) |
| OpenCode Zen / Go | Responses API web search (models that use the `openai-responses` API) |
| Exa AI (Fallback) | Exa Search API (`/search`) for unregistered/unsupported models |

GitHub Copilot OpenAI Responses models are supported, including Business and Enterprise seats whose API endpoint is resolved from their authenticated Copilot credentials. This includes models such as `gpt-5.6-sol`.

OpenCode Zen and OpenCode Go Responses models (for example `opencode-go/gpt-5.6-luna` or `opencode-go/grok-4.6`) use the same Responses web search. OpenCode routes traffic per conversation, so `web_search` sends the `x-opencode-session` and `x-opencode-client` headers pi uses, keyed to the active session. Only models exposed through that Responses API are supported: OpenCode `chat/completions` models have no provider-native search tool, and the gateway's Anthropic Messages models are unverified.

Ollama Cloud models (provider `ollama-cloud` or any model hosted on `ollama.com`) call Ollama's standalone web search API rather than a model tool. Auth is `OLLAMA_API_KEY` or `/login ollama-cloud`. Any `urls` are fetched through `web_fetch`. A local Ollama daemon is out of scope — the official `@ollama/pi-web-search` package covers its `/api/experimental/*` endpoints.

Supports passing up to 20 additional URLs to analyze alongside the query. Successful `web_search` results are collapsed by default in pi; expand the tool call to inspect the full answer and source details.

### `url_context`

Gemini, Antigravity, and Ollama Cloud. Analyze up to 20 public URLs — web pages, documents, images, and YouTube videos. Gemini and Antigravity use native URL Context retrieval with verified metadata; Ollama uses its `web_fetch` endpoint (web pages and documents only).

When using `google-generative-ai`, YouTube URLs are passed as `file_data` for native video understanding. Antigravity uses Cloud Code's `v1internal` grounding sub-call (`gemini-2.5-flash`).

## Install

```bash
pi install npm:pi-web-search
```

## Usage

No extra config needed. Select a supported current model in pi and the tools auto-detect the matching provider API.

`web_search` will not scan configured models and pick one automatically when the current model does not support native search. To use a dedicated search model, opt in explicitly with `web-search.json` in pi's agent directory (by default `~/.pi/agent/`; respects `PI_CODING_AGENT_DIR`):

```json
{
  "provider": "openai",
  "model": "gpt-5.1"
}
```

When this file exists, `web_search` uses the configured provider/model first. If it is missing, `web_search` uses the current conversation model. If the selected model does not support native search, the tool returns an error instead of falling back (unless Exa fallback is configured).

### Provider Configuration & Notes

#### Google Antigravity
- **Auth**: Reuses OAuth tokens stored in `~/.pi/agent/auth.json`.
- **Grounding**: Routes grounding sub-calls to Google Cloud Code's `v1internal:generateContent` using `gemini-2.5-flash`. Supports both `web_search` and `url_context`.
- **Client Credentials**: Before using Antigravity token refresh, please configure your client credentials (`clientId` and `clientSecret`). You can set them via:
  - Environment variables: `ANTIGRAVITY_CLIENT_ID` and `ANTIGRAVITY_CLIENT_SECRET` (or directly in `src/providers/antigravity.ts`), or
  - Configuration in `~/.pi/agent/web-search.json`:
    ```json
    {
      "antigravity": {
        "clientId": "<client-id>",
        "clientSecret": "<client-secret>"
      }
    }
    ```
  - Or in `~/.pi/agent/auth.json` under `"antigravity"`.

#### DeepSeek
- Uses DeepSeek's Anthropic Messages-compatible endpoint (`https://api.deepseek.com/anthropic/v1/messages`) with server-side web search.
- Automatically detected even when Pi registers DeepSeek under `openai-chatcompletions`.
- Credentials resolve from Pi's auth registry or `DEEPSEEK_API_KEY`.

#### Exa Search Fallback
- For models or providers that do not support native web search, `pi-web-search` can fall back to Exa Search API (`https://api.exa.ai/search`).
- Set `EXA_API_KEY` in your environment or configure it in `~/.pi/agent/web-search.json`:
  ```json
  {
    "exa": {
      "apiKey": "your-exa-api-key"
    }
  }
  ```
- *Note*: Exa fallback handles `web_search` queries; `url_context` remains suppressed for unsupported models.

`url_context` is automatically removed from active tools when using a model that supports neither Gemini URL Context nor Ollama web fetch.

## Test

```bash
cp .env.example .env   # edit with your models
npm test               # unit tests
npm run test:real:web-search
npm run test:real:url-context
```

## License

MIT

# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.6.0] - 2026-06-04

### Added
- **`sonar_stats` now tracks Claude context tokens alongside Sonar tokens** — pass `claude_context_tokens` when calling `sonar_stats` to log the current Claude session size. Stats show a side-by-side comparison (Sonar local GPU vs Claude API) with a `Local%` column showing how much work was offloaded.
- **Rolling 365-day data retention** — stats file is pruned automatically on every write; entries older than one year are dropped.
- **"30 days" and "All time" periods** added alongside today / week / year.

## [1.5.0] - 2026-06-04

### Changed
- **`sonar_stats` now shows Claude Pro session percentage** — each period's token count is displayed as a percentage of a 200,000-token Claude Pro context window, with an ASCII progress bar, so you can see at a glance how much local compute you've offloaded relative to a full Claude session.

## [1.4.0] - 2026-05-27

### Changed
- **Replaced broken DDG scrapers with Brave Search API** — `duckduckgo` and `duckduckgo-lite` engines removed; DuckDuckGo now blocks all HTML scraping and returns the homepage for bot requests. Add a free Brave Search API key (`search.braveApiKey` in `sonar.config.json`) to restore full web search. Keys are free at https://api.search.brave.com/register.
- Default engine list is now `["brave", "wikipedia", "ddg-instant", "searxng"]`; `brave` is silently skipped when no key is configured so the other two still work without setup.
- `sonar_health` now shows Brave API key status and a link to register.

### Fixed
- `multiSearch` no longer counts `brave` against the active engine total when no key is set, so the "X/N engines" label in responses is accurate.

## [1.3.0] - 2026-05-27

### Added
- **`sonar_update_check`** tool — fetches the latest `package.json` from GitHub, compares it against the running version, and if a newer release exists shows the version number and the relevant CHANGELOG sections. Prompts to run `sonar_update` to install.
- **`sonar_update`** tool — runs `node install.js --update --yes` to pull the latest code from GitHub, re-install dependencies if needed, and verify the server still starts. Instructs the user to fully restart Claude Desktop afterwards.
- **GPU-aware model auto-selection** — at startup Sonar queries `nvidia-smi` for free VRAM and `ollama /api/tags` for locally available models, then picks the best fitting model per role from a ranked preference table. Falls back to `sonar.config.json` models if Ollama is unreachable or `autoSelectModels` is `false`.
- **Reduced default context window** (`numCtx: 4096`) — cuts KV-cache VRAM from ~4 GiB to ~0.5 GiB per model, preventing GPU memory contention with other applications.
- **Memory-mapped model loading** (`useMmap: true`) — passes `use_mmap` to Ollama so model weights are mapped from disk instead of `malloc`'d, avoiding Windows commit-charge failures on systems with small page files.

## [1.1.0] - 2026-05-20

### Added
- **Vision route** — `sonar` now accepts an `image_path` parameter (local file or URL) and routes image questions to a vision model (`gemma3:12b` by default).
- **Per-request model override** — `sonar` accepts an optional `model` parameter (`auto` / `simple` / `coder` / `vision` / `web`) to force a route instead of auto-classifying.
- **Conversation memory** — `sonar` accepts an optional `use_history` flag that carries the last few exchanges as context for follow-up questions (depth set by `historyTurns`).
- **`sonar_health`** tool — reports whether Ollama is reachable, which models are loaded in VRAM, and whether every configured model is pulled.
- **Cost-savings estimate** — `sonar_stats` now shows the estimated Claude API dollar cost avoided, using configurable input/output token rates.
- **Configuration file** — an optional `sonar.config.json` (see `sonar.config.example.json`) overrides models, Ollama URL, search provider, pricing, and history depth without editing code. It is git-ignored so settings survive updates.
- **Multi-engine web search** — the web route now queries several engines *in parallel* (DuckDuckGo HTML, DuckDuckGo Lite, Wikipedia, DuckDuckGo Instant Answers, and optionally SearXNG), then merges and de-duplicates results by URL. If an engine is down, rate-limited, or returns junk, the others still answer. Engines are selectable via `search.engines`.

### Changed
- `askOllama` now surfaces Ollama's `error` field as a real exception so failures map to friendly messages.
- `friendlyError` recognizes more failure modes: generic CUDA errors, runner-process crashes, and `memory layout cannot be allocated`.
- Search config replaced `search.provider` with `search.engines` (array) — engines run together rather than one-with-fallback.

## [1.0.0] - 2026-05-19

### Added
- Single **`sonar`** MCP tool that auto-routes every prompt to the best local model:
  - `llama3.1:8b` for general tasks (summarizing, describing, translating, drafting, explaining)
  - `qwen2.5-coder:7b` for coding tasks (writing, debugging, refactoring, algorithms)
  - DuckDuckGo web search + `llama3.1:8b` for live/current information (news, weather, prices, URLs)
- **`sonar_stats`** tool showing tokens processed locally, broken down by today / week / month / year, with the running `sonar-mcp` version.
- **Automated installer** (`install.js` / `npm run setup`) with read-only pre-flight checks, a numbered plan summary, and an explicit confirmation prompt before any change.
- **Safety system**: timestamped backup of `claude_desktop_config.json` before editing, in-memory snapshot, and automatic rollback on any error, `Ctrl+C`, or cancellation. Existing config entries and Ollama models are never removed.
- **Self-update** via `npm run update` (`install.js --update`): fetches from GitHub, shows incoming commits, confirms before pulling, and re-verifies the server starts.
- `keep_alive: 0` on every Ollama call so models unload after use and never compete for VRAM.

### Fixed
- Infinite recursion in the `fetchWithTimeout` wrapper that caused every `sonar` call to fail with `Maximum call stack size exceeded`. The timeout wrapper was accidentally calling itself instead of the underlying `fetch`.

[1.1.0]: https://github.com/wanz1000/sonar-mcp/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/wanz1000/sonar-mcp/releases/tag/v1.0.0

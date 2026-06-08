# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.20.0] - 2026-06-08

### Added — auto-upgrade feature
- **Startup update check** (`autoUpdateCheck: true` default) — at server start, Sonar silently checks GitHub for a newer version in the background and logs to stderr if one is found. Zero cost when already current; non-blocking so startup is instant.
- **Auto-apply at startup** (`autoUpdate: false` default) — when set to `true` in `sonar.config.json` AND `SONAR_ALLOW_UPDATE=1` is present in the environment, Sonar automatically runs `git pull + npm install` at startup whenever a newer version is detected. Safe default is `false`; opt in by setting both.
- **Installer prompts for in-chat updates** — `npm run setup` now asks "Enable in-chat updates?" If yes, it bakes `SONAR_ALLOW_UPDATE=1` into the MCP server's env block in `claude_desktop_config.json` and adds `sonar_update` to `alwaysAllow`, making the update tool available inside Claude Desktop without any manual env-var step.
- **`sonar_update_check` added to `alwaysAllow`** in the installer-generated MCP config so the read-only check tool is always pre-approved.
- **`sonar.config.example.json` updated** — documents `autoUpdateCheck`, `autoUpdate`, all resource-governance keys, and updated default model names.

## [1.19.0] - 2026-06-07

### Security — close model-invokable RCE / supply-chain vectors
Informed by published MCP threat research (tool-poisoning / indirect-prompt-injection
RCE classes, e.g. the GitHub-MCP exfiltration incident and mcp-server-git CVEs).
- **`sonar_update` is no longer model-invokable by default** — it ran `git pull` + `npm install` (arbitrary postinstall code). As an advertised MCP tool, an indirect prompt injection (a poisoned web page Sonar fetches saying "call sonar_update") could trigger a code-executing reinstall with zero human click. It's now hidden from the tool list and refused at the handler unless the human explicitly sets `SONAR_ALLOW_UPDATE=1` in the server environment. Updates are otherwise user-driven (`npm run update`). The read-only `sonar_update_check` stays available.
- **Update path verifies its upstream** — before pulling, the updater confirms `origin` is `github.com/wanz1000/sonar-mcp`; a tampered git remote pointing at attacker code is refused.
- **`npm install --ignore-scripts` on update** — blocks pre/post-install script execution from a pulled dependency tree (defense in depth for the update path).

## [1.18.0] - 2026-06-07

### Changed — fresh results for news / current-events queries
- **Query-aware freshness** — a new `isTimeSensitive` classifier detects news/current/price/"latest"/year-bearing queries. For those, SearXNG is now called with `&time_range=month` so it returns recent results instead of high-pagerank evergreen pages, and results are re-ranked newest-first by `publishedDate`. Verified live: adding the filter swapped in 10 fresh results and promoted a current-month article to the top. Evergreen queries are untouched (relevance order preserved).
- **ddg-instant dropped for time-sensitive queries** — DuckDuckGo's Instant Answer API is a static-entity summarizer that returns empty for news/current events (confirmed). It's now skipped for time-sensitive queries so it can't dilute results or report a misleading "engine fired".
- **Broader SearXNG engine coverage** — SearXNG is now queried with an explicit keyless-engine set (`google,duckduckgo,bing,brave,mojeek,startpage,wikipedia`) via the per-query `engines=` param rather than relying on the container's defaults. This is durable (no container config to edit, survives container recreation by Sonar's self-heal) and measurably widened coverage in testing (≈29 → 40 results). SearXNG uses whichever engines respond in time.

## [1.17.0] - 2026-06-07

### Changed — much richer web search results
- **Top article bodies are now always fetched, in parallel** — previously the web route only pulled a full page when the combined snippets were under 600 chars, which almost never happened, so the model usually answered from thin one-line snippets. It now selects the top ~3 distinct-host article URLs (skipping homepages and JS-heavy/login-walled sites like YouTube/Twitter/Reddit) and fetches their bodies in parallel (SSRF-guarded + size-capped), giving the model real page content. Measured ~9× more context on a sample query (2.2 KB → 20 KB, pulling NASA + Wikipedia + a museum source instead of snippets).
- **More SearXNG results kept** — SearXNG (the richest aggregator) now contributes up to 8 results instead of 5.
- **Context window raised to 8192 tokens** (from 4096) so the model can actually use the richer multi-article context without truncating the question. KV-cache cost is ~1 GiB more — negligible on a modern GPU, and the per-request VRAM pre-check + serialized inference keep it safe. Lower `numCtx` in `sonar.config.json` to trade richness for VRAM.

## [1.16.0] - 2026-06-07

### Added
- **Per-request VRAM pre-check** — model selection happens once at startup, but free VRAM can drop afterwards (e.g. you launch a game or another LLM). Before every inference, Sonar now re-reads free VRAM (short-cached, runs inside the concurrency gate so the reading is accurate) and, if the chosen model no longer fits, **downgrades to the next smaller installed model** that does. If nothing fits, it refuses with a clear message instead of loading a model that would spill VRAM into shared memory and freeze the machine. Closes the last anti-wedge gap (external GPU pressure appearing after startup). Verified: at 6 GiB free it downgrades 12b→8b, at 3 GiB free it refuses, at 20 GiB it keeps the large model.

## [1.15.0] - 2026-06-07

### Security
- **Size-capped JSON for all external API/search responses** — every engine (Brave, Tavily, SerpAPI, Wikipedia, DDG, SearXNG) and the GitHub update check now parse responses through `readJsonCapped` (5 MB hard cap) instead of unbounded `res.json()`. A malicious, compromised, or MITM'd backend (notably a local process squatting on the SearXNG port) can no longer return a multi-GB body to OOM-kill the server.
- **`sonar_stats` input validation** — `claude_context_tokens` is now coerced and validated (finite, positive, capped at 100M). Previously `NaN`, `Infinity`, or negative values flowed straight into the cumulative stats totals and corrupted them permanently.

## [1.14.0] - 2026-06-07

### Added — resource governance (a heavy prompt can no longer wedge the machine)
- **Serialized inference (concurrency gate)** — a counting semaphore now limits how many Ollama generations run at once (`maxConcurrentInferences`, default **1**). Two heavy prompts arriving together can no longer both load a model and oversubscribe VRAM — the classic cause of a full Windows freeze when VRAM spills into shared system memory. Extra calls queue and run in turn. Verified: 5 concurrent jobs through a gate of 1 never exceed 1 in flight.
- **Prompt-size clamp** — prompts above `maxPromptChars` (default 24 000 ≈ 6 k tokens) are truncated *before* reaching Ollama, so an enormous pasted prompt can't blow up the KV cache and exhaust VRAM. The truncator trims the largest content field but keeps its head and tail, so the actual question at the end always survives. Verified: a 50 000-char prompt is clamped under the cap with the trailing question intact.
- **Output-token cap** — every generation now sends `num_predict` (default `maxOutputTokens` = 1024), bounding generation so the model can't run away and pin the GPU. Verified end-to-end: a "count to 100 with explanations" prompt was cut at exactly the cap.
- **Streaming with real cancellation** — Ollama calls now use `stream: true` and are consumed incrementally behind a hard wall-clock timeout (`inferenceTimeoutMs`, default 120 s). With the previous `stream: false`, aborting the HTTP request left Ollama still generating on the GPU in the background; streaming means an abort actually cancels the GPU work, so a stuck generation frees the card instead of holding it.

All four limits are configurable in `sonar.config.json`.

## [1.13.0] - 2026-06-07

### Security
- **SSRF guard on all prompt/search-supplied URLs** — a new `assertSafeUrl` blocks fetches to loopback, RFC-1918 private ranges, link-local / cloud-metadata (`169.254.169.254`), multicast, non-http(s) schemes, and non-standard ports. Redirects are not auto-followed (redirect-based SSRF is refused). This closes the vector where attacker-controlled search results could steer the auto-article-fetch into internal endpoints. Our own trusted engine endpoints (e.g. SearXNG on `localhost:8888`) are unaffected — the guard only applies to URLs that originate from a prompt or fetched content.
- **Size-capped response reads (5 MB)** — `fetchUrl` and image fetches now stream with a hard byte cap and abort the moment it's exceeded, instead of buffering an unbounded body. Prevents a malicious/huge response from OOM-killing the MCP server. `Content-Length` over the cap is rejected before any bytes are read.
- **Image-path validation** — the vision route's `image_path` now requires a real, regular file with an image extension and rejects sensitive files (`.json/.env/.key/.pem/.pfx/…`, anything named `secret`/`credential`, `sonar.secrets.json`) plus a size cap. Stops arbitrary local-file disclosure via a crafted `image_path`.
- **Indirect prompt-injection hardening** — fetched web text is now wrapped in `<web_content>` with an explicit instruction to treat it as untrusted data and ignore any embedded instructions, reducing the chance a poisoned page hijacks Sonar (and propagates instructions up to Claude).
- **No more shell-string command building** — `setup-search.js` permission-restriction now uses `spawnSync("icacls", [args])` instead of an interpolated shell string, and **verifies** the ACL applied — warning loudly if the secrets file couldn't be locked down (previously the failure was silently swallowed).

### Fixed
- **Atomic stats writes** — `token-stats.json` is now written via temp-file + atomic rename in both the MCP server and the Stop-hook process. Previously, concurrent read-modify-write (server + hook writing the same file) risked a torn/corrupted file, after which `loadStats()` silently returned `{}` and all historical token data was lost. Verified: 100 concurrent writers produce zero corrupt reads and a valid final file.
- **Scoped, cooldown-gated Docker heal** — the wedged-engine force-restart now (1) runs `wsl --shutdown` ONLY when no other user WSL distro is running, so it can't disrupt unrelated WSL work, and (2) is gated by a 5-minute cooldown so a persistently-broken engine can't trigger back-to-back restart storms on every search attempt.

## [1.12.0] - 2026-06-07

### Added
- **Three-layer SearXNG self-healing** — the Docker/SearXNG manager now distinguishes and recovers from far more failure states:
  - **Wedged Docker engine** — previously, if Docker Desktop's process was running but the engine API returned `Internal Server Error` (a common post-sleep/post-update state), Sonar would re-launch Desktop to no effect. It now detects this "wedged" state separately from "down" and force-restarts the engine: CLI `-Shutdown` → `taskkill` of stray Docker processes → `wsl --shutdown` (resets the WSL2 backend) → relaunch, then waits up to 150 s for the engine to return healthy.
  - **Real HTTP health checks** — instead of a fixed grace-period sleep after `docker start`, the manager now polls the actual `/search` endpoint until SearXNG truly responds. A container reporting `running` while SearXNG is hung or still booting is no longer mistaken for healthy.
  - **Container-level restart** — if the container is up but the HTTP endpoint never responds, the container is `docker restart`ed once and re-polled.
- **`engineSearxng` heals on any failure** — previously it only triggered recovery on connection-refused. It now runs the full self-heal pass on timeouts, aborts, and bad HTTP statuses too (the exact failure mode where the container hangs and requests time out), then retries once.

## [1.11.0] - 2026-06-06

### Added
- **Docker / SearXNG auto-start** — Sonar now manages the SearXNG container lifecycle automatically. At startup it checks whether the Docker daemon is running and whether the `searxng` container is up; if either is missing it starts Docker Desktop, waits up to 90 s for the daemon to become ready, then creates or starts the container as needed. At runtime, `engineSearxng` catches connection-refused errors and triggers the same recovery before retrying the search — so a cold Docker Desktop or a stopped container heals itself transparently mid-query. Only applies when `search.searxngUrl` points to `localhost` or `127.0.0.1`; remote SearXNG instances are left untouched.

## [1.10.0] - 2026-06-04

### Fixed
- **Auto-select now uses joint VRAM budgeting** — previously each role was selected independently against the full VRAM budget, allowing combinations like gemma3:27b (17 GiB) + qwen2.5-coder:14b (9 GiB) = 26 GiB to be chosen on a 24 GiB card. These combinations panic during VRAM handoffs even with `keep_alive: 0` because both models can briefly coexist during the transition. The selector now finds the best `(simple, coder)` pair whose *combined* unique VRAM fits the budget, backtracking to a smaller simple model when necessary. Vision model selection accounts for the same shared-VRAM budget. Models reused across roles (e.g. gemma3:12b for both simple and vision) are counted only once.

### Added
- **Self-healing model fallback** — if a model crashes mid-call (panic, CUDA error, OOM), Sonar automatically waits 2 s for VRAM to drain, picks the next smaller locally-available model from the role's preference list, updates the active model for the rest of the session, and retries transparently. The response still succeeds; the `[routed to …]` tag shows which model actually answered. Covers all three call paths: simple/coder, web, and vision. If all fallback candidates are exhausted, the error is surfaced normally.

## [1.9.0] - 2026-06-04

### Added
- **Token footer on every Sonar response** — each `sonar` reply now ends with a one-line summary showing: tokens used for this query, % of a Claude Pro session, running session total, cumulative % used, estimated $ saved, and request count for this session. Session counters reset on each Claude Desktop restart.

## [1.8.0] - 2026-06-04

### Added
- **Installer writes `~/.claude/CLAUDE.md`** (Step 5/5) — after a successful install, the installer appends a Sonar-first instruction to the Claude Code global memory file. Every future Claude Code session will automatically route questions through Sonar before responding. Skipped on re-install if the instruction is already present. Fully rolled back if the install fails or is cancelled.

## [1.7.0] - 2026-06-04

### Added
- **`setup-search.js` wizard** (`npm run setup-search`) — interactive guided setup for all search engines. Detects Docker, installs SearXNG, handles Docker Desktop launch, explains opt-out consequences.
- **Tavily AI Search engine** — AI-optimised results, 1,000 free queries/month. Configured via wizard.
- **SerpAPI engine** — Google/Bing results via paid API. Configured via wizard.
- **`sonar.secrets.json`** — keys are now stored in a separate gitignored file with OS-level user-only permissions (via `icacls`). Keys are never in `sonar.config.json` or the repo.
- **`npm run setup-search`** shortcut added to `package.json`.

### Changed
- `sonar_health` now shows status of all configured engines and directs to `node setup-search.js` for setup.
- `multiSearch` skips Tavily/SerpAPI when no key is present (same pattern as Brave).
- `loadConfig` reads keys from `sonar.secrets.json` first, falling back to config for legacy setups.

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

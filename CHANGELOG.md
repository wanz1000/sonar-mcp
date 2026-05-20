# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.0.0]: https://github.com/wanz1000/sonar-mcp/releases/tag/v1.0.0

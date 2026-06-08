# sonar-mcp 🔊

A lightweight MCP (Model Context Protocol) server that connects **Claude Desktop** to local **Ollama** models. One tool — `sonar` — automatically routes every prompt to the right model, including live web search when needed. Free, fast, and runs entirely on your GPU.

> 🎉 **New in v1.20.0**
> - 🔁 **Auto-upgrade** — Sonar checks GitHub for updates at every startup and logs when a new version is available. Enable `autoUpdate: true` in `sonar.config.json` + `SONAR_ALLOW_UPDATE=1` to apply updates automatically. The installer now asks "Enable in-chat updates?" and wires everything in for you.
> - 💬 **In-chat updates** — `sonar_update_check` shows what's new; `sonar_update` applies it without leaving Claude Desktop (opt-in via installer or manual config)
>
> **Also in recent releases:**
> - 🧠 **VRAM-safe model auto-selection** — jointly picks the best model pair that fits in free GPU VRAM; never oversubscribes
> - 🔄 **Self-healing crash recovery** — on OOM or model crash, automatically downgrades to the next smaller model and retries
> - 🐳 **Docker/SearXNG auto-start** — starts Docker Desktop and the SearXNG container automatically at startup and on demand
> - 🔒 **Concurrency gate** — serializes GPU inference to prevent simultaneous model loads from wedging your PC
> - ⚡ **Streaming inference + abort timeout** — stream-based responses with AbortController; stuck requests are killed cleanly
> - 🛡️ **Security hardening** — SSRF guard (blocks loopback/private/metadata IPs), 5 MB fetch cap, atomic file writes, image allowlist, model-invokable update gated behind `SONAR_ALLOW_UPDATE=1`
> - 📰 **Time-sensitive search freshness** — auto-detects news/current-events queries, applies `time_range=month` + newest-first ranking
> - 📄 **Always-on article body fetch** — top 3 results always fetched in full, not just snippets
> - 📊 **Token savings footer** — every `sonar` response ends with per-query and session-running token savings
> - 🔢 **Doubled context window** — `numCtx` raised to 8192
>
> See the [changelog](CHANGELOG.md) for full details.

> **⚠️ Claude subscription required.** Sonar is designed to offload work from Claude to free local models, reducing token consumption. You need an active [Claude Pro or Team subscription](https://claude.ai/upgrade) with Claude Desktop to use it.

---

## ✨ Features

- **Single `sonar` tool** — no need to pick a model manually. Routing happens automatically:

  | Prompt type | Model used |
  |---|---|
  | General tasks (explain, summarize, translate, draft…) | `gemma3:12b` (or best fit for your VRAM) |
  | Coding tasks (write, debug, refactor, algorithms…) | `qwen2.5-coder:14b` (or best fit for your VRAM) |
  | Image questions (pass `image_path`) | `gemma3:12b` |
  | Live/current info (news, weather, prices, URLs…) | Multi-engine web search → local model |

- **GPU-aware VRAM auto-selection** — at startup Sonar reads free VRAM (`nvidia-smi`) and jointly selects the largest model pair that fits. If VRAM changes between requests, a per-request pre-check downgrades automatically rather than crashing.

- **Self-healing everywhere** — OOM or model crash? Sonar downgrades and retries. Docker down? It starts it. SearXNG container missing? It creates it. Ollama not running? It tells you exactly how to fix it.

- **Concurrency gate** — only one inference runs at a time. Parallel `sonar` calls queue cleanly instead of loading two large models simultaneously and exhausting VRAM.

- **Rich web search** — queries SearXNG (7 engines: Google, DuckDuckGo, Bing, Brave, Mojeek, Startpage, Wikipedia) plus DuckDuckGo Instant Answers and Wikipedia in parallel. For news/current-events queries, applies a freshness filter and re-ranks by recency. Top 3 results are always fetched in full (article body), not just snippets.

- **`sonar_stats` tool** — tokens processed locally *and* estimated Claude API cost saved, by today / week / month / year. Automatically appended as a footer to every `sonar` response.

- **`sonar_health` tool** — checks Ollama reachability, shows what's loaded in VRAM, verifies every configured model is pulled, and reports Docker/SearXNG status.

- **`sonar_update_check` / `sonar_update` tools** — check for new versions and apply updates from GitHub without leaving Claude Desktop (update requires `SONAR_ALLOW_UPDATE=1` env var).

- **Configurable** — an optional [`sonar.config.json`](#️-configuration) overrides models, search providers, context window, pricing, and more without editing code.

- **VRAM-safe** — `keep_alive: 0` unloads each model immediately after a call so models never idle in VRAM.

- **No API keys required for core search** — SearXNG is self-hosted; Brave Search API key is optional for direct Brave queries.

---

## 📋 Prerequisites

### You install these first (the installer cannot do these for you)

- **Active Claude subscription** — [Claude Pro or Team](https://claude.ai/upgrade).
- **[Claude Desktop](https://claude.ai/download)** — the desktop app (not the web version), signed in to your account.
- **[Node.js](https://nodejs.org) 18 or later** — verify with `node --version`.
- **[Ollama](https://ollama.com)** — install the app, then launch it once so it's running (Windows tray icon / macOS menu bar).
- **[Docker Desktop](https://docs.docker.com/desktop/)** — required for SearXNG (self-hosted search). Sonar will prompt you if it's missing.
- **A GPU with ~8 GB+ VRAM** (recommended) — Ollama auto-detects NVIDIA, AMD, and Apple Silicon.
  - **Less VRAM?** Sonar auto-selects smaller models. No GPU? Ollama runs on CPU (10–60× slower but functional).

### The installer handles these automatically

- ✅ `npm install` — Node dependencies
- ✅ Ollama model pulls — selects models based on your available VRAM
- ✅ Edits `claude_desktop_config.json` to register the MCP server
- ✅ Writes Sonar self-heal instructions to `~/.claude/CLAUDE.md`
- ✅ Verifies the server starts cleanly before finishing

---

## 🚀 Installation

### Automatic (recommended)

```bash
git clone https://github.com/wanz1000/sonar-mcp.git
cd sonar-mcp
npm install
npm run setup
```

The installer is **read-only until you confirm**. It runs pre-flight checks, prints a summary of every change it will make, and asks `Proceed? [y/N]` before touching anything.

Once confirmed it will:
1. ✔ Verify Node.js 18+
2. ✔ Run `npm install`
3. ✔ Pull Ollama models appropriate for your VRAM
4. ✔ Auto-detect your Claude Desktop config file (Windows/macOS/Linux)
5. ✔ Register the MCP server in `claude_desktop_config.json`
6. ✔ Write Sonar self-heal instructions to `~/.claude/CLAUDE.md`
7. ✔ Verify the server starts cleanly

When it finishes, **fully quit Claude Desktop** (system tray / menu bar — don't just close the window) and reopen it. Done.

### 🛡️ Safety guarantees

- **Read-only pre-flight.** No file is written until you confirm.
- **Always backs up first.** Writes `claude_desktop_config.json.bak-<timestamp>` before editing.
- **Auto-rollback on failure or Ctrl+C.** Restores original config; removes `node_modules` if it didn't exist before.
- **Run with `--yes` to skip the prompt** (CI/automation): `npm run setup -- --yes`

---

### Manual (if you prefer)

<details>
<summary>Click to expand manual steps</summary>

**1. Pull the Ollama models**
```bash
ollama pull gemma3:12b
ollama pull qwen2.5-coder:14b
```
(Or smaller variants like `gemma3:4b` + `qwen2.5-coder:7b` for GPUs with less VRAM — Sonar auto-selects at runtime.)

**2. Clone and install**
```bash
git clone https://github.com/wanz1000/sonar-mcp.git
cd sonar-mcp
npm install
```

**3. Find your Claude Desktop config file**

| OS | Path |
|---|---|
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |

**4. Add the MCP server config**

Replace `ABSOLUTE_PATH` with the full path to your cloned folder:

```json
{
  "mcpServers": {
    "ollama-local": {
      "command": "node",
      "args": ["ABSOLUTE_PATH/index.js"],
      "alwaysAllow": ["sonar", "sonar_stats", "sonar_health"]
    }
  }
}
```

**5. Start SearXNG (for web search)**
```bash
docker run -d --name searxng --restart unless-stopped \
  -p 8888:8080 \
  -e SEARXNG_BASE_URL="http://localhost:8888/" \
  searxng/searxng:latest
```

**6. Restart Claude Desktop**

Fully quit (system tray / menu bar) and reopen.

</details>

---

## 🔄 Updating

### From a terminal (always available)

```bash
npm run update
```

Fetches and shows incoming commits, asks for confirmation, re-installs deps if needed, and verifies the server starts before finishing. Restart Claude Desktop after updating.

### From inside Claude Desktop (optional)

During `npm run setup`, the installer asks:

```
Enable in-chat updates? [y/N]
```

Say **yes** and it wires `SONAR_ALLOW_UPDATE=1` into the MCP server environment automatically. After restarting Claude Desktop you can then run:

- **`sonar_update_check`** — see if a newer version is available and what changed
- **`sonar_update`** — pull and apply the update without leaving the conversation

To enable it on an existing install without re-running setup, add `"env": {"SONAR_ALLOW_UPDATE": "1"}` to the `ollama-local` entry in `claude_desktop_config.json` and restart Claude Desktop.

### Automatic startup check

Sonar checks GitHub for updates silently every time it starts (controlled by `autoUpdateCheck` in `sonar.config.json`, default `true`). If a newer version exists, it logs to stderr:

```
[sonar/update] 🆕 v1.21.0 is available (you have v1.20.0)
[sonar/update] Run sonar_update_check in Claude Desktop for details and to update.
```

### Fully automatic updates at startup

To have Sonar apply updates automatically on startup, set in `sonar.config.json`:

```json
"autoUpdate": true
```

This requires `SONAR_ALLOW_UPDATE=1` to also be set (via the installer or manually). With both in place, Sonar will `git pull + npm install` in the background whenever a newer version is detected at startup.

---

## 💬 Usage

In any Claude Desktop conversation, type `sonar` followed by your request:

```
sonar explain how transformers work
sonar write a Go function to parse JSON
sonar what are the latest AI news headlines?
sonar summarize https://example.com/article
sonar_stats
sonar_health
```

Sonar routes it automatically. The result shows which model handled it:

```
[routed to gemma3:12b]

Transformers are a neural network architecture...

---
📊 Sonar — this query: 1,240 tokens (0.6% of Pro session) · session: 4,820 tokens · ~$0.02 saved · 3 req
```

### Optional parameters

| Parameter | Type | What it does |
|---|---|---|
| `model` | `auto` \| `simple` \| `coder` \| `vision` \| `web` | Force a route instead of auto-classifying. Default `auto`. |
| `image_path` | string | Local file path of an image — routes to the vision model. |
| `use_history` | boolean | Carry the last few sonar exchanges as context. Default `false`. |

---

## 🗂 Token stats & savings

`token-stats.json` is created automatically next to `index.js` and updated after every call. A summary footer is appended to every `sonar` response automatically.

Ask `sonar_stats` any time for full totals:

```
📊 Sonar Token Usage (processed locally)   sonar-mcp v1.19.0

  Today   : 1,240 tokens across 6 requests   (~$0.04 saved)
  Week    : 8,430 tokens across 41 requests  (~$0.21 saved)
  Month   : 31,200 tokens across 158 requests (~$0.78 saved)
  Year    : 31,200 tokens across 158 requests (~$0.78 saved)
```

### Claude Desktop session tracking

Install the Stop hook to automatically log your Claude Desktop session token usage:

```bash
npm run setup
```

The installer adds a Stop hook to `~/.claude/settings.json` that logs each session's token count when Claude Desktop closes.

---

## ⚙️ Configuration

All settings have built-in defaults — Sonar works with no config file. To customize:

```bash
cp sonar.config.example.json sonar.config.json
```

`sonar.config.json` is git-ignored, so your settings survive `npm run update`.

| Key | Default | Purpose |
|---|---|---|
| `ollamaUrl` | `http://localhost:11434` | Where Ollama is reachable |
| `autoSelectModels` | `true` | Auto-pick models based on free VRAM at startup |
| `models.simple` | `gemma3:12b` | General-task model (fallback when autoSelect is off) |
| `models.coder` | `qwen2.5-coder:14b` | Coding model |
| `models.vision` | `gemma3:12b` | Vision model |
| `numCtx` | `8192` | Context window tokens per request |
| `useMmap` | `true` | Memory-map model weights (reduces VRAM commit pressure) |
| `search.searxngUrl` | `http://localhost:8888` | Your SearXNG instance URL |
| `pricing.inputPerMillion` | `3.0` | Claude input price for savings estimate |
| `pricing.outputPerMillion` | `15.0` | Claude output price for savings estimate |
| `historyTurns` | `3` | How many prior exchanges `use_history` keeps |

### Optional API keys (`sonar.secrets.json`)

For optional paid search engines, create `sonar.secrets.json` (git-ignored, user-only file permissions):

```json
{
  "braveApiKey": "BSA...",
  "tavilyApiKey": "tvly-...",
  "serpApiKey": "..."
}
```

Run `npm run setup-search` for a guided wizard that creates this file securely.

---

## 🛠 Customization

Beyond `sonar.config.json`, open `index.js` to tune:
- `WEB_KEYWORDS` — what triggers a live web search
- `MODEL_VRAM_GB` — VRAM estimates for model auto-selection
- `ROLE_PREFERENCES` — ordered model candidates per role
- `ENGINES` — SearXNG engine list passed per-query
- `SKIP_HOSTS` — domains skipped during article body fetch

---

## 📜 Changelog

See [CHANGELOG.md](CHANGELOG.md) for the full version history.

---

## 📄 License

MIT

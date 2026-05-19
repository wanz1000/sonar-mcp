# sonar-mcp 🔊

A lightweight MCP (Model Context Protocol) server that connects **Claude Desktop** to local **Ollama** models. One tool — `sonar` — automatically routes every prompt to the right model, including live web search when needed. Free, fast, and runs entirely on your GPU.

> **⚠️ Claude subscription required.** Sonar is designed to offload work from Claude to free local models, reducing token consumption. You need an active [Claude Pro or Team subscription](https://claude.ai/upgrade) with Claude Desktop to use it.

---

## ✨ Features

- **Single `sonar` tool** — no need to pick a model manually. Routing happens automatically:
  | Prompt type | Model used |
  |---|---|
  | General tasks (explain, summarize, translate, draft…) | `llama3.1:8b` |
  | Coding tasks (write, debug, refactor, algorithms…) | `qwen2.5-coder:7b` |
  | Live/current info (news, weather, prices, URLs…) | DuckDuckGo → `llama3.1:8b` |

- **`sonar_stats` tool** — see how many tokens you've processed locally, broken down by today / week / month / year.

- **VRAM-safe** — `keep_alive: 0` unloads each model immediately after a call so two models never compete for VRAM at the same time.

- **No API keys required** — DuckDuckGo search uses the public HTML endpoint.

---

## 📋 Prerequisites

### You install these first (the installer cannot do these for you)

- **Active Claude subscription** — [Claude Pro or Team](https://claude.ai/upgrade). Sonar offloads work from Claude to free local models, so it only makes sense if you're paying for Claude tokens.
- **[Claude Desktop](https://claude.ai/download)** — the desktop app (not the web version), signed in to your account.
- **[Node.js](https://nodejs.org) 18 or later** — needed to run the installer itself. Verify with `node --version`.
- **[Ollama](https://ollama.com)** — install the app, then launch it once so it's running (Windows tray icon / macOS menu bar). Models are pulled by the installer below.
- **A GPU with ~8 GB VRAM** (recommended) — Ollama auto-detects NVIDIA, AMD, and Apple Silicon. Sonar uses `keep_alive: 0` so models load one at a time.
  - **No GPU?** Ollama also runs on CPU only — it's much slower (10–60× slower for small models) but functional.

### The installer handles these automatically

- ✅ `npm install` — Node dependencies (`@modelcontextprotocol/sdk`, `node-fetch`)
- ✅ `ollama pull llama3.1:8b` — general-task model (~5 GB)
- ✅ `ollama pull qwen2.5-coder:7b` — coding model (~5 GB)
- ✅ Edits `claude_desktop_config.json` to register the MCP server (existing entries preserved)
- ✅ Verifies the server starts cleanly before finishing

If a model is already pulled or dependencies are already installed, the installer skips that step.

---

## 🚀 Installation

### Automatic (recommended)

Clone the repo, then run the installer — it handles everything:

```bash
git clone https://github.com/wanz1000/sonar-mcp.git
cd sonar-mcp
npm install
npm run setup
```

The installer is **read-only until you confirm**. It runs pre-flight checks, prints a summary of exactly what it will do, and asks `Proceed? [y/N]` before any changes. If you say no, nothing changes.

Once confirmed it will:
1. ✔ Verify Node.js 18+ (prompts to update if too old, doesn't proceed otherwise)
2. ✔ Run `npm install` (only if `node_modules` doesn't already exist)
3. ✔ Pull `llama3.1:8b` + `qwen2.5-coder:7b` (only the ones not already present)
4. ✔ Auto-detect your Claude Desktop config file (Windows/macOS/Linux)
5. ✔ Add ONE entry to `claude_desktop_config.json` — every other entry is preserved
6. ✔ Verify the server starts cleanly

When it finishes, **fully quit Claude Desktop** (system tray / menu bar — don't just close the window) and reopen it. Done.

### 🛡️ Safety guarantees

- **Read-only pre-flight.** No file is written until you confirm at the `Proceed?` prompt.
- **Always backs up first.** Before editing `claude_desktop_config.json`, the installer writes `claude_desktop_config.json.bak-<timestamp>` next to it so you can recover manually any time.
- **Auto-rollback on failure or Ctrl+C.** If anything errors mid-install — or you cancel — the installer restores your original config exactly as it was, and removes `node_modules` if it didn't exist before. Your existing Ollama models are *never* removed (they may be useful for other things).
- **Version checks halt the installer.** If Node.js is too old, you're prompted to update or cancel; no changes happen until both are resolved.
- **Run with `--yes` to skip the prompt** (for CI/automation): `npm run setup -- --yes`

---

### Manual (if you prefer)

<details>
<summary>Click to expand manual steps</summary>

**1. Pull the Ollama models**
```bash
ollama pull llama3.1:8b
ollama pull qwen2.5-coder:7b
```

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

Add (or merge) this block — replace `ABSOLUTE_PATH` with the full path to your cloned folder:

```json
{
  "mcpServers": {
    "ollama-local": {
      "command": "node",
      "args": ["ABSOLUTE_PATH/index.js"],
      "alwaysAllow": ["sonar", "sonar_stats"]
    }
  }
}
```

**5. Restart Claude Desktop**

Fully quit (system tray / menu bar) and reopen.

**6. Confirm it's connected**

Go to **Claude Desktop → Settings → Developer**. You should see `ollama-local` with a green connected status.

</details>

---

## 💬 Usage

In any Claude Desktop conversation, type `sonar` followed by your request:

```
sonar explain how transformers work
sonar write a Go function to parse JSON
sonar what are the latest AI news headlines?
sonar summarize https://example.com/article
sonar_stats
```

Sonar will route it to the right model (or fetch the web) and return the answer — no confirmation prompts needed. The result shows which model handled it, for example:

```
[routed to llama3.1:8b]

Transformers are a neural network architecture...
```

---

## 🗂 Token stats

`token-stats.json` is created automatically next to `index.js` and updated after every call. It tracks prompt tokens + completion tokens per calendar day.

Ask `sonar_stats` any time to see your totals:

```
📊 Sonar Token Usage (processed locally)

  Today   : 1,240 tokens across 6 requests
  Week    : 8,430 tokens across 41 requests
  Month   : 31,200 tokens across 158 requests
  Year    : 31,200 tokens across 158 requests
```

---

## 🛠 Customization

Open `index.js` to:
- **Swap models** — change `MODELS.simple` or `MODELS.coder` to any model you have pulled in Ollama
- **Tune the web keyword list** — add terms to `WEB_KEYWORDS` to expand what triggers a live search
- **Adjust context size** — modify the `fetchUrl` character limit to send more or less page content to the model

The three routing paths (simple / coder / web) are clearly separated and easy to extend.

---

## 📄 License

MIT

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

Before starting, make sure you have all of the following:

- **Active Claude subscription** — [Claude Pro or Team](https://claude.ai/upgrade) with Claude Desktop installed and signed in
- **[Claude Desktop](https://claude.ai/download)** — the desktop app (not the web version)
- **[Ollama](https://ollama.com)** — running locally on `http://localhost:11434`
- **[Node.js](https://nodejs.org) 18 or later**
- **A GPU with enough VRAM** — 8 GB minimum recommended (models load one at a time)

---

## 🚀 Installation

### Step 1 — Pull the Ollama models

Open a terminal and run:

```bash
ollama pull llama3.1:8b
ollama pull qwen2.5-coder:7b
```

This downloads both models Sonar routes between. Only needs to be done once.

### Step 2 — Clone and install

```bash
git clone https://github.com/wanz1000/sonar-mcp.git
cd sonar-mcp
npm install
```

### Step 3 — Find your Claude Desktop config file

| OS | Path |
|---|---|
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |

Open that file in any text editor.

### Step 4 — Add the MCP server config

Add (or merge) this block — replace `ABSOLUTE_PATH` with the full path to your cloned `sonar-mcp` folder:

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

**Windows example:**
```json
"args": ["C:\\Users\\yourname\\sonar-mcp\\index.js"]
```

**macOS example:**
```json
"args": ["/Users/yourname/sonar-mcp/index.js"]
```

> If the file already has an `mcpServers` block, add `ollama-local` inside it alongside any existing entries.

### Step 5 — Restart Claude Desktop

Fully quit Claude Desktop (check the system tray / menu bar — don't just close the window) and reopen it.

### Step 6 — Confirm it's connected

Go to **Claude Desktop → Settings → Developer**. You should see `ollama-local` listed with a green connected status.

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

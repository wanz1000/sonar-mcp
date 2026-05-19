# sonar-mcp 🔊

A lightweight MCP (Model Context Protocol) server that connects **Claude Desktop** to local **Ollama** models. One tool — `sonar` — automatically routes every prompt to the right model, including live web search when needed. Free, fast, and runs entirely on your GPU.

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

- [Ollama](https://ollama.com) running locally on `http://localhost:11434`
- The two models pulled:
  ```bash
  ollama pull llama3.1:8b
  ollama pull qwen2.5-coder:7b
  ```
- [Node.js](https://nodejs.org) 18 or later
- [Claude Desktop](https://claude.ai/download)

---

## 🚀 Installation

```bash
git clone https://github.com/YOUR_USERNAME/sonar-mcp.git
cd sonar-mcp
npm install
```

Then find your Claude Desktop config file:

| OS | Path |
|---|---|
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |

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

**Restart Claude Desktop.** The `sonar` and `sonar_stats` tools will appear automatically.

---

## 💬 Usage

Just talk to Claude normally. Use `sonar` for anything you want handled locally:

```
sonar explain how transformers work
sonar write a Go function to parse JSON
sonar what are the latest AI news headlines?
sonar summarize https://example.com/article
sonar_stats
```

Sonar will route it to the right model (or fetch the web) and return the answer — no confirmation prompts needed.

---

## 🗂 Token stats

`token-stats.json` is created automatically next to `index.js` and updated after every call. It tracks prompt tokens + completion tokens per calendar day. Run `sonar_stats` any time to see your cumulative savings.

---

## 🛠 Customization

Open `index.js` to change models, adjust the routing keyword list, or tweak the web-search logic. The three routing paths are clearly separated and easy to extend.

---

## 📄 License

MIT

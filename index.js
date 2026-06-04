import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync, spawnSync } from "child_process";

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const STATS_FILE  = path.join(__dirname, "token-stats.json");
const CONFIG_FILE = path.join(__dirname, "sonar.config.json");
const INSTALL_JS  = path.join(__dirname, "install.js");
const GITHUB_RAW  = "https://raw.githubusercontent.com/wanz1000/sonar-mcp/main";
const PKG        = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
const VERSION    = PKG.version;

// ── Config ────────────────────────────────────────────────────────────────────
// Built-in defaults. An optional sonar.config.json overrides any of these keys.
const DEFAULT_CONFIG = {
  ollamaUrl: "http://localhost:11434",
  models: {
    simple: "llama3.1:8b",
    coder:  "qwen2.5-coder:7b",
    vision: "gemma3:12b",
  },
  autoSelectModels: true,       // pick the best locally-available model per role based on GPU VRAM
  numCtx: 4096,                 // context window tokens — lower = less VRAM (KV cache scales with this)
  useMmap: true,                // memory-map model weights instead of malloc — reduces commit charge
  search: {
    // Which engines to query in parallel. Omit / empty = all available.
    // Valid: "brave", "wikipedia", "ddg-instant", "searxng"
    // Note: "duckduckgo" and "duckduckgo-lite" have been removed — DDG blocks HTML scraping.
    // "brave" requires search.braveApiKey — free at https://api.search.brave.com/register
    engines:    ["brave", "wikipedia", "ddg-instant", "searxng"],
    braveApiKey: "",            // get a free key at https://api.search.brave.com/register
    searxngUrl:  "",            // e.g. "http://localhost:8888" — enables the searxng engine
  },
  pricing: {
    // Rough Claude API list prices (USD per million tokens) for the savings estimate.
    inputPerMillion:  3.0,
    outputPerMillion: 15.0,
  },
  historyTurns: 3,              // how many prior exchanges to keep when use_history is on
};

// Known VRAM budgets per model (GiB, rough Q4 estimate including weights + KV at numCtx=4096)
const MODEL_VRAM_GB = {
  "llama3.2:1b":          1,
  "llama3.2:3b":          2,
  "gemma3:4b":            3,
  "llama3.1:8b":          5,
  "llama3.3:8b":          5,
  "mistral:7b":           5,
  "qwen2.5:7b":           5,
  "qwen2.5-coder:7b":     5,
  "deepseek-r1:7b":       5,
  "gemma3:12b":           8,
  "qwen2.5-coder:14b":    9,
  "deepseek-r1:14b":      9,
  "gemma3:27b":          17,
  "qwen2.5-coder:32b":   20,
};

// Best-to-worst model preference per role — first locally available model that fits in VRAM wins
const ROLE_PREFERENCES = {
  simple: ["gemma3:27b", "gemma3:12b", "llama3.1:8b", "llama3.3:8b", "mistral:7b", "qwen2.5:7b", "llama3.2:3b", "llama3.2:1b"],
  coder:  ["qwen2.5-coder:32b", "qwen2.5-coder:14b", "deepseek-r1:14b", "qwen2.5-coder:7b", "deepseek-r1:7b"],
  vision: ["gemma3:27b", "gemma3:12b"],
};

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return DEFAULT_CONFIG;
  try {
    const u = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    return {
      ...DEFAULT_CONFIG, ...u,
      models:           { ...DEFAULT_CONFIG.models,  ...(u.models  || {}) },
      search:           { ...DEFAULT_CONFIG.search,  ...(u.search  || {}),
                          braveApiKey: (u.search?.braveApiKey ?? DEFAULT_CONFIG.search.braveApiKey),
                          searxngUrl:  (u.search?.searxngUrl  ?? DEFAULT_CONFIG.search.searxngUrl) },
      pricing:          { ...DEFAULT_CONFIG.pricing, ...(u.pricing || {}) },
      numCtx:           u.numCtx           ?? DEFAULT_CONFIG.numCtx,
      useMmap:          u.useMmap          ?? DEFAULT_CONFIG.useMmap,
      autoSelectModels: u.autoSelectModels ?? DEFAULT_CONFIG.autoSelectModels,
    };
  } catch (e) {
    console.error(`[sonar] sonar.config.json is invalid (${e.message}) — using defaults`);
    return DEFAULT_CONFIG;
  }
}

const CONFIG          = loadConfig();
const OLLAMA_BASE     = CONFIG.ollamaUrl.replace(/\/$/, "");
const OLLAMA_CHAT_URL = `${OLLAMA_BASE}/api/chat`;

// Returns free VRAM in GiB, with a safety margin applied. Falls back to Infinity.
function getFreeVramGB() {
  try {
    const out = execSync(
      "nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits",
      { timeout: 5000, encoding: "utf8" }
    ).trim();
    const mb = parseInt(out.split("\n")[0], 10);
    if (!isNaN(mb)) return Math.floor((mb / 1024) * 0.85); // 85% of free VRAM as usable budget
  } catch { /* nvidia-smi unavailable or non-NVIDIA GPU */ }
  return Infinity;
}

// Resolves the best model for each role given locally available models and free VRAM.
// Falls back to CONFIG.models entries if auto-select is off or no candidates fit.
async function resolveModels() {
  if (!CONFIG.autoSelectModels) return { ...CONFIG.models };

  let localModels = new Set();
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(5000) });
    localModels = new Set(((await res.json()).models || []).map(m => m.name));
  } catch {
    console.error("[sonar] auto-select: Ollama unreachable at startup — using config models");
    return { ...CONFIG.models };
  }

  const vramGB = getFreeVramGB();
  console.error(`[sonar] auto-select: ${vramGB === Infinity ? "unlimited" : vramGB + " GiB"} VRAM budget, ${localModels.size} local models`);

  const resolved = { ...CONFIG.models };
  for (const [role, prefs] of Object.entries(ROLE_PREFERENCES)) {
    for (const model of prefs) {
      if (!localModels.has(model)) continue;
      const needed = MODEL_VRAM_GB[model] ?? Infinity;
      if (needed <= vramGB) {
        resolved[role] = model;
        console.error(`[sonar] auto-select: ${role} → ${model} (~${needed} GiB)`);
        break;
      }
    }
  }
  return resolved;
}

// Resolved at startup — set below before server.connect()
let MODELS = CONFIG.models;

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Wrap fetch with an AbortController so a hung Ollama or web request can't freeze
// the MCP server (and therefore Claude Desktop) indefinitely.
async function fetchWithTimeout(url, opts = {}, timeoutMs = 120000) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── Token tracking ────────────────────────────────────────────────────────────

const PRO_CTX    = 200_000;  // Claude Pro context window (tokens)
const KEEP_DAYS  = 365;      // rolling window — entries older than this are pruned

function loadStats() {
  try { return JSON.parse(fs.readFileSync(STATS_FILE, "utf8")); }
  catch { return {}; }
}

function pruneStats(stats) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - KEEP_DAYS);
  const pad = (n) => String(n).padStart(2, "0");
  const cutoffStr = `${cutoff.getFullYear()}-${pad(cutoff.getMonth()+1)}-${pad(cutoff.getDate())}`;
  for (const dateStr of Object.keys(stats)) {
    if (dateStr < cutoffStr) delete stats[dateStr];
  }
  return stats;
}

function saveTokens(promptTokens, completionTokens) {
  let stats = loadStats();
  const pad   = (n) => String(n).padStart(2, "0");
  const now   = new Date();
  const today = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
  if (!stats[today]) stats[today] = { promptTokens: 0, completionTokens: 0, requests: 0, claudeTokens: 0, claudeSessions: 0 };
  stats[today].promptTokens     += promptTokens;
  stats[today].completionTokens += completionTokens;
  stats[today].requests         += 1;
  stats = pruneStats(stats);
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
}

function saveClaudeTokens(sessionTokens) {
  // Record Claude context-window tokens for today. Each call is treated as one
  // session's peak usage — we accumulate across sessions in a day.
  let stats = loadStats();
  const pad   = (n) => String(n).padStart(2, "0");
  const now   = new Date();
  const today = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
  if (!stats[today]) stats[today] = { promptTokens: 0, completionTokens: 0, requests: 0, claudeTokens: 0, claudeSessions: 0 };
  stats[today].claudeTokens    = (stats[today].claudeTokens    || 0) + sessionTokens;
  stats[today].claudeSessions  = (stats[today].claudeSessions  || 0) + 1;
  stats = pruneStats(stats);
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
}

function aggregateStats() {
  const stats = loadStats();
  const now   = new Date();
  const pad   = (n) => String(n).padStart(2, "0");
  const ymd   = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const ws    = new Date(now); ws.setDate(now.getDate() - now.getDay());

  // Rolling 30-day window for "month" (avoids month boundary weirdness)
  const m30 = new Date(now); m30.setDate(now.getDate() - 30);

  const cutoffs = {
    Today:       ymd(now),
    "This week": ymd(ws),
    "30 days":   ymd(m30),
    "This year": `${now.getFullYear()}-01-01`,
    "All time":  "2000-01-01",
  };

  const totals = {};
  for (const [label, since] of Object.entries(cutoffs)) {
    totals[label] = { sonarPrompt: 0, sonarCompletion: 0, requests: 0, claudeTokens: 0, claudeSessions: 0 };
    for (const [dateStr, entry] of Object.entries(stats)) {
      if (dateStr >= since) {
        totals[label].sonarPrompt      += entry.promptTokens     || 0;
        totals[label].sonarCompletion  += entry.completionTokens || 0;
        totals[label].requests         += entry.requests         || 0;
        totals[label].claudeTokens     += entry.claudeTokens     || 0;
        totals[label].claudeSessions   += entry.claudeSessions   || 0;
      }
    }
  }

  const estCost = (t) => {
    const inUsd  = (t.sonarPrompt     / 1e6) * CONFIG.pricing.inputPerMillion;
    const outUsd = (t.sonarCompletion / 1e6) * CONFIG.pricing.outputPerMillion;
    return inUsd + outUsd;
  };

  const bar = (tokens, cap) => {
    const filled = Math.min(20, Math.round((tokens / cap) * 20));
    return "[" + "#".repeat(filled).padEnd(20, "-") + "]";
  };

  const pct = (n, d) => d > 0 ? ((n / d) * 100).toFixed(1) + "%" : "n/a";

  // Header
  const lines = [
    `📊 Token Usage: Sonar (local GPU) vs Claude (API)   sonar-mcp v${VERSION}`,
    `   1 Pro session = ${PRO_CTX.toLocaleString()} tokens   |   data kept for ${KEEP_DAYS} days`,
    ``,
    `  ${"Period".padEnd(10)} | ${"Sonar tokens".padEnd(24)} | ${"Claude tokens".padEnd(24)} | Local% | Saved`,
    `  ${"-".repeat(10)}-+-${"-".repeat(24)}-+-${"-".repeat(24)}-+--------+-------`,
  ];

  for (const [label, t] of Object.entries(totals)) {
    const sonarTotal  = t.sonarPrompt + t.sonarCompletion;
    const claudeTotal = t.claudeTokens;
    const combined    = sonarTotal + claudeTotal;
    const localPct    = combined > 0 ? ((sonarTotal / combined) * 100).toFixed(0) + "%" : "n/a";
    const sonarStr    = `${sonarTotal.toLocaleString().padStart(7)} ${bar(sonarTotal, PRO_CTX)} ${pct(sonarTotal, PRO_CTX).padStart(6)}`;
    const claudeStr   = claudeTotal > 0
      ? `${claudeTotal.toLocaleString().padStart(7)} ${bar(claudeTotal, PRO_CTX)} ${pct(claudeTotal, PRO_CTX).padStart(6)}`
      : `${"(not yet logged)".padStart(7 + 1 + 22)}`;
    const cost        = `$${estCost(t).toFixed(2)}`;
    lines.push(`  ${label.padEnd(10)} | ${sonarStr} | ${claudeStr} | ${localPct.padStart(6)} | ${cost}`);
  }

  lines.push(``);
  lines.push(`  Sonar req: ${totals["All time"].requests} total  |  ` +
             `Claude sessions logged: ${totals["All time"].claudeSessions}`);
  lines.push(`  To log this Claude session: call sonar_stats with claude_context_tokens = <your current token count>`);
  lines.push(`  Savings at $${CONFIG.pricing.inputPerMillion}/M in + $${CONFIG.pricing.outputPerMillion}/M out (sonar.config.json)`);

  return lines.join("\n");
}

// ── Web helpers ───────────────────────────────────────────────────────────────

function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractUrl(text) {
  const m = text.match(/https?:\/\/[^\s"'<>]+/);
  return m ? m[0] : null;
}

async function fetchUrl(url) {
  console.error(`[sonar/web] fetching URL: ${url}`);
  const res  = await fetchWithTimeout(url, { headers: { "User-Agent": BROWSER_UA } }, 15000);
  const html = await res.text();
  const text = stripHtml(html);
  return text.length > 6000 ? text.slice(0, 6000) + "\n…[truncated]" : text;
}

// ── Multi-engine web search ───────────────────────────────────────────────────
// Each engine returns an array of { title, snippet, url } (or [] / throws).
// multiSearch runs them all in PARALLEL — one engine being down, rate-limited,
// or returning junk no longer breaks the web route. Results are merged and
// de-duplicated by URL.

// Engine 1 — Brave Search API (requires free API key: https://api.search.brave.com/register)
async function engineBrave(query) {
  const key = (CONFIG.search.braveApiKey || "").trim();
  if (!key) return [];   // silently skip if no key configured
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`;
  const res = await fetchWithTimeout(url, {
    headers: {
      "Accept":               "application/json",
      "Accept-Encoding":      "gzip",
      "X-Subscription-Token": key,
    },
  }, 12000);
  if (!res.ok) throw new Error(`Brave Search returned HTTP ${res.status}`);
  const data = await res.json();
  return (data?.web?.results || []).slice(0, 5).map(r => ({
    title:   r.title   || "",
    snippet: r.description || "",
    url:     r.url     || "",
  }));
}

// Engine 2 — Wikipedia search API (very reliable for factual / definitional queries)
async function engineWikipedia(query) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=3` +
              `&srsearch=${encodeURIComponent(query)}`;
  const res  = await fetchWithTimeout(url, { headers: { "User-Agent": BROWSER_UA } }, 12000);
  const data = await res.json();
  return (data?.query?.search || []).map(r => ({
    title:   r.title,
    snippet: stripHtml(r.snippet || ""),
    url:     `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, "_"))}`,
  }));
}

// Engine 4 — DuckDuckGo Instant Answer API (structured abstracts / definitions)
async function engineDdgInstant(query) {
  const url  = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const res  = await fetchWithTimeout(url, { headers: { "User-Agent": BROWSER_UA } }, 12000);
  const data = await res.json();
  const out  = [];
  if (data.AbstractText) {
    out.push({ title: data.Heading || query, snippet: data.AbstractText, url: data.AbstractURL || "" });
  }
  if (data.Answer)     out.push({ title: "Direct answer", snippet: String(data.Answer), url: "" });
  if (data.Definition) out.push({ title: data.Heading || "Definition", snippet: data.Definition, url: data.DefinitionURL || "" });
  for (const t of (data.RelatedTopics || []).slice(0, 3)) {
    if (t?.Text) out.push({ title: "Related", snippet: t.Text, url: t.FirstURL || "" });
  }
  return out;
}

// Engine 5 — SearXNG (self-hosted meta-search) — only if a URL is configured
async function engineSearxng(query) {
  const base = (CONFIG.search.searxngUrl || "").replace(/\/$/, "");
  if (!base) return [];
  const url  = `${base}/search?q=${encodeURIComponent(query)}&format=json`;
  const res  = await fetchWithTimeout(url, { headers: { "User-Agent": BROWSER_UA } }, 12000);
  const data = await res.json();
  return (data.results || []).slice(0, 5).map(r => ({
    title:   r.title || "",
    snippet: r.content || "",
    url:     r.url || "",
  }));
}

const ALL_ENGINES = {
  "brave":       engineBrave,
  "wikipedia":   engineWikipedia,
  "ddg-instant": engineDdgInstant,
  "searxng":     engineSearxng,
};

function normalizeUrl(u) {
  return (u || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
}

// Run every configured engine in parallel, aggregate + dedupe.
// Returns { text, used, total }.
async function multiSearch(query) {
  // Which engines to run: config.search.engines, or all (searxng only if URL set)
  let engineNames = Array.isArray(CONFIG.search.engines) && CONFIG.search.engines.length
    ? CONFIG.search.engines.filter(n => ALL_ENGINES[n])
    : ["brave", "wikipedia", "ddg-instant", "searxng"];
  if (!CONFIG.search.searxngUrl)  engineNames = engineNames.filter(n => n !== "searxng");
  if (!CONFIG.search.braveApiKey) engineNames = engineNames.filter(n => n !== "brave");

  console.error(`[sonar/web] multi-engine search (${engineNames.join(", ")}): ${query}`);
  const settled = await Promise.allSettled(engineNames.map(n => ALL_ENGINES[n](query)));

  const seen     = new Set();
  const sections = [];
  const urls     = [];
  let used = 0;

  settled.forEach((r, i) => {
    const name = engineNames[i];
    if (r.status !== "fulfilled" || !Array.isArray(r.value) || r.value.length === 0) {
      console.error(`[sonar/web] ${name}: ${r.status === "rejected" ? r.reason?.message : "no results"}`);
      return;
    }
    const lines = [];
    for (const item of r.value) {
      const key = normalizeUrl(item.url) || item.title?.toLowerCase();
      if (key && seen.has(key)) continue;       // dedupe across engines
      if (key) seen.add(key);
      if (item.url) urls.push(item.url);
      lines.push(`- ${item.title}${item.url ? ` <${item.url}>` : ""}\n  ${item.snippet || ""}`.trim());
    }
    if (lines.length) {
      used++;
      sections.push(`[${name}]\n${lines.join("\n")}`);
    }
  });

  if (sections.length === 0) {
    return { text: "No search results found from any engine.", used: 0, total: engineNames.length };
  }

  let text = sections.join("\n\n");

  // If the aggregated snippets are thin, fetch the first real article for depth.
  if (text.length < 600) {
    const articleUrl = urls.find(h => {
      try {
        const u = new URL(h);
        return u.pathname.length > 8 && u.pathname.split("/").filter(Boolean).length >= 1;
      } catch { return false; }
    });
    if (articleUrl) {
      try {
        const article = await fetchUrl(articleUrl);
        text += `\n\n--- Full article (${articleUrl}) ---\n${article}`;
      } catch (e) {
        console.error(`[sonar/web] article fetch failed: ${e.message}`);
      }
    }
  }

  return { text, used, total: engineNames.length };
}

// ── Image loading (for the vision route) ──────────────────────────────────────

// Accepts a local file path, an http(s) URL, or a raw base64 string.
// Returns a base64 string (no data: prefix) as Ollama expects.
async function loadImageBase64(imageRef) {
  if (/^https?:\/\//i.test(imageRef)) {
    const res = await fetchWithTimeout(imageRef, {}, 15000);
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.toString("base64");
  }
  if (fs.existsSync(imageRef)) {
    return fs.readFileSync(imageRef).toString("base64");
  }
  // Assume it's already base64; strip any data: URI prefix
  return imageRef.replace(/^data:image\/[a-z]+;base64,/i, "");
}

// ── Conversation memory (in-process, opt-in) ──────────────────────────────────

let history = [];   // [{ role, content }, ...]

function pushHistory(userText, assistantText) {
  history.push({ role: "user", content: userText });
  history.push({ role: "assistant", content: assistantText });
  const max = CONFIG.historyTurns * 2;
  if (history.length > max) history = history.slice(history.length - max);
}

// ── Ollama call ───────────────────────────────────────────────────────────────

// messages: array of {role, content, images?}
async function askOllama(model, messages) {
  const res = await fetchWithTimeout(OLLAMA_CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, stream: false, keep_alive: 0, options: { num_ctx: CONFIG.numCtx, use_mmap: CONFIG.useMmap } }),
  });
  const data = await res.json();
  // Ollama returns { error: "..." } on failure — surface it so friendlyError can map it
  if (data.error) throw new Error(data.error);
  if (!data.message) throw new Error("Ollama returned no message");
  return {
    content:          data.message.content,
    promptTokens:     data.prompt_eval_count ?? 0,
    completionTokens: data.eval_count ?? 0,
  };
}

// Convenience: single-prompt call
async function askOllamaSimple(model, prompt) {
  return askOllama(model, [{ role: "user", content: prompt }]);
}

// ── Router ────────────────────────────────────────────────────────────────────

const WEB_KEYWORDS = /\b(today|tonight|right now|this week|this month|latest|current|news|headline|weather|temperature|forecast|price|cost|stock|score|standings|who won|what happened|trending|breaking|recent|live|2025|2026|is \w+ open|hours of)\b/i;

async function classifyPrompt(prompt) {
  if (extractUrl(prompt) || WEB_KEYWORDS.test(prompt)) {
    console.error(`[sonar] fast-classified as: web (keyword/URL match)`);
    return "web";
  }

  const routerPrompt =
    `You are a routing classifier. Output ONLY one of three words: "simple", "coder", or "web".\n\n` +
    `Rules:\n` +
    `- "web"    → needs live/current info: news, prices, weather, recent events, sports scores, ` +
    `             stock data, or contains a URL to look up.\n` +
    `- "coder"  → write code, debug code, refactor code, create a script, implement an algorithm, ` +
    `             fix a bug, or produce a runnable program.\n` +
    `- "simple" → everything else: descriptions, explanations, summaries, translations, lists, ` +
    `             definitions, how-things-work, drafting text, general knowledge.\n\n` +
    `Examples:\n` +
    `"describe how a tube amp works"          => simple\n` +
    `"write a Python function to read a CSV"  => coder\n` +
    `"implement quicksort in JavaScript"      => coder\n` +
    `"summarize this paragraph"               => simple\n` +
    `"debug this React component"             => coder\n\n` +
    `Prompt to classify: ${prompt}\n\nAnswer:`;

  const { content, promptTokens, completionTokens } = await askOllamaSimple(MODELS.simple, routerPrompt);
  saveTokens(promptTokens, completionTokens);
  const trimmed = content.trim().toLowerCase();
  let chosen = "simple";
  if (trimmed.startsWith("coder")) chosen = "coder";
  else if (trimmed.startsWith("web")) chosen = "web";
  console.error(`[sonar] classified as: ${chosen} (raw: "${trimmed}")`);
  return chosen;
}

// ── Health check ──────────────────────────────────────────────────────────────

async function healthCheck() {
  const lines = [`🩺 Sonar Health   sonar-mcp v${VERSION}`, ``];

  let reachable = false;
  let loaded = [];
  let available = [];

  try {
    const ps = await fetchWithTimeout(`${OLLAMA_BASE}/api/ps`, {}, 5000);
    loaded = (await ps.json()).models || [];
    reachable = true;
  } catch { /* not reachable */ }

  if (reachable) {
    try {
      const tags = await fetchWithTimeout(`${OLLAMA_BASE}/api/tags`, {}, 5000);
      available = ((await tags.json()).models || []).map(m => m.name);
    } catch { /* ignore */ }
  }

  lines.push(`  Ollama   : ${reachable ? "✅ reachable" : "❌ NOT reachable"} at ${OLLAMA_BASE}`);

  if (!reachable) {
    lines.push(``);
    lines.push(`  Start the Ollama app (Windows tray icon / macOS menu bar) and retry.`);
    return lines.join("\n");
  }

  lines.push(`  Loaded   : ${loaded.length ? loaded.map(m => m.name).join(", ") : "(none currently in VRAM)"}`);
  lines.push(``);
  lines.push(`  Configured models:`);
  for (const [role, model] of Object.entries(MODELS)) {
    const present = available.includes(model);
    const tag = present ? "✅ available" : `⚠️  not pulled — run: ollama pull ${model}`;
    lines.push(`    ${role.padEnd(7)}: ${model.padEnd(20)} ${tag}`);
  }
  lines.push(``);
  let engs = Array.isArray(CONFIG.search.engines) && CONFIG.search.engines.length
    ? [...CONFIG.search.engines]
    : ["duckduckgo", "duckduckgo-lite", "wikipedia", "ddg-instant", "searxng"];
  if (!CONFIG.search.searxngUrl) engs = engs.filter(n => n !== "searxng");
  const braveStatus = CONFIG.search.braveApiKey ? "✅ key set" : "⚠️  no key — get one free at https://api.search.brave.com/register";
  lines.push(`  Search   : ${engs.length} engine(s) — ${engs.join(", ")}`);
  lines.push(`  Brave    : ${braveStatus}`);
  if (CONFIG.search.searxngUrl) lines.push(`  SearXNG  : ${CONFIG.search.searxngUrl}`);
  lines.push(`  History  : keeps last ${CONFIG.historyTurns} exchange(s) when use_history is on`);
  return lines.join("\n");
}

// ── Update check ─────────────────────────────────────────────────────────────

// true if semver a is strictly greater than b  ("1.3.0" > "1.2.1")
function semverGt(a, b) {
  const parse = v => v.replace(/^v/, "").split(".").map(Number);
  const [aMaj, aMin, aPat] = parse(a);
  const [bMaj, bMin, bPat] = parse(b);
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  return aPat > bPat;
}

// Extract CHANGELOG.md sections for versions newer than `from` up to `to` (inclusive).
function extractChangelogSections(text, from, to) {
  const sections = [];
  let buf = [];
  let capturing = false;

  for (const line of text.split("\n")) {
    const m = line.match(/^## \[(\d+\.\d+\.\d+)\]/);
    if (m) {
      if (capturing && buf.length) { sections.push(buf.join("\n").trimEnd()); buf = []; }
      const v = m[1];
      capturing = semverGt(v, from) && !semverGt(v, to);
      if (capturing) buf.push(line);
    } else if (capturing) {
      buf.push(line);
    }
  }
  if (capturing && buf.length) sections.push(buf.join("\n").trimEnd());
  return sections.join("\n\n");
}

async function checkForUpdate() {
  const lines = [`🔍 Sonar Update Check   sonar-mcp v${VERSION}`, ``];

  let remotePkg;
  try {
    const res = await fetchWithTimeout(`${GITHUB_RAW}/package.json`, {}, 10000);
    if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status}`);
    remotePkg = await res.json();
  } catch (e) {
    lines.push(`  ⚠️  Could not reach GitHub: ${e.message}`);
    return lines.join("\n");
  }

  const latest = remotePkg.version;

  if (!semverGt(latest, VERSION)) {
    lines.push(`  ✅ Already on the latest version (v${VERSION})`);
    return lines.join("\n");
  }

  lines.push(`  🆕 v${latest} is available  (you have v${VERSION})`, ``);

  // Fetch changelog and extract new sections
  try {
    const clRes = await fetchWithTimeout(`${GITHUB_RAW}/CHANGELOG.md`, {}, 10000);
    if (clRes.ok) {
      const sections = extractChangelogSections(await clRes.text(), VERSION, latest);
      if (sections) {
        lines.push(`  What's new:`, ``);
        for (const l of sections.split("\n")) lines.push(`  ${l}`);
        lines.push(``);
      }
    }
  } catch { /* changelog unavailable — skip */ }

  lines.push(`  Run **sonar_update** to install v${latest} now.`);
  lines.push(`  A full Claude Desktop restart will be needed after updating.`);
  return lines.join("\n");
}

async function runUpdate() {
  const result = spawnSync(
    process.execPath,
    [INSTALL_JS, "--update", "--yes"],
    { cwd: __dirname, encoding: "utf8", timeout: 120000, shell: false }
  );
  const out = ((result.stdout || "") + (result.stderr || "")).trim();
  if (result.status !== 0) throw new Error(`Update failed:\n${out}`);

  // Extract the new version from the output for a clean confirmation message
  const vMatch = out.match(/Updated to v([\d.]+)/i);
  const newVer  = vMatch ? vMatch[1] : "unknown";
  return [
    `✅ Updated to v${newVer}`,
    ``,
    `Fully restart Claude Desktop (quit from system tray, then reopen) to load the new version.`,
  ].join("\n");
}

// ── MCP server ────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "ollama-local", version: VERSION },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "sonar",
      description:
        "Send any task or question to the local Ollama models. Sonar auto-routes to the best model " +
        "and fetches live web data when needed: " +
        `• ${MODELS.simple} for general tasks (summarizing, describing, translating, drafting, explaining) ` +
        `• ${MODELS.coder} for coding tasks (writing code, debugging, refactoring, algorithms) ` +
        `• ${MODELS.vision} for image questions (pass image_path) ` +
        "• web search for live/current information (news, weather, prices, URLs). " +
        "Free and fast — runs locally.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "The task, question, or URL to process.",
          },
          model: {
            type: "string",
            enum: ["auto", "simple", "coder", "vision", "web"],
            description: "Optional. Force a route instead of auto-classifying. Default: auto.",
          },
          image_path: {
            type: "string",
            description: "Optional. Local file path or URL of an image — routes to the vision model.",
          },
          use_history: {
            type: "boolean",
            description: "Optional. Include the last few sonar exchanges as context for follow-ups. Default: false.",
          },
        },
        required: ["prompt"],
      },
    },
    {
      name: "sonar_stats",
      description:
        "Show a side-by-side comparison of Sonar (local GPU) tokens vs Claude API context tokens, " +
        "broken down by today, this week, 30 days, this year, and all time. " +
        "Pass claude_context_tokens to log the current Claude session size so the comparison stays accurate.",
      inputSchema: {
        type: "object",
        properties: {
          claude_context_tokens: {
            type: "number",
            description: "Approximate tokens used in the current Claude context window this session. " +
                         "Pass this each time you call sonar_stats so Claude usage is tracked alongside Sonar usage.",
          },
        },
      },
    },
    {
      name: "sonar_health",
      description:
        "Check Sonar's status: whether Ollama is reachable, which models are loaded in VRAM, " +
        "and whether all configured models are pulled and ready.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "sonar_update_check",
      description:
        "Check GitHub for a newer version of Sonar. If one is available, shows the version number, " +
        "what changed (from the changelog), and prompts whether to update.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "sonar_update",
      description:
        "Install the latest version of Sonar from GitHub (git pull + npm install). " +
        "Run sonar_update_check first to see what will change. " +
        "A full Claude Desktop restart is required after updating.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

function friendlyError(err) {
  const msg = err?.message ?? String(err);
  if (err?.name === "AbortError" || /timeout|aborted/i.test(msg)) {
    return "⚠️ Sonar timed out. The model may still be loading into VRAM on first call — try again in a few seconds.";
  }
  if (/ECONNREFUSED|fetch failed|ENOTFOUND/i.test(msg)) {
    return `⚠️ Sonar can't reach Ollama at ${OLLAMA_BASE}. Start the Ollama app (Windows tray icon / macOS menu bar) and retry.`;
  }
  if (/model.*not found|pull.*model|not found, try pulling/i.test(msg)) {
    return "⚠️ A required Ollama model isn't installed. Run sonar_health to see which, then `ollama pull <model>`.";
  }
  if (/out of memory|cudaMalloc|memory layout cannot be allocated/i.test(msg)) {
    return "⚠️ GPU couldn't allocate VRAM for the model. This often happens if a previous model " +
           "is still unloading — wait a couple of seconds and retry. If it persists, close other " +
           "GPU-using apps (games, video editors).";
  }
  if (/CUDA error|runner process has terminated|GGML_ASSERT/i.test(msg)) {
    return "⚠️ The Ollama model runner crashed (GPU error). This is usually transient — just retry. " +
           "If it keeps happening, restart Ollama or update your GPU driver.";
  }
  return `⚠️ Sonar error: ${msg}`;
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "sonar_stats") {
      if (args?.claude_context_tokens > 0) saveClaudeTokens(Math.round(args.claude_context_tokens));
      return { content: [{ type: "text", text: aggregateStats() }] };
    }
    if (name === "sonar_health")       return { content: [{ type: "text", text: await healthCheck() }] };
    if (name === "sonar_update_check") return { content: [{ type: "text", text: await checkForUpdate() }] };
    if (name === "sonar_update")       return { content: [{ type: "text", text: await runUpdate() }] };

    if (name === "sonar") {
      const prompt      = args.prompt;
      const override    = args.model || "auto";
      const imagePath   = args.image_path;
      const useHistory  = args.use_history === true;

      // ── Decide the route ────────────────────────────────────────────────
      let route;
      if (imagePath)                 route = "vision";
      else if (override !== "auto")  route = override;
      else {
        console.error(`[sonar] classifying prompt...`);
        route = await classifyPrompt(prompt);
      }
      console.error(`[sonar] route = ${route}${imagePath ? " (image)" : ""}${useHistory ? " (history)" : ""}`);

      // ── Web route ───────────────────────────────────────────────────────
      if (route === "web") {
        const explicitUrl = extractUrl(prompt);
        let webContext, source;
        try {
          if (explicitUrl) {
            webContext = await fetchUrl(explicitUrl);
            source     = `fetched: ${explicitUrl}`;
          } else {
            const r    = await multiSearch(prompt);
            webContext = r.text;
            source     = `web search (${r.used}/${r.total} engines)`;
          }
        } catch (e) {
          console.error(`[sonar/web] fetch failed (${e.message}) — model-only fallback`);
          webContext = `(web fetch failed: ${e.message})`;
          source     = `web fetch failed — answering from training data only`;
        }

        const augmented =
          `Use the following live web content to answer the question.\n\n` +
          `--- WEB CONTENT (${source}) ---\n${webContext}\n--- END ---\n\n` +
          `Question: ${prompt}`;

        const { content, promptTokens, completionTokens } =
          await askOllamaSimple(MODELS.simple, augmented);
        saveTokens(promptTokens, completionTokens);
        if (useHistory) pushHistory(prompt, content);
        return { content: [{ type: "text", text: `[routed to ${MODELS.simple} + ${source}]\n\n${content}` }] };
      }

      // ── Vision route ────────────────────────────────────────────────────
      if (route === "vision") {
        if (!imagePath) throw new Error("vision route requires image_path");
        const b64 = await loadImageBase64(imagePath);
        const messages = [{ role: "user", content: prompt, images: [b64] }];
        const { content, promptTokens, completionTokens } =
          await askOllama(MODELS.vision, messages);
        saveTokens(promptTokens, completionTokens);
        if (useHistory) pushHistory(prompt, content);
        return { content: [{ type: "text", text: `[routed to ${MODELS.vision} (vision)]\n\n${content}` }] };
      }

      // ── Simple / Coder route ────────────────────────────────────────────
      const model = MODELS[route];
      if (!model) throw new Error(`Unknown route "${route}"`);

      const messages = [];
      if (useHistory) messages.push(...history);
      messages.push({ role: "user", content: prompt });

      const { content, promptTokens, completionTokens } = await askOllama(model, messages);
      saveTokens(promptTokens, completionTokens);
      if (useHistory) pushHistory(prompt, content);
      console.error(`[sonar] tokens — prompt: ${promptTokens}, completion: ${completionTokens}`);
      return { content: [{ type: "text", text: `[routed to ${model}]\n\n${content}` }] };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (err) {
    console.error(`[sonar] error: ${err?.stack ?? err}`);
    return { content: [{ type: "text", text: friendlyError(err) }], isError: true };
  }
});

MODELS = await resolveModels();

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[sonar] Ollama MCP server running (v${VERSION}) — models: simple=${MODELS.simple} coder=${MODELS.coder} vision=${MODELS.vision}`);

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

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const STATS_FILE = path.join(__dirname, "token-stats.json");

const OLLAMA_CHAT_URL = "http://localhost:11434/api/chat";
const MODELS = {
  simple: "llama3.1:8b",
  coder:  "qwen2.5-coder:7b",
};

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ── Token tracking ────────────────────────────────────────────────────────────

function loadStats() {
  try { return JSON.parse(fs.readFileSync(STATS_FILE, "utf8")); }
  catch { return {}; }
}

function saveTokens(promptTokens, completionTokens) {
  const stats = loadStats();
  const pad   = (n) => String(n).padStart(2, "0");
  const now   = new Date();
  const today = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
  if (!stats[today]) stats[today] = { promptTokens: 0, completionTokens: 0, requests: 0 };
  stats[today].promptTokens    += promptTokens;
  stats[today].completionTokens += completionTokens;
  stats[today].requests        += 1;
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
}

function aggregateStats() {
  const stats = loadStats();
  const now   = new Date();
  const pad   = (n) => String(n).padStart(2, "0");
  const ymd   = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const ws    = new Date(now); ws.setDate(now.getDate() - now.getDay());

  const cutoffs = {
    today: ymd(now),
    week:  ymd(ws),
    month: `${now.getFullYear()}-${pad(now.getMonth()+1)}-01`,
    year:  `${now.getFullYear()}-01-01`,
  };

  const totals = {};
  for (const [label, since] of Object.entries(cutoffs)) {
    totals[label] = { promptTokens: 0, completionTokens: 0, requests: 0 };
    for (const [dateStr, entry] of Object.entries(stats)) {
      if (dateStr >= since) {
        totals[label].promptTokens    += entry.promptTokens;
        totals[label].completionTokens += entry.completionTokens;
        totals[label].requests        += entry.requests;
      }
    }
  }

  const fmt = (t) => {
    const total = t.promptTokens + t.completionTokens;
    return `${total.toLocaleString()} tokens (${t.promptTokens.toLocaleString()} prompt + ${t.completionTokens.toLocaleString()} completion) across ${t.requests} request${t.requests !== 1 ? "s" : ""}`;
  };

  return [
    `📊 Sonar Token Usage (processed locally)`,
    ``,
    `  Today   : ${fmt(totals.today)}`,
    `  Week    : ${fmt(totals.week)}`,
    `  Month   : ${fmt(totals.month)}`,
    `  Year    : ${fmt(totals.year)}`,
  ].join("\n");
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
  const res  = await fetch(url, { headers: { "User-Agent": BROWSER_UA } });
  const html = await res.text();
  const text = stripHtml(html);
  // Trim to ~6 000 chars so the model context doesn't explode
  return text.length > 6000 ? text.slice(0, 6000) + "\n…[truncated]" : text;
}

async function webSearch(query) {
  console.error(`[sonar/web] searching DuckDuckGo: ${query}`);
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res  = await fetch(url, { headers: { "User-Agent": BROWSER_UA } });
  const html = await res.text();

  // Pull result links + snippets from DDG HTML response
  const snippetRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const titleRe   = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const titleMatches = [...html.matchAll(titleRe)].slice(0, 5);
  const snippets     = [...html.matchAll(snippetRe)].slice(0, 5).map(m => stripHtml(m[1]));

  if (titleMatches.length === 0) return "No search results found.";

  const titles = titleMatches.map(m => stripHtml(m[2]));
  const hrefs  = titleMatches.map(m => m[1]);

  // Build snippet summary
  const summary = titles
    .map((t, i) => `[${i + 1}] ${t}\n${snippets[i] ?? ""}`)
    .join("\n\n");

  // If snippets are thin, fetch the first URL that looks like an actual article
  // (has a path with at least one slug segment, not just a homepage)
  const totalSnippetLen = snippets.join("").length;
  if (totalSnippetLen < 300) {
    const articleUrl = hrefs.find(h => {
      try {
        const u = new URL(h);
        // Must have a meaningful path (more than just "/") and no query-only paths
        return u.pathname.length > 8 && u.pathname.split("/").filter(Boolean).length >= 1;
      } catch { return false; }
    });
    if (articleUrl) {
      try {
        console.error(`[sonar/web] snippets thin — fetching article: ${articleUrl}`);
        const article = await fetchUrl(articleUrl);
        return `Search results:\n${summary}\n\n--- Article content (${articleUrl}) ---\n${article}`;
      } catch (e) {
        console.error(`[sonar/web] article fetch failed: ${e.message}`);
      }
    }
  }

  return summary;
}

// ── Ollama calls ──────────────────────────────────────────────────────────────

async function askOllama(model, prompt) {
  const res  = await fetch(OLLAMA_CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
      keep_alive: 0,
    }),
  });
  const data = await res.json();
  return {
    content:          data.message.content,
    promptTokens:     data.prompt_eval_count ?? 0,
    completionTokens: data.eval_count ?? 0,
  };
}

// ── Three-way router ──────────────────────────────────────────────────────────

// Fast keyword pre-check — catches obvious web queries without burning LLM tokens
const WEB_KEYWORDS = /\b(today|tonight|right now|right now|this week|this month|latest|current|news|headline|weather|temperature|forecast|price|cost|stock|score|standings|who won|what happened|trending|breaking|recent|live|2025|2026|is \w+ open|hours of)\b/i;

async function classifyPrompt(prompt) {
  // Fast path: URL in prompt or keyword match → always web
  if (extractUrl(prompt) || WEB_KEYWORDS.test(prompt)) {
    console.error(`[sonar] fast-classified as: web (keyword/URL match)`);
    return "web";
  }

  // LLM path for ambiguous prompts
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

  const { content, promptTokens, completionTokens } = await askOllama(MODELS.simple, routerPrompt);
  saveTokens(promptTokens, completionTokens);
  const trimmed = content.trim().toLowerCase();
  let chosen = "simple";
  if (trimmed.startsWith("coder")) chosen = "coder";
  else if (trimmed.startsWith("web")) chosen = "web";
  console.error(`[sonar] classified as: ${chosen} (raw: "${trimmed}")`);
  return chosen;
}

// ── MCP server ────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "ollama-local", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "sonar",
      description:
        "Send any task or question to the local Ollama models running on the RTX 3090 Ti. " +
        "Sonar automatically routes the prompt to the best local model and fetches live web data when needed: " +
        "• llama3.1:8b for general tasks (summarizing, describing, translating, classifying, drafting, explaining) " +
        "• qwen2.5-coder:7b for coding tasks (writing code, debugging, refactoring, algorithms, scripts) " +
        "• DuckDuckGo search + llama3.1:8b for live/current information (news, weather, prices, URLs) " +
        "Use for any task — it is free and fast.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "The task, question, or URL to process." },
        },
        required: ["prompt"],
      },
    },
    {
      name: "sonar_stats",
      description:
        "Show how many tokens have been processed locally by Sonar, " +
        "broken down by today, this week, this month, and this year.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "sonar_stats") {
    return { content: [{ type: "text", text: aggregateStats() }] };
  }

  if (name === "sonar") {
    const prompt = args.prompt;

    console.error(`[sonar] classifying prompt...`);
    const route = await classifyPrompt(prompt);

    // ── Web route ──────────────────────────────────────────────────────────
    if (route === "web") {
      const explicitUrl = extractUrl(prompt);
      let webContext;
      let source;

      if (explicitUrl) {
        webContext = await fetchUrl(explicitUrl);
        source     = `fetched: ${explicitUrl}`;
      } else {
        webContext = await webSearch(prompt);
        source     = `DuckDuckGo search`;
      }

      const augmented =
        `Use the following live web content to answer the question.\n\n` +
        `--- WEB CONTENT (${source}) ---\n${webContext}\n--- END ---\n\n` +
        `Question: ${prompt}`;

      console.error(`[sonar] routing to ${MODELS.simple} with web context`);
      const { content, promptTokens, completionTokens } = await askOllama(MODELS.simple, augmented);
      saveTokens(promptTokens, completionTokens);
      console.error(`[sonar] tokens — prompt: ${promptTokens}, completion: ${completionTokens}`);

      return {
        content: [{ type: "text", text: `[routed to ${MODELS.simple} + ${source}]\n\n${content}` }],
      };
    }

    // ── Simple / Coder route ───────────────────────────────────────────────
    const model = MODELS[route];
    console.error(`[sonar] routing to ${model}`);
    const { content, promptTokens, completionTokens } = await askOllama(model, prompt);
    saveTokens(promptTokens, completionTokens);
    console.error(`[sonar] tokens — prompt: ${promptTokens}, completion: ${completionTokens}`);

    return {
      content: [{ type: "text", text: `[routed to ${model}]\n\n${content}` }],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[sonar] Ollama MCP server running");

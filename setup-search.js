#!/usr/bin/env node
/**
 * Sonar Search Setup Wizard
 * ─────────────────────────
 * Interactive setup for Sonar's web search engines.
 * Keys are stored in sonar.secrets.json (gitignored, local-only).
 * Run with: node setup-search.js
 */

import fs       from "fs";
import path     from "path";
import readline from "readline";
import { execSync, spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname     = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE   = path.join(__dirname, "sonar.config.json");
const SECRETS_FILE  = path.join(__dirname, "sonar.secrets.json");

// ── Colours ───────────────────────────────────────────────────────────────────
const C = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  dim:    "\x1b[2m",
  green:  "\x1b[32m",
  yellow: "\x1b[33m",
  red:    "\x1b[31m",
  cyan:   "\x1b[36m",
  white:  "\x1b[37m",
};
const ok   = (s) => `${C.green}✔${C.reset} ${s}`;
const warn = (s) => `${C.yellow}⚠${C.reset}  ${s}`;
const err  = (s) => `${C.red}✖${C.reset} ${s}`;
const info = (s) => `${C.cyan}ℹ${C.reset}  ${s}`;
const bold = (s) => `${C.bold}${s}${C.reset}`;
const dim  = (s) => `${C.dim}${s}${C.reset}`;

// ── File helpers ──────────────────────────────────────────────────────────────
function loadJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}

function saveJson(file, data) {
  // Atomic write so a crash mid-write can't leave a half-written secrets file.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);

  // Restrict permissions to the current user (Windows). Use spawnSync with an arg
  // array — NOT a shell string — so the username/path can't break out of the command.
  // Verify it actually applied; warn loudly if not (a silent failure could leave a
  // secrets file readable by other accounts on a shared machine).
  if (process.platform === "win32") {
    const user = process.env.USERNAME || process.env.USER;
    let restricted = false;
    if (user) {
      try {
        const r = spawnSync("icacls", [
          file, "/inheritance:r", "/grant:r", `${user}:(R,W)`,
        ], { timeout: 8000, encoding: "utf8" });
        restricted = r.status === 0;
      } catch { /* fall through to warning */ }
    }
    if (!restricted) {
      console.warn(`⚠️  Could not restrict permissions on ${file}. ` +
        `If this is a shared machine, secure it manually so only you can read it.`);
    }
  }
}

// ── Input helpers ─────────────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question) {
  return new Promise(resolve => rl.question(question, resolve));
}

async function askSecret(prompt) {
  return new Promise(resolve => {
    process.stdout.write(prompt);
    let value = "";
    const onData = (char) => {
      switch (char + "") {
        case "\n": case "\r": case "":
          process.stdin.removeListener("data", onData);
          process.stdin.setRawMode(false);
          process.stdout.write("\n");
          resolve(value);
          break;
        case "":
          process.stdout.write("\n");
          process.exit(0);
          break;
        case "": case "\b":
          if (value.length) { value = value.slice(0, -1); process.stdout.write("\b \b"); }
          break;
        default:
          value += char;
          process.stdout.write("*");
      }
    };
    try { process.stdin.setRawMode(true); } catch { /* not a TTY — fall back */ }
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
  });
}

async function confirm(question, defaultYes = true) {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  const ans = (await ask(`${question} ${hint}: `)).trim().toLowerCase();
  if (!ans) return defaultYes;
  return ans === "y" || ans === "yes";
}

async function menu(prompt, options) {
  console.log(`\n${prompt}`);
  options.forEach((o, i) => console.log(`  ${C.cyan}${i + 1}${C.reset}. ${o.label}`));
  while (true) {
    const ans = (await ask(`\nChoice (1-${options.length}): `)).trim();
    const idx = parseInt(ans, 10) - 1;
    if (idx >= 0 && idx < options.length) return options[idx].value;
    console.log(warn(`Please enter a number between 1 and ${options.length}`));
  }
}

// ── Docker helpers ────────────────────────────────────────────────────────────
function dockerAvailable() {
  try {
    const r = spawnSync("docker", ["info"], { encoding: "utf8", timeout: 5000, shell: true });
    return r.status === 0;
  } catch { return false; }
}

function dockerInstalled() {
  try {
    spawnSync("docker", ["--version"], { encoding: "utf8", timeout: 3000, shell: true });
    return true;
  } catch { return false; }
}

function searxngRunning(url) {
  try {
    // Pass the URL as a discrete argv element with shell:false (the default) so
    // shell metacharacters in a config-supplied URL can't break out into execution.
    const r = spawnSync("curl", ["-sf", "--max-time", "3", `${url}/healthz`],
      { encoding: "utf8" });
    return r.status === 0;
  } catch { return false; }
}

function searxngContainerExists() {
  try {
    const r = spawnSync("docker", ["ps", "-a", "--filter", "name=searxng", "--format", "{{.Names}}"],
      { encoding: "utf8", shell: true, timeout: 5000 });
    return (r.stdout || "").includes("searxng");
  } catch { return false; }
}

// ── Engine catalogue ──────────────────────────────────────────────────────────
const ENGINES = {
  brave: {
    name:        "Brave Search",
    type:        "key",
    secretKey:   "braveApiKey",
    configKey:   "brave",
    freeTier:    "2,000 queries/month free",
    registerUrl: "https://api.search.brave.com/register",
    description: "Real-time web results. Best all-round engine. Free tier available.",
  },
  tavily: {
    name:        "Tavily AI Search",
    type:        "key",
    secretKey:   "tavilyApiKey",
    configKey:   "tavily",
    freeTier:    "1,000 queries/month free",
    registerUrl: "https://app.tavily.com",
    description: "AI-optimised search built for LLMs. Excellent relevance. Free tier available.",
  },
  serpapi: {
    name:        "SerpAPI",
    type:        "key",
    secretKey:   "serpapiApiKey",
    configKey:   "serpapi",
    freeTier:    "100 queries/month free",
    registerUrl: "https://serpapi.com/users/sign_up",
    description: "Scrapes Google/Bing results. Highly reliable. Paid plans from $50/mo.",
  },
  searxng: {
    name:        "SearXNG (local Docker)",
    type:        "docker",
    configKey:   "searxng",
    description: "Self-hosted meta-search — queries multiple engines simultaneously. No key, no usage limits.",
  },
  wikipedia: {
    name:        "Wikipedia",
    type:        "free",
    configKey:   "wikipedia",
    description: "Always available. Best for factual / encyclopaedic queries.",
  },
  "ddg-instant": {
    name:        "DuckDuckGo Instant Answers",
    type:        "free",
    configKey:   "ddg-instant",
    description: "Structured abstracts and definitions. No key needed.",
  },
};

const OPT_OUT_CONSEQUENCES = `
${bold("If you skip all optional engines, Sonar will only have:")}

  • Wikipedia — good for facts and definitions, useless for current events,
    prices, news, YouTube video reliability, real-time data.
  • DuckDuckGo Instant Answers — structured snippets only; returns nothing
    for most conversational queries.

${warn("Consequences of minimal search:")}
  - Web-route queries return empty or near-empty results for most topics
  - Sonar cannot verify live claims (prices, news, recent research)
  - YouTube / URL reliability checks will fail
  - Sonar falls back to its local LLM's training data (which has a cutoff date)

${info("Recommendation: add at least one of Brave, Tavily, or SearXNG.")}
`;

// ── Main wizard ───────────────────────────────────────────────────────────────
async function main() {
  console.clear();
  console.log(`\n${bold("━━━  Sonar Search Engine Setup  ━━━")}\n`);
  console.log("This wizard configures which search engines Sonar uses for live web results.");
  console.log("API keys are stored in " + bold("sonar.secrets.json") + " (local-only, gitignored, user-readable only).\n");

  const config  = loadJson(CONFIG_FILE, {});
  const secrets = loadJson(SECRETS_FILE, {});
  const currentEngines = config?.search?.engines || [];

  // ── Show current status ───────────────────────────────────────────────────
  console.log(bold("Current search configuration:"));
  for (const [id, eng] of Object.entries(ENGINES)) {
    const active = currentEngines.includes(id);
    let status = active ? ok("enabled") : dim("disabled");
    if (eng.type === "key") {
      const hasKey = !!(secrets[eng.secretKey] || config?.search?.[eng.secretKey]);
      status += hasKey ? `  ${dim("(key set)")}` : `  ${warn("no key")}`;
    }
    if (eng.type === "docker" && active) {
      status += searxngRunning(config?.search?.searxngUrl || "http://localhost:8888")
        ? `  ${ok("running")}`
        : `  ${err("not reachable")}`;
    }
    console.log(`  ${active ? C.green : C.dim}${eng.name}${C.reset} — ${status}`);
  }

  // ── Engine selection ──────────────────────────────────────────────────────
  console.log(`\n${bold("Which engines would you like to configure?")}`);
  console.log(dim("(You can re-run this wizard any time to change your setup.)\n"));

  const enabledEngines = [...(currentEngines.filter(e => ENGINES[e]?.type === "free"))]; // always keep free engines

  // ── Key-based engines ─────────────────────────────────────────────────────
  for (const [id, eng] of Object.entries(ENGINES)) {
    if (eng.type !== "key") continue;
    const hasKey  = !!(secrets[eng.secretKey] || config?.search?.[eng.secretKey]);
    const enabled = currentEngines.includes(id);

    console.log(`\n${bold(eng.name)}`);
    console.log(`  ${eng.description}`);
    console.log(`  Free tier: ${C.green}${eng.freeTier}${C.reset}`);
    console.log(`  Register:  ${C.cyan}${eng.registerUrl}${C.reset}`);
    if (hasKey) console.log(`  ${ok("A key is already stored.")}`);

    const choice = await menu(`Configure ${eng.name}?`, [
      { label: hasKey ? "Update key"  : "Enter my key (I already have one)", value: "enter" },
      { label: `Open ${eng.registerUrl} then enter key`,                      value: "open"  },
      { label: enabled ? "Keep current key, re-enable" : "Skip for now",      value: "skip"  },
      ...(hasKey ? [{ label: "Remove this engine", value: "remove" }] : []),
    ]);

    if (choice === "open") {
      try { execSync(`start ${eng.registerUrl}`, { shell: true }); } catch {}
      console.log(info(`Browser opened. Come back and paste your key when ready.`));
      const key = await askSecret(`  Paste your ${eng.name} key: `);
      if (key.trim()) {
        secrets[eng.secretKey] = key.trim();
        enabledEngines.push(id);
        console.log(ok(`${eng.name} key saved.`));
      } else {
        console.log(warn("No key entered — skipping."));
      }
    } else if (choice === "enter") {
      const key = await askSecret(`  Paste your ${eng.name} key: `);
      if (key.trim()) {
        secrets[eng.secretKey] = key.trim();
        enabledEngines.push(id);
        console.log(ok(`${eng.name} key saved.`));
      } else {
        console.log(warn("No key entered — skipping."));
      }
    } else if (choice === "remove") {
      delete secrets[eng.secretKey];
      // remove from config too if present
      if (config?.search?.[eng.secretKey]) delete config.search[eng.secretKey];
      console.log(ok(`${eng.name} key removed.`));
    } else if (choice === "skip" && enabled && hasKey) {
      enabledEngines.push(id);
    }
  }

  // ── SearXNG / Docker ──────────────────────────────────────────────────────
  console.log(`\n${bold("SearXNG — self-hosted meta-search (no key required)")}`);
  console.log(`  ${ENGINES.searxng.description}`);

  const installed = dockerInstalled();
  const running   = installed && dockerAvailable();
  const searxUrl  = config?.search?.searxngUrl || "http://localhost:8888";
  const searxUp   = running && searxngRunning(searxUrl);
  const hasContainer = running && searxngContainerExists();

  if (!installed) {
    console.log(`\n  ${warn("Docker is not installed.")} SearXNG runs as a Docker container.`);
    const install = await confirm("  Would you like to install Docker Desktop now?", true);
    if (install) {
      console.log(info("Launching Docker Desktop installer via winget..."));
      try {
        execSync("winget install --id Docker.DockerDesktop -e --accept-source-agreements --accept-package-agreements", { stdio: "inherit", shell: true });
        console.log(ok("Docker Desktop installed. Please start it from the Start Menu, then re-run this wizard to enable SearXNG."));
      } catch {
        console.log(err("winget install failed. Please install Docker Desktop manually from https://www.docker.com/products/docker-desktop/"));
      }
      console.log(warn("Skipping SearXNG for now — re-run this wizard after Docker starts."));
    } else {
      // Opt-out consequences
      console.log(OPT_OUT_CONSEQUENCES);
    }
  } else if (!running) {
    console.log(`\n  ${warn("Docker is installed but not running.")} Start Docker Desktop, then:`);
    const start = await confirm("  Try to start Docker Desktop now?", true);
    if (start) {
      try {
        execSync(`Start-Process "C:/Program Files/Docker/Docker/Docker Desktop.exe"`, { shell: "powershell", timeout: 5000 });
        console.log(info("Docker Desktop launching — this can take 1-2 minutes."));
        console.log(info("Re-run this wizard once Docker is running to complete SearXNG setup."));
      } catch {
        console.log(warn("Could not auto-launch Docker Desktop. Please start it manually."));
      }
    } else {
      console.log(OPT_OUT_CONSEQUENCES);
    }
  } else {
    // Docker is running
    if (searxUp) {
      console.log(`  ${ok("SearXNG is already running at " + searxUrl)}`);
      const keep = await confirm("  Keep SearXNG enabled?", true);
      if (keep) enabledEngines.push("searxng");
    } else if (hasContainer) {
      console.log(`  ${warn("SearXNG container exists but is not responding.")}`);
      const restart = await confirm("  Restart the SearXNG container?", true);
      if (restart) {
        try {
          execSync("docker restart searxng", { stdio: "inherit", shell: true });
          console.log(ok("SearXNG restarted. Adding to enabled engines."));
          enabledEngines.push("searxng");
        } catch { console.log(err("Failed to restart SearXNG container.")); }
      }
    } else {
      console.log(`  ${info("Docker is running but no SearXNG container found.")}`);
      const setup = await confirm("  Set up SearXNG now? (pulls ~200MB once, auto-starts with Docker)", true);
      if (setup) {
        console.log(info("Pulling and starting SearXNG..."));
        try {
          execSync(
            `docker run -d --name searxng --restart unless-stopped ` +
            `-p 8888:8080 -e SEARXNG_BASE_URL="http://localhost:8888/" ` +
            `searxng/searxng:latest`,
            { stdio: "inherit", shell: true }
          );
          console.log(ok("SearXNG started on http://localhost:8888"));
          enabledEngines.push("searxng");
          if (!config.search) config.search = {};
          config.search.searxngUrl = "http://localhost:8888";
        } catch (e) {
          console.log(err("Failed to start SearXNG: " + e.message));
        }
      } else {
        console.log(OPT_OUT_CONSEQUENCES);
      }
    }
  }

  // ── Free engines (always on) ──────────────────────────────────────────────
  console.log(`\n${bold("Free engines (no key required — always enabled):")}`);
  console.log(`  ${ok("Wikipedia")}         — factual / encyclopaedic queries`);
  console.log(`  ${ok("DDG Instant Answers")} — structured snippets and definitions`);
  if (!enabledEngines.includes("wikipedia"))   enabledEngines.push("wikipedia");
  if (!enabledEngines.includes("ddg-instant")) enabledEngines.push("ddg-instant");

  // ── Summary + warn if only free engines ──────────────────────────────────
  const hasLiveSearch = enabledEngines.some(e => ["brave","tavily","serpapi","searxng"].includes(e));
  if (!hasLiveSearch) {
    console.log(`\n${OPT_OUT_CONSEQUENCES}`);
    const proceed = await confirm("Continue with only free engines (Wikipedia + DDG)?", false);
    if (!proceed) {
      console.log(info("Re-run this wizard when you're ready to add a search engine."));
      rl.close();
      return;
    }
  }

  // ── Save config + secrets ─────────────────────────────────────────────────
  if (!config.search) config.search = {};
  config.search.engines = [...new Set(enabledEngines)];

  // Remove any plaintext keys from config (move to secrets file)
  for (const eng of Object.values(ENGINES)) {
    if (eng.secretKey && config.search[eng.secretKey]) {
      secrets[eng.secretKey] = secrets[eng.secretKey] || config.search[eng.secretKey];
      delete config.search[eng.secretKey];
    }
  }
  // Remove braveApiKey from config if it exists (legacy)
  delete config.search.braveApiKey;

  saveJson(CONFIG_FILE,  config);
  saveJson(SECRETS_FILE, secrets);

  console.log(`\n${bold("━━━  Setup complete  ━━━")}`);
  console.log(`\n  Enabled engines: ${C.green}${config.search.engines.join(", ")}${C.reset}`);
  console.log(`  Config saved to: ${dim(CONFIG_FILE)}`);
  console.log(`  Keys saved to:   ${dim(SECRETS_FILE)} ${C.dim}(local-only, user-readable only)${C.reset}`);
  console.log(`\n  ${info("Restart Claude Desktop to apply changes.")}\n`);

  rl.close();
}

main().catch(e => {
  console.error(err("Setup failed: " + e.message));
  rl.close();
  process.exit(1);
});

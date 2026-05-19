#!/usr/bin/env node
/**
 * sonar-mcp installer
 * Checks prerequisites, pulls Ollama models, and wires Claude Desktop config automatically.
 */

import fs   from "fs";
import path from "path";
import os   from "os";
import { execSync, spawnSync } from "child_process";
import { fileURLToPath }       from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_JS  = path.resolve(__dirname, "index.js");

// Only emit ANSI colors when stdout is a TTY and not explicitly disabled.
// Legacy Windows cmd.exe and piped output get plain text instead of escape codes.
const USE_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (s) => USE_COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s);
const GREEN  = wrap(32);
const RED    = wrap(31);
const YELLOW = wrap(33);
const BOLD   = wrap(1);

const ok   = (msg) => console.log(GREEN("  ✔ ") + msg);
const fail = (msg) => { console.log(RED("  ✘ ") + msg); process.exit(1); };
const warn = (msg) => console.log(YELLOW("  ⚠ ") + msg);
const info = (msg) => console.log("  → " + msg);

console.log(BOLD("\n🔊 sonar-mcp installer\n"));

// ── Step 1: Node.js version ───────────────────────────────────────────────────
console.log(BOLD("Step 1/5 — Checking Node.js"));
const nodeVer = process.versions.node.split(".").map(Number);
if (nodeVer[0] < 18) fail(`Node.js 18+ required, found v${process.versions.node}. Download from https://nodejs.org`);
ok(`Node.js v${process.versions.node}`);

// ── Step 2: npm install ───────────────────────────────────────────────────────
console.log(BOLD("\nStep 2/5 — Installing npm dependencies"));
const nmExists = fs.existsSync(path.join(__dirname, "node_modules", "@modelcontextprotocol"));
if (nmExists) {
  ok("node_modules already present — skipping");
} else {
  info("Running npm install...");
  const r = spawnSync("npm", ["install"], { cwd: __dirname, stdio: "inherit", shell: true });
  if (r.status !== 0) fail("npm install failed. Check the error above.");
  ok("Dependencies installed");
}

// ── Step 3: Ollama ────────────────────────────────────────────────────────────
console.log(BOLD("\nStep 3/5 — Checking Ollama"));

let ollamaRunning = false;
try {
  const res = await fetch("http://localhost:11434");
  ollamaRunning = res.ok || res.status === 200 || res.status < 500;
} catch { /* not running */ }

if (!ollamaRunning) {
  warn("Ollama is not running on http://localhost:11434");
  const plat = os.platform();
  if (plat === "win32") {
    info("To start it: open the Start menu → search for 'Ollama' → launch it (you should see");
    info("    a llama icon in the system tray). Or download from https://ollama.com");
  } else if (plat === "darwin") {
    info("To start it: open the Ollama app from Applications (Cmd+Space → 'Ollama'), or run");
    info("    'ollama serve' in a terminal. Install from https://ollama.com if missing.");
  } else {
    info("To start it: run 'ollama serve' in a terminal. Install from https://ollama.com if missing.");
  }
  warn("After starting Ollama, re-run this installer.");
  warn("Skipping model pull — run manually after Ollama is up: ollama pull llama3.1:8b && ollama pull qwen2.5-coder:7b");
} else {
  ok("Ollama is running");

  // Check which models are already present
  let existingModels = [];
  try {
    const r   = await fetch("http://localhost:11434/api/tags");
    const data = await r.json();
    existingModels = (data.models || []).map(m => m.name);
  } catch { /* ignore */ }

  // Disk space heads-up if we're about to download anything
  const needed = ["llama3.1:8b", "qwen2.5-coder:7b"].filter(m => !existingModels.includes(m));
  if (needed.length > 0) {
    info(`About to pull ${needed.length} model${needed.length > 1 ? "s" : ""} — needs ~${needed.length * 5}GB free disk space.`);
  }

  for (const model of ["llama3.1:8b", "qwen2.5-coder:7b"]) {
    // Exact-tag match — "llama3.1:latest" must NOT satisfy "llama3.1:8b"
    if (existingModels.includes(model)) {
      ok(`${model} already pulled`);
    } else {
      info(`Pulling ${model} — this may take a few minutes...`);
      const r = spawnSync("ollama", ["pull", model], { stdio: "inherit", shell: true });
      if (r.status !== 0) warn(`Failed to pull ${model}. Run manually: ollama pull ${model}`);
      else ok(`${model} pulled`);
    }
  }
}

// ── Step 4: Find Claude Desktop config ───────────────────────────────────────
console.log(BOLD("\nStep 4/5 — Configuring Claude Desktop"));

function getConfigPath() {
  const platform = os.platform();
  if (platform === "win32") {
    return path.join(process.env.APPDATA || "", "Claude", "claude_desktop_config.json");
  } else if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  } else {
    return path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json");
  }
}

const configPath = getConfigPath();
info(`Config path: ${configPath}`);

// Read or create config — refuse to clobber a broken file
let config = {};
if (fs.existsSync(configPath)) {
  const raw = fs.readFileSync(configPath, "utf8");
  try {
    config = JSON.parse(raw);
    ok("Found existing claude_desktop_config.json");
  } catch (e) {
    // Back up the broken file before bailing so the user doesn't lose anything
    const backup = `${configPath}.broken-${Date.now()}.bak`;
    fs.copyFileSync(configPath, backup);
    fail(
      `Existing config file at ${configPath} is not valid JSON (${e.message}).\n` +
      `  Backed up to: ${backup}\n` +
      `  Fix the JSON manually (or delete the file to let this installer create a fresh one), then re-run.`
    );
  }
} else {
  warn("Config file not found — creating it");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
}

// Use absolute path to the Node binary currently running this installer.
// On macOS, Claude Desktop launched from Spotlight/Launchpad has a minimal PATH
// and may not find `node` (especially if installed via nvm/brew). The absolute
// path bypasses that problem entirely.
const NODE_PATH = process.execPath;

if (!config.mcpServers) config.mcpServers = {};
const existing = config.mcpServers["ollama-local"];
config.mcpServers["ollama-local"] = {
  command: NODE_PATH,
  args: [INDEX_JS],
  alwaysAllow: ["sonar", "sonar_stats"],
};

if (existing) ok("Updated existing ollama-local entry in mcpServers");
else          ok("Added ollama-local to mcpServers");
info(`Using Node at: ${NODE_PATH}`);

fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
ok("Config saved");

// ── Step 5: Verify server starts ─────────────────────────────────────────────
console.log(BOLD("\nStep 5/5 — Verifying MCP server"));
info("Starting server for 3 seconds...");

const child = spawnSync(
  process.execPath,
  [INDEX_JS],
  { timeout: 3000, shell: false, encoding: "utf8" }
);
const output = (child.stderr || "") + (child.stdout || "");
if (output.includes("[sonar] Ollama MCP server running")) {
  ok("Server starts successfully");
} else {
  warn("Could not confirm server startup — check index.js manually");
}

// ── Done ──────────────────────────────────────────────────────────────────────
console.log(BOLD(GREEN("\n✅ sonar-mcp is installed!\n")));
console.log("  Next step: " + BOLD("fully restart Claude Desktop") + " (quit from system tray, then reopen).");
console.log("  Then in any conversation type:  " + BOLD("sonar <your question>") + "\n");

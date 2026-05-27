#!/usr/bin/env node
/**
 * sonar-mcp installer
 *
 * SAFETY GUARANTEES:
 *  - Will not touch your system or settings without showing a summary first
 *  - Always backs up claude_desktop_config.json before editing it
 *  - On any error, Ctrl+C, or unsupported version: rolls back changes
 *  - Never removes anything you had before running it
 *  - Pass --yes to skip the confirmation prompt (for automation)
 */

import fs       from "fs";
import path     from "path";
import os       from "os";
import readline from "readline";
import { spawnSync }     from "child_process";
import { fileURLToPath } from "url";

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const INDEX_JS   = path.resolve(__dirname, "index.js");
const NODE_MODS  = path.join(__dirname, "node_modules");
const AUTO_YES   = process.argv.includes("--yes") || process.argv.includes("-y");
const UPDATE     = process.argv.includes("--update") || process.argv.includes("-u");

// Read version from package.json — single source of truth
const PKG = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
const VERSION = PKG.version;

// ── Pretty output ─────────────────────────────────────────────────────────────
const USE_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (s) => USE_COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s);
const GREEN  = wrap(32);
const RED    = wrap(31);
const YELLOW = wrap(33);
const BOLD   = wrap(1);
const DIM    = wrap(2);

const ok   = (m) => console.log(GREEN("  ✔ ") + m);
const warn = (m) => console.log(YELLOW("  ⚠ ") + m);
const info = (m) => console.log("  → " + m);
const head = (m) => console.log("\n" + BOLD(m));

// ── Interactive prompt helper ─────────────────────────────────────────────────
async function ask(question, defaultAnswer = "") {
  if (AUTO_YES) return "y";
  if (!process.stdin.isTTY) {
    warn(`stdin is not a TTY — assuming "${defaultAnswer || "no"}" for: ${question}`);
    return defaultAnswer;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, a => { rl.close(); resolve(a.trim().toLowerCase()); });
  });
}

// ── Rollback machinery ────────────────────────────────────────────────────────
const SNAPSHOT = {
  taken:               false,
  configPath:          null,
  configExisted:       false,
  configContent:       null,   // original bytes
  configBackupPath:    null,   // path of the .bak file we wrote
  nodeModulesExisted:  false,
  configWasModified:   false,
  nodeModulesCreated:  false,
};

function takeSnapshot(configPath) {
  SNAPSHOT.taken              = true;
  SNAPSHOT.configPath         = configPath;
  SNAPSHOT.configExisted      = fs.existsSync(configPath);
  SNAPSHOT.configContent      = SNAPSHOT.configExisted ? fs.readFileSync(configPath, "utf8") : null;
  SNAPSHOT.nodeModulesExisted = fs.existsSync(NODE_MODS);

  // Always write a timestamped backup of the config file before any edit,
  // so the user has a recoverable copy even if the process is killed -9.
  if (SNAPSHOT.configExisted) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    SNAPSHOT.configBackupPath = `${configPath}.bak-${ts}`;
    fs.copyFileSync(configPath, SNAPSHOT.configBackupPath);
    info(`Backup written: ${SNAPSHOT.configBackupPath}`);
  }
}

function rollback(reason) {
  if (!SNAPSHOT.taken) {
    console.log(YELLOW(`\nNothing to roll back — no changes had been made yet.`));
    return;
  }

  console.log(YELLOW(`\n↩  Rolling back: ${reason}\n`));

  // 1. Restore claude_desktop_config.json
  if (SNAPSHOT.configWasModified) {
    if (SNAPSHOT.configExisted) {
      fs.writeFileSync(SNAPSHOT.configPath, SNAPSHOT.configContent);
      ok(`Restored original config: ${SNAPSHOT.configPath}`);
    } else if (fs.existsSync(SNAPSHOT.configPath)) {
      fs.unlinkSync(SNAPSHOT.configPath);
      ok(`Removed config file (didn't exist before installer ran)`);
    }
  }

  // 2. Remove node_modules if we created it
  if (SNAPSHOT.nodeModulesCreated && fs.existsSync(NODE_MODS)) {
    fs.rmSync(NODE_MODS, { recursive: true, force: true });
    ok(`Removed node_modules (didn't exist before installer ran)`);
  }

  // 3. Note about Ollama models — we deliberately do NOT remove them
  console.log(DIM(`\n  Note: any Ollama models that were pulled are NOT removed —`));
  console.log(DIM(`  they may be useful for other purposes. To remove manually:`));
  console.log(DIM(`    ollama rm llama3.1:8b qwen2.5-coder:7b\n`));

  if (SNAPSHOT.configBackupPath && fs.existsSync(SNAPSHOT.configBackupPath)) {
    console.log(DIM(`  Backup of your original config is still at:`));
    console.log(DIM(`    ${SNAPSHOT.configBackupPath}\n`));
  }
}

// Hook Ctrl+C / kill signals
let rolledBack = false;
function panicAndExit(reason, code = 1) {
  if (!rolledBack) {
    rolledBack = true;
    rollback(reason);
  }
  process.exit(code);
}
process.on("SIGINT",  () => panicAndExit("interrupted (Ctrl+C)", 130));
process.on("SIGTERM", () => panicAndExit("terminated", 143));

// ── Helpers ───────────────────────────────────────────────────────────────────
function getConfigPath() {
  const platform = os.platform();
  if (platform === "win32") return path.join(process.env.APPDATA || "", "Claude", "claude_desktop_config.json");
  if (platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  return path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json");
}

async function isOllamaRunning() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch("http://localhost:11434", { signal: ctrl.signal });
    clearTimeout(t);
    return res.status < 500;
  } catch { return false; }
}

async function listOllamaModels() {
  try {
    const r = await fetch("http://localhost:11434/api/tags");
    const d = await r.json();
    return (d.models || []).map(m => m.name);
  } catch { return []; }
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
console.log(BOLD(`\n🔊 sonar-mcp installer ${DIM("v" + VERSION)}\n`));
console.log(DIM("  This installer will NOT touch your system without showing you a summary first."));
console.log(DIM("  On any error or cancellation, all changes are rolled back automatically.\n"));

try {

// ── UPDATE MODE ───────────────────────────────────────────────────────────────
if (UPDATE) {
  head("Update mode — pulling latest from GitHub");

  // Must be inside a git checkout
  if (!fs.existsSync(path.join(__dirname, ".git"))) {
    console.log(RED("  ✘ This folder is not a git checkout."));
    console.log("  To update, re-clone the repo:");
    console.log(`    git clone https://github.com/wanz1000/sonar-mcp.git`);
    panicAndExit("not a git checkout — cannot use --update", 1);
  }

  // Warn if local changes would conflict
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: __dirname, encoding: "utf8" });
  if ((status.stdout || "").trim().length > 0) {
    warn("You have uncommitted local changes:");
    console.log(status.stdout);
    const ans = await ask("  Continue anyway? Local changes may conflict with the pull. [y/N] ", "n");
    if (ans !== "y" && ans !== "yes") {
      console.log("\n  Cancelled. Stash or commit your changes first, then re-run.\n");
      process.exit(0);
    }
  }

  // Fetch
  info("Fetching latest from origin...");
  const fetch = spawnSync("git", ["fetch", "origin"], { cwd: __dirname, stdio: "inherit", shell: true });
  if (fetch.status !== 0) panicAndExit("git fetch failed", 1);

  // Compare local vs remote
  const localSha  = spawnSync("git", ["rev-parse", "HEAD"], { cwd: __dirname, encoding: "utf8" }).stdout.trim();
  const remoteSha = spawnSync("git", ["rev-parse", "origin/main"], { cwd: __dirname, encoding: "utf8" }).stdout.trim();

  if (localSha === remoteSha) {
    console.log(GREEN(`\n  ✔ Already up to date (v${VERSION} — ${localSha.slice(0, 7)})\n`));
    process.exit(0);
  }

  // Show what's coming
  info("New commits available:");
  spawnSync("git", ["log", "--oneline", `${localSha}..origin/main`], { cwd: __dirname, stdio: "inherit", shell: true });
  console.log("");

  const proceed = await ask(`  Pull these changes? [y/N] `, "n");
  if (proceed !== "y" && proceed !== "yes") {
    console.log("\n  Cancelled. No changes pulled.\n");
    process.exit(0);
  }

  // Pull
  info("Pulling...");
  const pull = spawnSync("git", ["pull", "origin", "main"], { cwd: __dirname, stdio: "inherit", shell: true });
  if (pull.status !== 0) panicAndExit("git pull failed — fix conflicts manually and re-run", 1);
  ok("Pull complete");

  // Re-run npm install if package.json or package-lock changed
  const changed = spawnSync("git", ["diff", "--name-only", "HEAD@{1}", "HEAD"], { cwd: __dirname, encoding: "utf8" }).stdout;
  if (/package(-lock)?\.json/.test(changed)) {
    info("Dependencies changed — running npm install...");
    const np = spawnSync("npm", ["install"], { cwd: __dirname, stdio: "inherit", shell: true });
    if (np.status !== 0) panicAndExit("npm install failed after pull", 1);
    ok("Dependencies updated");
  } else {
    ok("No dependency changes — skipping npm install");
  }

  // Verify the server still starts
  info("Verifying updated server starts...");
  const child = spawnSync(process.execPath, [INDEX_JS], { timeout: 3000, shell: false, encoding: "utf8" });
  const out = (child.stderr || "") + (child.stdout || "");
  if (out.includes("[sonar] Ollama MCP server running")) {
    ok("Server starts successfully");
  } else {
    panicAndExit("Updated server did not start — check the new index.js", 1);
  }

  // Re-read version after pull
  const newPkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
  console.log("\n" + BOLD(GREEN(`✅ Updated to v${newPkg.version}\n`)));
  console.log(`  ${BOLD("Fully restart Claude Desktop")} (quit from system tray / menu bar, then reopen)`);
  console.log(`  to load the updated MCP server.\n`);
  process.exit(0);
}


// ── PRE-FLIGHT (read-only) ────────────────────────────────────────────────────
head("Pre-flight checks (read-only)");

// Node.js version
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 18) {
  console.log(RED(`  ✘ Node.js v${process.versions.node} is too old. Sonar requires Node 18 or later.`));
  console.log("");
  console.log("  What do you want to do?");
  console.log(`    [1] Open ${BOLD("https://nodejs.org/en/download")} in your browser, then re-run this installer`);
  console.log(`    [2] Cancel`);
  const answer = await ask("  Choose [1/2]: ", "2");
  if (answer === "1") {
    const opener = os.platform() === "darwin" ? "open" : os.platform() === "win32" ? "start" : "xdg-open";
    spawnSync(opener, ["https://nodejs.org/en/download"], { shell: true });
    console.log("  Browser opened. Install Node 18+ and re-run this installer.");
  }
  panicAndExit("Node version unsupported", 1);
}
ok(`Node.js v${process.versions.node}`);

// OS
const supportedOs = ["win32", "darwin", "linux"];
if (!supportedOs.includes(os.platform())) {
  console.log(RED(`  ✘ Platform ${os.platform()} is not supported.`));
  panicAndExit("Unsupported OS", 1);
}
ok(`Platform: ${os.platform()}`);

// Ollama running?
const ollamaUp = await isOllamaRunning();
if (!ollamaUp) {
  console.log(YELLOW(`  ⚠ Ollama is not running on http://localhost:11434`));
  const plat = os.platform();
  if (plat === "win32")  console.log("    Start it: Start menu → 'Ollama' → launch (look for the tray icon).");
  else if (plat === "darwin") console.log("    Start it: open the Ollama app, or run 'ollama serve' in a terminal.");
  else console.log("    Start it: run 'ollama serve' in a terminal.");
  console.log("    If you haven't installed Ollama: https://ollama.com");
  console.log("");
  const ans = await ask("  Press Enter to retry, or type 'cancel' to exit: ", "");
  if (ans === "cancel" || ans === "c") panicAndExit("Ollama not running, user cancelled", 0);
  // Re-check once
  if (!(await isOllamaRunning())) panicAndExit("Ollama still not running — install/start it and re-run", 1);
}
ok("Ollama is reachable on http://localhost:11434");

// Config path
const configPath = getConfigPath();
const configExists = fs.existsSync(configPath);
ok(`Claude Desktop config: ${configPath}${configExists ? "" : " (will be created)"}`);

// ── PLAN SUMMARY ──────────────────────────────────────────────────────────────
const existingModels = await listOllamaModels();
const needPull = ["llama3.1:8b", "qwen2.5-coder:7b"].filter(m => !existingModels.includes(m));
const needNpm  = !fs.existsSync(path.join(NODE_MODS, "@modelcontextprotocol"));

head("Here's what this installer will do");
const plan = [];
if (needNpm) plan.push(`Run "npm install" (adds ./node_modules — reversible)`);
else         plan.push(DIM(`Skip npm install (node_modules already present)`));

if (needPull.length > 0) {
  plan.push(`Pull ${needPull.length} Ollama model${needPull.length > 1 ? "s" : ""}: ${needPull.join(", ")} (~${needPull.length * 5}GB disk)`);
} else {
  plan.push(DIM(`Skip model pulls (both already present)`));
}

if (configExists) {
  plan.push(`Add ONE entry ("ollama-local") to your existing claude_desktop_config.json — all other entries preserved, original backed up first`);
} else {
  plan.push(`Create a new claude_desktop_config.json with just the sonar-mcp entry`);
}
plan.push(`Verify the MCP server starts cleanly`);

plan.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));

console.log(DIM(`\n  If anything goes wrong or you Ctrl+C, all changes will be rolled back.`));
console.log(DIM(`  Ollama models pulled are kept (they're useful independently).`));

const proceed = await ask(`\n  Proceed? [y/N] `, "n");
if (proceed !== "y" && proceed !== "yes") {
  console.log("\n  Cancelled. No changes were made.\n");
  process.exit(0);
}

// ── SNAPSHOT BEFORE ANY WRITES ────────────────────────────────────────────────
head("Taking snapshot for rollback safety");
takeSnapshot(configPath);
ok("Snapshot complete");

// ── STEP 1: npm install ───────────────────────────────────────────────────────
head("Step 1/4 — npm dependencies");
if (!needNpm) {
  ok("node_modules already present — skipping");
} else {
  info("Running npm install...");
  const r = spawnSync("npm", ["install"], { cwd: __dirname, stdio: "inherit", shell: true });
  if (r.status !== 0) panicAndExit("npm install failed", 1);
  SNAPSHOT.nodeModulesCreated = true;
  ok("Dependencies installed");
}

// ── STEP 2: Pull Ollama models ────────────────────────────────────────────────
head("Step 2/4 — Ollama models");
if (needPull.length === 0) {
  ok("Both models already pulled");
} else {
  info(`Pulling ${needPull.length} model${needPull.length > 1 ? "s" : ""} (~${needPull.length * 5}GB) — this may take several minutes.`);
  for (const model of needPull) {
    info(`Pulling ${model}...`);
    const r = spawnSync("ollama", ["pull", model], { stdio: "inherit", shell: true });
    if (r.status !== 0) panicAndExit(`Failed to pull ${model}`, 1);
    ok(`${model} pulled`);
  }
}

// ── STEP 3: Edit Claude Desktop config ────────────────────────────────────────
head("Step 3/4 — Claude Desktop config");

let config = {};
if (configExists) {
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (e) {
    panicAndExit(`Existing config is not valid JSON (${e.message}). Fix it or delete it, then re-run.`, 1);
  }
} else {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
}

if (!config.mcpServers) config.mcpServers = {};
const wasThere = !!config.mcpServers["ollama-local"];
config.mcpServers["ollama-local"] = {
  command: process.execPath,
  args: [INDEX_JS],
  alwaysAllow: ["sonar", "sonar_stats", "sonar_health"],
};

fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
SNAPSHOT.configWasModified = true;
ok(wasThere ? "Updated existing ollama-local entry" : "Added ollama-local entry");
info(`Using Node at: ${process.execPath}`);

// ── STEP 4: Verify server starts ──────────────────────────────────────────────
head("Step 4/4 — Verify MCP server");
info("Starting server for 3 seconds...");
const child = spawnSync(process.execPath, [INDEX_JS], { timeout: 3000, shell: false, encoding: "utf8" });
const out = (child.stderr || "") + (child.stdout || "");
if (out.includes("[sonar] Ollama MCP server running")) {
  ok("Server starts successfully");
} else {
  panicAndExit("Server did not report ready in 3 seconds — something is wrong with index.js", 1);
}

// ── DONE ──────────────────────────────────────────────────────────────────────
console.log("\n" + BOLD(GREEN("✅ sonar-mcp installed successfully!\n")));
console.log("  Next: " + BOLD("fully restart Claude Desktop") + " (quit from system tray / menu bar, then reopen).");
console.log("  Then in any conversation type: " + BOLD("sonar <your question>") + "\n");
if (SNAPSHOT.configBackupPath) {
  console.log(DIM(`  (Backup of your previous config: ${SNAPSHOT.configBackupPath})\n`));
}

} catch (err) {
  console.log(RED(`\n✘ Unexpected error: ${err?.message ?? err}`));
  panicAndExit("unexpected error", 1);
}

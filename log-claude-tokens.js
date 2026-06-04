#!/usr/bin/env node
/**
 * Claude Code Stop hook — reads the session transcript and logs exact Claude
 * token usage (from the real API usage fields) into Sonar's token-stats.json.
 *
 * Invoked automatically by Claude Code after every response turn.
 * Receives a JSON payload on stdin with { session_id, transcript_path, ... }
 *
 * Also runnable manually:
 *   node log-claude-tokens.js <path-to-session.jsonl>
 */

import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";
import readline from "readline";

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const STATS_FILE = path.join(__dirname, "token-stats.json");
const KEEP_DAYS  = 365;

// ── Helpers ───────────────────────────────────────────────────────────────────

const pad   = (n) => String(n).padStart(2, "0");
const ymd   = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;

function loadStats() {
  try { return JSON.parse(fs.readFileSync(STATS_FILE, "utf8")); }
  catch { return {}; }
}

function pruneStats(stats) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - KEEP_DAYS);
  const cutoffStr = ymd(cutoff);
  for (const key of Object.keys(stats)) {
    if (key < cutoffStr) delete stats[key];
  }
  return stats;
}

// ── Parse a JSONL transcript for exact Claude API token usage ─────────────────

async function parseTranscript(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl     = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let sessionDate  = null;
  let sessionId    = path.basename(filePath, ".jsonl");
  let totalOutput  = 0;
  let peakInput    = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }

    // Grab the date from the first timestamped entry
    if (!sessionDate && obj.timestamp) {
      sessionDate = obj.timestamp.slice(0, 10);
    }

    // Extract usage from assistant messages (real API token counts)
    const u = obj.message?.usage;
    if (u && typeof u === "object") {
      const inp = (u.input_tokens || 0)
                + (u.cache_read_input_tokens || 0)
                + (u.cache_creation_input_tokens || 0);
      totalOutput += (u.output_tokens || 0);
      if (inp > peakInput) peakInput = inp;
    }
  }

  return { sessionId, sessionDate, peakInput, totalOutput };
}

// ── Update stats file with Claude token data ──────────────────────────────────

function updateStats(sessionDate, sessionId, peakInput, totalOutput) {
  let stats = loadStats();

  if (!stats[sessionDate]) {
    stats[sessionDate] = {
      promptTokens: 0, completionTokens: 0, requests: 0,
      claudeTokens: 0, claudeSessions: 0, claudeOutput: 0,
    };
  }

  const day = stats[sessionDate];

  // Track per-session so re-runs don't double-count
  if (!day.claudeSessionMap) day.claudeSessionMap = {};

  const prev = day.claudeSessionMap[sessionId] || { peakInput: 0, totalOutput: 0 };

  // Only update if new values are larger (session grows over time)
  if (peakInput > prev.peakInput || totalOutput > prev.totalOutput) {
    const inputDelta  = peakInput   - prev.peakInput;
    const outputDelta = totalOutput - prev.totalOutput;

    // claudeTokens = peak context window used (most relevant for Pro limit)
    // claudeOutput = cumulative output generated
    day.claudeTokens      = (day.claudeTokens  || 0) + inputDelta;
    day.claudeOutput      = (day.claudeOutput  || 0) + outputDelta;
    day.claudeSessions    = Object.keys(day.claudeSessionMap).length +
                            (day.claudeSessionMap[sessionId] ? 0 : 1);

    day.claudeSessionMap[sessionId] = { peakInput, totalOutput };
  }

  stats = pruneStats(stats);
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));

  return { peakInput, totalOutput, sessionDate };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  let transcriptPath = null;

  // Try reading from stdin (hook mode: Claude Code sends JSON payload)
  if (!process.stdin.isTTY) {
    try {
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      transcriptPath = payload.transcript_path || payload.transcriptPath || null;
    } catch {
      // stdin wasn't valid JSON — fall through to argv
    }
  }

  // Fall back to command-line argument (manual / backfill mode)
  if (!transcriptPath && process.argv[2]) {
    transcriptPath = process.argv[2];
  }

  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    process.stderr.write("[log-claude-tokens] no valid transcript path — skipping\n");
    process.exit(0);
  }

  const { sessionId, sessionDate, peakInput, totalOutput } =
    await parseTranscript(transcriptPath);

  if (!sessionDate) {
    process.stderr.write("[log-claude-tokens] could not determine session date — skipping\n");
    process.exit(0);
  }

  const result = updateStats(sessionDate, sessionId, peakInput, totalOutput);

  process.stderr.write(
    `[log-claude-tokens] ${sessionDate} ${sessionId.slice(0,8)} ` +
    `input_peak=${result.peakInput.toLocaleString()} ` +
    `output_total=${result.totalOutput.toLocaleString()}\n`
  );
}

main().catch((e) => {
  process.stderr.write(`[log-claude-tokens] error: ${e.message}\n`);
  process.exit(0); // never block Claude
});

/**
 * Startup failure logger.
 *
 * Claude Desktop's .mcpb runtime swallows the stderr of MCP servers, so a
 * server that calls `console.error(...); process.exit(1)` during startup
 * leaves the user with nothing but "Server transport closed unexpectedly".
 * This module writes a timestamped block to ~/.mybrain/startup.log
 * before the process exits, so operators (and us, when triaging) have a
 * single file to inspect.
 *
 * Best-effort. Logging must not throw, must not block startup, and must
 * not break the original failure path -- if the log write fails, we
 * fall through to the original console.error + process.exit.
 *
 * Driven by Frank's 2026-05-07 .mcpb install which sat in zombie state
 * for hours because the host hid stderr.
 */

import { mkdirSync, appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function getStartupLogDir() {
  return path.join(os.homedir(), ".mybrain");
}

function getStartupLogPath() {
  return path.join(getStartupLogDir(), "startup.log");
}

/**
 * Append a timestamped failure block to ~/.mybrain/startup.log.
 *
 * @param {string} reason - One-line summary of the failure.
 * @param {object} [extra] - Optional fields to record (e.g. config_source).
 */
function writeStartupFailure(reason, extra = {}) {
  try {
    const dir = getStartupLogDir();
    mkdirSync(dir, { recursive: true });

    const ts = new Date().toISOString();
    const lines = [
      `[${ts}] mybrain startup failed`,
      `reason: ${String(reason).split("\n")[0] || "(no reason)"}`,
      `detail: ${String(reason)}`,
      `node_version: ${process.version}`,
      `cwd: ${process.cwd()}`,
    ];
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined && value !== null) {
        lines.push(`${key}: ${value}`);
      }
    }
    lines.push("---", "");

    appendFileSync(getStartupLogPath(), lines.join("\n"), { encoding: "utf-8" });
  } catch {
    // Logging is best-effort. Stay silent on fs errors so the caller's
    // original console.error + process.exit path stays unaffected.
  }
}

export { getStartupLogPath, writeStartupFailure };

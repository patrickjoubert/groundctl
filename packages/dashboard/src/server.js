#!/usr/bin/env node
/**
 * groundctl dashboard server
 * Reads .groundctl/db.sqlite from the CWD project, serves on port 4242.
 * Pure Node.js — no framework dependency.
 */

import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { exec } from "node:child_process";
import initSqlJs from "sql.js";

const PORT = process.env.GROUNDCTL_PORT ? parseInt(process.env.GROUNDCTL_PORT) : 4242;

// Find the project's .groundctl/db.sqlite
function findDbPath(startDir = process.cwd()) {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, ".groundctl", "db.sqlite");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function readDb(dbPath) {
  const SQL = await initSqlJs();
  const buffer = readFileSync(dbPath);
  const db = new SQL.Database(buffer);

  function q(sql, params = []) {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  const features = q("SELECT * FROM features ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'done' THEN 1 ELSE 2 END, CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END");
  const sessions = q("SELECT * FROM sessions ORDER BY started_at DESC LIMIT 20");
  const claims   = q("SELECT c.*, f.name as feature_name FROM claims c JOIN features f ON c.feature_id = f.id WHERE c.released_at IS NULL");
  const decisions = q("SELECT d.*, s.id as sess FROM decisions d JOIN sessions s ON d.session_id = s.id ORDER BY d.id DESC LIMIT 30");
  const files = q("SELECT * FROM files_modified ORDER BY id DESC LIMIT 100");

  const total = features.length;
  const done  = features.filter(f => f.status === "done").length;
  const pct   = total > 0 ? Math.round(done / total * 100) : 0;

  // Health score
  const testFiles = files.filter(f => /\.(test|spec)\./.test(f.path) || f.path.includes("__tests__")).length;
  const decCount  = decisions.length;
  const stale     = claims.filter(c => {
    const age = Date.now() - new Date(c.claimed_at).getTime();
    return age > 24 * 60 * 60 * 1000;
  }).length;
  const health = Math.min(100, Math.round(
    (done / Math.max(1, total)) * 40 +
    (testFiles > 0 ? Math.min(20, testFiles * 5) : 0) +
    (decCount > 0 ? Math.min(20, decCount * 2) : 0) +
    (stale === 0 ? 10 : 0) +
    0 // deploy: manual for now
  ));

  db.close();

  return { features, sessions, claims, decisions, files, meta: { total, done, pct, health, testFiles, decCount, stale } };
}

function renderBar(done, total, width = 20) {
  const filled = total > 0 ? Math.round((done / total) * width) : 0;
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function relTime(ts) {
  if (!ts) return "—";
  const ms = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1)   return "just now";
  if (mins < 60)  return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 24)     return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function renderHtml(data, projectName, dbPath) {
  const { features, sessions, claims, decisions, files, meta } = data;

  const statusColor = meta.pct >= 70 ? "#4ade80" : meta.pct >= 40 ? "#facc15" : "#f87171";
  const healthColor = meta.health >= 70 ? "#4ade80" : meta.health >= 40 ? "#facc15" : "#f87171";

  const claimedRows = claims.map(c => `
    <div class="claim-row">
      <span class="claim-dot">●</span>
      <span class="claim-name">${esc(c.feature_name)}</span>
      <span class="claim-session">session ${esc(c.session_id)}</span>
      <span class="claim-age">${relTime(c.claimed_at)}</span>
    </div>`).join("") || `<div class="empty-note">No active claims</div>`;

  const featRows = features.map(f => {
    const statusClass = f.status === "done" ? "feat-done" : f.status === "in_progress" ? "feat-active" : "feat-pending";
    const icon = f.status === "done" ? "✓" : f.status === "in_progress" ? "●" : "○";
    return `<div class="feat-row ${statusClass}">
      <span class="feat-icon">${icon}</span>
      <span class="feat-name">${esc(f.name)}</span>
      <span class="feat-priority priority-${esc(f.priority)}">${esc(f.priority)}</span>
      <span class="feat-status">${esc(f.status)}</span>
    </div>`;
  }).join("");

  const sessionRows = sessions.map(s => {
    const fileCount = files.filter(f => f.session_id === s.id).length;
    const decCount  = decisions.filter(d => d.session_id === s.id).length;
    const statusDot = s.ended_at ? "●" : "◌";
    const summary = s.summary ? s.summary.slice(0, 80) : "";
    return `<div class="session-row">
      <span class="sess-id">${esc(s.id)}</span>
      <span class="sess-dot">${statusDot}</span>
      <span class="sess-summary">${esc(summary)}</span>
      <span class="sess-meta">${fileCount} files · ${decCount} dec · ${relTime(s.started_at)}</span>
    </div>`;
  }).join("") || `<div class="empty-note">No sessions yet</div>`;

  const decisionRows = decisions.slice(0, 10).map(d => `
    <div class="decision-row">
      <span class="dec-sess">${esc(d.sess)}</span>
      <span class="dec-text">${esc(d.description.slice(0, 100))}</span>
      ${d.rationale ? `<span class="dec-rationale">${esc(d.rationale.slice(0, 80))}</span>` : ""}
    </div>`).join("") || `<div class="empty-note">No decisions documented yet</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(projectName)} — groundctl</title>
  <meta http-equiv="refresh" content="10">
  <style>
    :root {
      --bg: #0a0a0a; --bg2: #111; --bg3: #1a1a1a; --border: #222;
      --text: #e0e0e0; --dim: #666; --mid: #999;
      --green: #4ade80; --yellow: #facc15; --blue: #60a5fa; --red: #f87171;
      --mono: "Berkeley Mono", "IBM Plex Mono", "Fira Code", ui-monospace, monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg); color: var(--text); font-family: var(--mono); font-size: 13px; line-height: 1.6; }
    .layout { display: grid; grid-template-columns: 280px 1fr; min-height: 100vh; }
    .sidebar { border-right: 1px solid var(--border); padding: 24px 20px; display: flex; flex-direction: column; gap: 28px; }
    .main { padding: 24px; display: flex; flex-direction: column; gap: 24px; overflow: auto; }

    /* Status card */
    .status-card { }
    .project-name { font-size: 1.1rem; font-weight: 700; color: #fff; margin-bottom: 4px; }
    .pct-line { color: ${statusColor}; font-size: 0.9rem; margin-bottom: 8px; }
    .progress-bar { font-size: 0.85rem; color: var(--green); letter-spacing: 0.5px; margin-bottom: 4px; }
    .progress-sub { font-size: 0.75rem; color: var(--dim); }

    /* Health */
    .health-card .health-score { font-size: 1.8rem; font-weight: 700; color: ${healthColor}; }
    .health-label { font-size: 0.7rem; color: var(--dim); text-transform: uppercase; letter-spacing: 0.08em; }
    .health-items { margin-top: 10px; display: flex; flex-direction: column; gap: 4px; }
    .health-item { font-size: 0.8rem; color: var(--mid); display: flex; gap: 8px; }
    .health-item .ok { color: var(--green); }
    .health-item .warn { color: var(--yellow); }
    .health-item .bad { color: var(--red); }

    /* Section */
    .section { background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
    .section-header { padding: 10px 16px; border-bottom: 1px solid var(--border); font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.1em; color: var(--dim); display: flex; justify-content: space-between; align-items: center; }
    .section-count { background: var(--bg3); border-radius: 4px; padding: 1px 6px; font-size: 0.7rem; color: var(--mid); }

    /* Claims */
    .claim-row { display: flex; align-items: center; gap: 10px; padding: 10px 16px; border-bottom: 1px solid var(--border); }
    .claim-row:last-child { border-bottom: none; }
    .claim-dot { color: var(--yellow); }
    .claim-name { flex: 1; color: #fff; }
    .claim-session { color: var(--dim); font-size: 0.8rem; }
    .claim-age { color: var(--blue); font-size: 0.8rem; }

    /* Features */
    .feat-row { display: grid; grid-template-columns: 20px 1fr 70px 90px; gap: 8px; padding: 8px 16px; border-bottom: 1px solid var(--border); align-items: center; }
    .feat-row:last-child { border-bottom: none; }
    .feat-done { opacity: 0.45; }
    .feat-active { background: rgba(250,204,21,0.04); }
    .feat-icon { }
    .feat-done .feat-icon { color: var(--green); }
    .feat-active .feat-icon { color: var(--yellow); }
    .feat-pending .feat-icon { color: var(--dim); }
    .feat-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .feat-priority { font-size: 0.75rem; text-align: right; }
    .priority-critical { color: var(--red); }
    .priority-high { color: var(--yellow); }
    .priority-medium { color: var(--mid); }
    .priority-low { color: var(--dim); }
    .feat-status { font-size: 0.75rem; color: var(--dim); text-align: right; }

    /* Sessions */
    .session-row { display: grid; grid-template-columns: 60px 16px 1fr auto; gap: 8px; padding: 10px 16px; border-bottom: 1px solid var(--border); align-items: start; }
    .session-row:last-child { border-bottom: none; }
    .sess-id { color: var(--blue); font-weight: 600; font-size: 0.85rem; }
    .sess-dot { color: var(--green); }
    .sess-summary { color: var(--mid); font-size: 0.8rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sess-meta { color: var(--dim); font-size: 0.75rem; text-align: right; white-space: nowrap; }

    /* Decisions */
    .decision-row { padding: 10px 16px; border-bottom: 1px solid var(--border); display: grid; grid-template-columns: 50px 1fr; gap: 8px; }
    .decision-row:last-child { border-bottom: none; }
    .dec-sess { color: var(--blue); font-size: 0.8rem; }
    .dec-text { color: var(--text); font-size: 0.8rem; }
    .dec-rationale { grid-column: 2; font-size: 0.75rem; color: var(--dim); font-style: italic; }

    .empty-note { padding: 16px; color: var(--dim); font-size: 0.85rem; text-align: center; }
    .refresh-note { font-size: 0.7rem; color: var(--dim); text-align: center; padding-top: 8px; }

    .top-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }

    @media (max-width: 800px) {
      .layout { grid-template-columns: 1fr; }
      .sidebar { border-right: none; border-bottom: 1px solid var(--border); }
      .top-row { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
<div class="layout">

  <aside class="sidebar">
    <!-- Status -->
    <div class="status-card">
      <div class="project-name">${esc(projectName)}</div>
      <div class="pct-line">${meta.pct}% implemented</div>
      <div class="progress-bar">${renderBar(meta.done, meta.total)}</div>
      <div class="progress-sub">${meta.done}/${meta.total} features done</div>
    </div>

    <!-- Health -->
    <div class="health-card">
      <div class="health-label">Health Score</div>
      <div class="health-score">${meta.health}<span style="font-size:1rem;color:var(--dim)">/100</span></div>
      <div class="health-items">
        <div class="health-item">
          <span class="${meta.done > 0 ? "ok" : "warn"}">${meta.done > 0 ? "✓" : "⚠"}</span>
          <span>Features ${meta.done}/${meta.total}</span>
        </div>
        <div class="health-item">
          <span class="${meta.testFiles > 0 ? "ok" : "bad"}">${meta.testFiles > 0 ? "✓" : "✗"}</span>
          <span>Tests ${meta.testFiles} files</span>
        </div>
        <div class="health-item">
          <span class="${meta.decCount > 0 ? "ok" : "warn"}">${meta.decCount > 0 ? "✓" : "⚠"}</span>
          <span>Decisions ${meta.decCount}</span>
        </div>
        <div class="health-item">
          <span class="${meta.stale === 0 ? "ok" : "bad"}">${meta.stale === 0 ? "✓" : "✗"}</span>
          <span>Claims ${meta.stale > 0 ? meta.stale + " stale" : "healthy"}</span>
        </div>
      </div>
    </div>

    <div class="refresh-note">auto-refresh every 10s<br><span style="color:var(--border)">DB: ${esc(dbPath.split("/").slice(-3).join("/"))}</span></div>
  </aside>

  <main class="main">
    <!-- Claims live -->
    <div class="section">
      <div class="section-header">
        <span>Claims live</span>
        <span class="section-count">${claims.length}</span>
      </div>
      ${claimedRows}
    </div>

    <!-- Top row: features + sessions -->
    <div class="top-row">
      <div class="section">
        <div class="section-header">
          <span>Features</span>
          <span class="section-count">${features.length}</span>
        </div>
        ${featRows}
      </div>

      <div class="section">
        <div class="section-header">
          <span>Session timeline</span>
          <span class="section-count">${sessions.length}</span>
        </div>
        ${sessionRows}
      </div>
    </div>

    <!-- Decisions -->
    <div class="section">
      <div class="section-header">
        <span>Recent decisions</span>
        <span class="section-count">${decisions.length}</span>
      </div>
      ${decisionRows}
    </div>
  </main>

</div>
</body>
</html>`;
}

// ── Server ─────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  if (req.url !== "/" && req.url !== "") {
    res.writeHead(404); res.end("Not found"); return;
  }

  const dbPath = findDbPath();
  if (!dbPath) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!DOCTYPE html><html><body style="background:#0a0a0a;color:#e0e0e0;font-family:monospace;padding:40px">
      <h2>groundctl</h2>
      <p style="color:#f87171">No .groundctl/db.sqlite found in this directory.</p>
      <p>Run: <code>groundctl init</code></p>
    </body></html>`);
    return;
  }

  try {
    const data = await readDb(dbPath);
    const projectName = process.cwd().split("/").pop() ?? "project";
    const html = renderHtml(data, projectName, dbPath);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(`Error reading DB: ${err.message}`);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  groundctl dashboard → http://localhost:${PORT}\n`);
  exec(`open http://localhost:${PORT} 2>/dev/null || xdg-open http://localhost:${PORT} 2>/dev/null || true`);
});

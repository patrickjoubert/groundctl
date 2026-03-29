import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { exec } from "node:child_process";
import chalk from "chalk";
import initSqlJs from "sql.js";

// ── DB helpers ─────────────────────────────────────────────────────────────

function findDbPath(startDir = process.cwd()): string | null {
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

interface FeatureRow  { id: string; name: string; status: string; priority: string; }
interface SessionRow  { id: string; agent: string; started_at: string; ended_at: string | null; summary: string | null; }
interface ClaimRow    { feature_id: string; feature_name: string; session_id: string; claimed_at: string; }
interface DecisionRow { id: number; session_id: string; sess: string; description: string; rationale: string | null; }
interface FileRow     { id: number; session_id: string; path: string; }

interface DbData {
  features:  FeatureRow[];
  sessions:  SessionRow[];
  claims:    ClaimRow[];
  decisions: DecisionRow[];
  files:     FileRow[];
  meta: { total: number; done: number; pct: number; health: number; testFiles: number; decCount: number; stale: number; };
}

async function readDb(dbPath: string): Promise<DbData> {
  const SQL = await initSqlJs();
  const buffer = readFileSync(dbPath);
  const db = new SQL.Database(buffer);

  function q<T>(sql: string, params: unknown[] = []): T[] {
    const stmt = db.prepare(sql);
    stmt.bind(params as Parameters<typeof stmt.bind>[0]);
    const rows: T[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject() as T);
    stmt.free();
    return rows;
  }

  const features  = q<FeatureRow>("SELECT * FROM features ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END");
  const sessions  = q<SessionRow>("SELECT * FROM sessions ORDER BY started_at DESC LIMIT 20");
  const claims    = q<ClaimRow>("SELECT c.*, f.name as feature_name FROM claims c JOIN features f ON c.feature_id = f.id WHERE c.released_at IS NULL");
  const decisions = q<DecisionRow>("SELECT d.*, s.id as sess FROM decisions d JOIN sessions s ON d.session_id = s.id ORDER BY d.id DESC LIMIT 30");
  const files     = q<FileRow>("SELECT * FROM files_modified ORDER BY id DESC LIMIT 100");

  const total     = features.length;
  const done      = features.filter(f => f.status === "done").length;
  const pct       = total > 0 ? Math.round(done / total * 100) : 0;
  const testFiles = files.filter(f => /\.(test|spec)\./.test(f.path) || f.path.includes("__tests__")).length;
  const decCount  = decisions.length;
  const stale     = claims.filter(c => Date.now() - new Date(c.claimed_at).getTime() > 86_400_000).length;
  const health    = Math.min(100, Math.round(
    (done / Math.max(1, total)) * 40 +
    (testFiles > 0 ? Math.min(20, testFiles * 5) : 0) +
    (decCount  > 0 ? Math.min(20, decCount  * 2) : 0) +
    (stale === 0 ? 10 : 0)
  ));

  db.close();
  return { features, sessions, claims, decisions, files, meta: { total, done, pct, health, testFiles, decCount, stale } };
}

// ── HTML renderer ──────────────────────────────────────────────────────────

function bar(done: number, total: number, w = 20): string {
  const n = total > 0 ? Math.round((done / total) * w) : 0;
  return "█".repeat(n) + "░".repeat(w - n);
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function rel(ts: string | null | undefined): string {
  if (!ts) return "—";
  const m = Math.floor((Date.now() - new Date(ts).getTime()) / 60_000);
  if (m < 1)  return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function renderHtml(data: DbData, projectName: string, dbPath: string): string {
  const { features, sessions, claims, decisions, files, meta } = data;
  const sc = meta.pct    >= 70 ? "#4ade80" : meta.pct    >= 40 ? "#facc15" : "#f87171";
  const hc = meta.health >= 70 ? "#4ade80" : meta.health >= 40 ? "#facc15" : "#f87171";

  const claimRows = claims.length
    ? claims.map(c => `<div class="claim-row"><span class="cy">●</span><span class="cn">${esc(c.feature_name)}</span><span class="cd">session ${esc(c.session_id)}</span><span class="cb">${rel(c.claimed_at)}</span></div>`).join("")
    : `<div class="empty">No active claims</div>`;

  const featRows = features.map(f => {
    const cls  = f.status === "done" ? "done" : f.status === "in_progress" ? "active" : "pend";
    const icon = f.status === "done" ? "✓"   : f.status === "in_progress" ? "●"      : "○";
    return `<div class="fr ${cls}"><span class="fi">${icon}</span><span class="fn">${esc(f.name)}</span><span class="fp p-${esc(f.priority)}">${esc(f.priority)}</span><span class="fs">${esc(f.status)}</span></div>`;
  }).join("");

  const sessRows = sessions.length
    ? sessions.map(s => {
        const fc = files.filter(f => f.session_id === s.id).length;
        const dc = decisions.filter(d => d.session_id === s.id).length;
        return `<div class="sr"><span class="si">${esc(s.id)}</span><span class="sd">${s.ended_at ? "●" : "◌"}</span><span class="ss">${esc((s.summary ?? "").slice(0, 80))}</span><span class="sm">${fc} files · ${dc} dec · ${rel(s.started_at)}</span></div>`;
      }).join("")
    : `<div class="empty">No sessions yet</div>`;

  const decRows = decisions.slice(0, 10).length
    ? decisions.slice(0, 10).map(d => `<div class="dr"><span class="di">${esc(d.sess)}</span><span class="dt">${esc(d.description.slice(0, 100))}</span>${d.rationale ? `<span class="dra">${esc(d.rationale.slice(0, 80))}</span>` : ""}</div>`).join("")
    : `<div class="empty">No decisions documented yet</div>`;

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(projectName)} — groundctl</title><meta http-equiv="refresh" content="10">
<style>
:root{--bg:#0a0a0a;--b2:#111;--b3:#1a1a1a;--br:#222;--tx:#e0e0e0;--dm:#666;--md:#999;--gn:#4ade80;--yw:#facc15;--bl:#60a5fa;--rd:#f87171;--mo:"Berkeley Mono","IBM Plex Mono","Fira Code",ui-monospace,monospace}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--tx);font-family:var(--mo);font-size:13px;line-height:1.6}
.layout{display:grid;grid-template-columns:280px 1fr;min-height:100vh}
.sidebar{border-right:1px solid var(--br);padding:24px 20px;display:flex;flex-direction:column;gap:28px}
.main{padding:24px;display:flex;flex-direction:column;gap:20px;overflow:auto}
.pn{font-size:1.1rem;font-weight:700;color:#fff;margin-bottom:4px}
.pc{color:${sc};font-size:.9rem;margin-bottom:8px}
.pb{font-size:.85rem;color:var(--gn);letter-spacing:.5px;margin-bottom:4px}
.ps{font-size:.75rem;color:var(--dm)}
.hl{font-size:.7rem;color:var(--dm);text-transform:uppercase;letter-spacing:.08em}
.hs{font-size:1.8rem;font-weight:700;color:${hc}}
.hi{margin-top:10px;display:flex;flex-direction:column;gap:4px}
.hi>div{font-size:.8rem;color:var(--md);display:flex;gap:8px}
.ok{color:var(--gn)}.warn{color:var(--yw)}.bad{color:var(--rd)}
.sec{background:var(--b2);border:1px solid var(--br);border-radius:8px;overflow:hidden}
.sh{padding:10px 16px;border-bottom:1px solid var(--br);font-size:.7rem;text-transform:uppercase;letter-spacing:.1em;color:var(--dm);display:flex;justify-content:space-between}
.sc{background:var(--b3);border-radius:4px;padding:1px 6px;font-size:.7rem;color:var(--md)}
.claim-row{display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid var(--br)}
.claim-row:last-child{border-bottom:none}
.cy{color:var(--yw)}.cn{flex:1;color:#fff}.cd{color:var(--dm);font-size:.8rem}.cb{color:var(--bl);font-size:.8rem}
.fr{display:grid;grid-template-columns:20px 1fr 70px 90px;gap:8px;padding:8px 16px;border-bottom:1px solid var(--br);align-items:center}
.fr:last-child{border-bottom:none}
.done{opacity:.45}.active{background:rgba(250,204,21,.04)}
.done .fi{color:var(--gn)}.active .fi{color:var(--yw)}.pend .fi{color:var(--dm)}
.fn{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fp{font-size:.75rem;text-align:right}.fs{font-size:.75rem;color:var(--dm);text-align:right}
.p-critical{color:var(--rd)}.p-high{color:var(--yw)}.p-medium{color:var(--md)}.p-low{color:var(--dm)}
.sr{display:grid;grid-template-columns:60px 16px 1fr auto;gap:8px;padding:10px 16px;border-bottom:1px solid var(--br);align-items:start}
.sr:last-child{border-bottom:none}
.si{color:var(--bl);font-weight:600;font-size:.85rem}.sd{color:var(--gn)}.ss{color:var(--md);font-size:.8rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sm{color:var(--dm);font-size:.75rem;white-space:nowrap;text-align:right}
.dr{padding:10px 16px;border-bottom:1px solid var(--br);display:grid;grid-template-columns:50px 1fr;gap:8px}
.dr:last-child{border-bottom:none}
.di{color:var(--bl);font-size:.8rem}.dt{color:var(--tx);font-size:.8rem}.dra{grid-column:2;font-size:.75rem;color:var(--dm);font-style:italic}
.empty{padding:16px;color:var(--dm);font-size:.85rem;text-align:center}
.rn{font-size:.7rem;color:var(--dm);text-align:center;padding-top:8px}
.top{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:800px){.layout{grid-template-columns:1fr}.sidebar{border-right:none;border-bottom:1px solid var(--br)}.top{grid-template-columns:1fr}}
</style></head><body>
<div class="layout">
<aside class="sidebar">
  <div><div class="pn">${esc(projectName)}</div><div class="pc">${meta.pct}% implemented</div><div class="pb">${bar(meta.done, meta.total)}</div><div class="ps">${meta.done}/${meta.total} features done</div></div>
  <div><div class="hl">Health Score</div><div class="hs">${meta.health}<span style="font-size:1rem;color:var(--dm)">/100</span></div>
  <div class="hi">
    <div><span class="${meta.done > 0 ? "ok" : "warn"}">${meta.done > 0 ? "✓" : "⚠"}</span><span>Features ${meta.done}/${meta.total}</span></div>
    <div><span class="${meta.testFiles > 0 ? "ok" : "bad"}">${meta.testFiles > 0 ? "✓" : "✗"}</span><span>Tests ${meta.testFiles} files</span></div>
    <div><span class="${meta.decCount  > 0 ? "ok" : "warn"}">${meta.decCount  > 0 ? "✓" : "⚠"}</span><span>Decisions ${meta.decCount}</span></div>
    <div><span class="${meta.stale === 0 ? "ok" : "bad"}">${meta.stale === 0 ? "✓" : "✗"}</span><span>Claims ${meta.stale > 0 ? meta.stale + " stale" : "healthy"}</span></div>
  </div></div>
  <div class="rn">auto-refresh 10s<br><span style="color:var(--br)">${esc(dbPath.split("/").slice(-3).join("/"))}</span></div>
</aside>
<main class="main">
  <div class="sec"><div class="sh"><span>Claims live</span><span class="sc">${claims.length}</span></div>${claimRows}</div>
  <div class="top">
    <div class="sec"><div class="sh"><span>Features</span><span class="sc">${features.length}</span></div>${featRows}</div>
    <div class="sec"><div class="sh"><span>Session timeline</span><span class="sc">${sessions.length}</span></div>${sessRows}</div>
  </div>
  <div class="sec"><div class="sh"><span>Recent decisions</span><span class="sc">${decisions.length}</span></div>${decRows}</div>
</main>
</div></body></html>`;
}

// ── Command ────────────────────────────────────────────────────────────────

export async function dashboardCommand(options: { port?: string }): Promise<void> {
  const port = parseInt(options.port ?? "4242");

  const server = createServer(async (req, res) => {
    if (req.url !== "/" && req.url !== "") {
      res.writeHead(404); res.end("Not found"); return;
    }

    const dbPath = findDbPath();
    if (!dbPath) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!DOCTYPE html><html><body style="background:#0a0a0a;color:#e0e0e0;font-family:monospace;padding:40px"><h2>groundctl</h2><p style="color:#f87171">No .groundctl/db.sqlite found.</p><p>Run: <code>groundctl init</code></p></body></html>`);
      return;
    }

    try {
      const data = await readDb(dbPath);
      const name = process.cwd().split("/").pop() ?? "project";
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderHtml(data, name, dbPath));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`Error: ${(err as Error).message}`);
    }
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(chalk.bold(`\n  groundctl dashboard → `) + chalk.blue(`http://localhost:${port}`) + "\n");
    console.log(chalk.gray("  Auto-refreshes every 10s. Press Ctrl+C to stop.\n"));
    exec(`open http://localhost:${port} 2>/dev/null || xdg-open http://localhost:${port} 2>/dev/null || true`);
  });

  await new Promise<void>((_, reject) => {
    server.on("error", reject);
  });
}

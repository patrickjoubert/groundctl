import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { exec } from "node:child_process";
import { URL } from "node:url";
import chalk from "../colors.js";
import initSqlJs from "sql.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface FeatureRow {
  id: string; name: string; status: string; priority: string;
  description: string | null; group_id: number | null;
  items: string | null; progress_done: number | null; progress_total: number | null;
}
interface SessionRow  { id: string; agent: string; started_at: string; ended_at: string | null; summary: string | null; }
interface ClaimRow    { feature_id: string; feature_name: string; session_id: string; claimed_at: string; }
interface DecisionRow { id: number; session_id: string; description: string; rationale: string | null; }
interface FileRow     { id: number; session_id: string; path: string; }
interface GroupRow    { id: number; name: string; label: string; order_index: number; }
interface DepRow      { feature_id: string; depends_on_id: string; dep_name: string; dep_status: string; }

interface DbData {
  features:  FeatureRow[];
  sessions:  SessionRow[];
  claims:    ClaimRow[];
  decisions: DecisionRow[];
  files:     FileRow[];
  groups:    GroupRow[];
  deps:      DepRow[];
  meta: {
    total: number; done: number; pct: number; health: number;
    testFiles: number; decCount: number; stale: number;
    hFeatures: number; hTests: number; hArch: number; hClaims: number;
  };
}

// ── DB helpers ───────────────────────────────────────────────────────────────

export function findDbPath(startDir = process.cwd()): string | null {
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

export async function readDb(dbPath: string): Promise<DbData> {
  const SQL  = await initSqlJs();
  const buf  = readFileSync(dbPath);
  const db   = new SQL.Database(buf);

  function q<T>(sql: string, params: unknown[] = []): T[] {
    try {
      const stmt = db.prepare(sql);
      stmt.bind(params as Parameters<typeof stmt.bind>[0]);
      const rows: T[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject() as T);
      stmt.free();
      return rows;
    } catch { return []; }
  }

  interface ColInfo { name: string; }
  const featCols  = new Set(q<ColInfo>("PRAGMA table_info(features)").map(c => c.name));
  const tableSet  = new Set(q<{name:string}>("SELECT name FROM sqlite_master WHERE type='table'").map(t => t.name));

  const gSel = featCols.has("group_id")      ? ", group_id"                       : ", null as group_id";
  const iSel = featCols.has("items")          ? ", items"                          : ", null as items";
  const pSel = featCols.has("progress_done")  ? ", progress_done, progress_total"  : ", null as progress_done, null as progress_total";

  const features  = q<FeatureRow>(
    `SELECT id, name, status, priority, description${gSel}${iSel}${pSel}
     FROM features
     ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
              CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`
  );
  const sessions  = q<SessionRow>("SELECT * FROM sessions ORDER BY started_at DESC LIMIT 30");
  const claims    = q<ClaimRow>(
    `SELECT c.feature_id, f.name as feature_name, c.session_id, c.claimed_at
     FROM claims c JOIN features f ON c.feature_id = f.id WHERE c.released_at IS NULL`
  );
  const decisions = q<DecisionRow>("SELECT id, session_id, description, rationale FROM decisions ORDER BY id DESC LIMIT 50");
  const files     = q<FileRow>("SELECT id, session_id, path FROM files_modified ORDER BY id DESC LIMIT 300");
  const groups    = tableSet.has("feature_groups")
    ? q<GroupRow>("SELECT * FROM feature_groups ORDER BY order_index") : [];
  const deps      = tableSet.has("feature_dependencies") ? q<DepRow>(
    `SELECT d.feature_id, d.depends_on_id, f2.name as dep_name, f2.status as dep_status
     FROM feature_dependencies d JOIN features f2 ON f2.id = d.depends_on_id
     WHERE d.type = 'blocks'`
  ) : [];

  const total     = features.length;
  const done      = features.filter(f => f.status === "done").length;
  const pct       = total > 0 ? Math.round(done / total * 100) : 0;
  const testFiles = files.filter(f => /\.(test|spec)\./.test(f.path) || f.path.includes("__tests__")).length;
  const decCount  = decisions.length;
  const stale     = claims.filter(c => Date.now() - new Date(c.claimed_at).getTime() > 7_200_000).length;
  const hFeatures = Math.round((done / Math.max(1, total)) * 40);
  const hTests    = Math.min(20, testFiles * 5);
  const hArch     = Math.min(20, decCount * 2);
  const hClaims   = stale === 0 ? 10 : 0;
  const health    = Math.min(100, hFeatures + hTests + hArch + hClaims);

  db.close();
  return { features, sessions, claims, decisions, files, groups, deps,
           meta: { total, done, pct, health, testFiles, decCount, stale, hFeatures, hTests, hArch, hClaims } };
}

export async function claimFeatureInDb(dbPath: string, featureId: string): Promise<{ok: boolean; error?: string; featureName?: string}> {
  const SQL = await initSqlJs();
  const buf = readFileSync(dbPath);
  const db  = new SQL.Database(buf);

  function q<T>(sql: string, p: unknown[] = []): T[] {
    try {
      const stmt = db.prepare(sql);
      stmt.bind(p as Parameters<typeof stmt.bind>[0]);
      const rows: T[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject() as T);
      stmt.free();
      return rows;
    } catch { return []; }
  }

  const rows = q<FeatureRow>("SELECT id, name, status FROM features WHERE id = ? OR name = ?", [featureId, featureId]);
  if (!rows.length) { db.close(); return { ok: false, error: "Feature not found" }; }
  const feat = rows[0];
  if (feat.status === "done") { db.close(); return { ok: false, error: "Already done" }; }

  const existing = q<{c:number}>("SELECT COUNT(*) as c FROM claims WHERE feature_id = ? AND released_at IS NULL", [feat.id]);
  if ((existing[0]?.c ?? 0) > 0) { db.close(); return { ok: false, error: "Already claimed" }; }

  const sessRows = q<{id:string}>("SELECT id FROM sessions ORDER BY started_at DESC LIMIT 1");
  const sessionId = sessRows[0]?.id ?? "dashboard";

  try {
    db.run("INSERT INTO claims (feature_id, session_id, claimed_at) VALUES (?, ?, datetime('now'))", [feat.id, sessionId]);
    db.run("UPDATE features SET status = 'in_progress', updated_at = datetime('now') WHERE id = ?", [feat.id]);
    const data = db.export();
    db.close();
    writeFileSync(dbPath, Buffer.from(data));
    return { ok: true, featureName: feat.name };
  } catch (e) {
    db.close();
    return { ok: false, error: (e as Error).message };
  }
}

// ── HTML utils ───────────────────────────────────────────────────────────────

function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function rel(ts: string | null | undefined): string {
  if (!ts) return "—";
  const m = Math.floor((Date.now() - new Date(ts).getTime()) / 60_000);
  if (m <  1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function elapsed(ts: string): string {
  const m = Math.floor((Date.now() - new Date(ts).getTime()) / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60); const rm = m % 60;
  return `${h}h${rm > 0 ? rm + "m" : ""}`;
}

function statusIcon(status: string, isBlocked = false): string {
  if (status === "done")        return "✓";
  if (status === "in_progress") return "●";
  if (isBlocked)                return "⊘";
  return "○";
}

function statusColor(status: string, isBlocked = false): string {
  if (status === "done")        return "#00ff88";
  if (status === "in_progress") return "#ffaa00";
  if (isBlocked)                return "#ff4444";
  return "#888";
}

function progressBarHtml(done: number | null, total: number | null, color: string): string {
  if (!total) return "";
  const pct = Math.round(((done ?? 0) / total) * 100);
  return `<div class="pbar-track"><div class="pbar-fill" style="width:${pct}%;background:${color}"></div></div>`;
}

function groupLabel(groupId: number | null, groups: GroupRow[]): string {
  if (!groupId) return "";
  const g = groups.find(g => g.id === groupId);
  return g ? `<span class="lc-group">${esc(g.label || g.name)}</span>` : "";
}

// ── VUE LE PLAN ──────────────────────────────────────────────────────────────

function renderPlan(data: DbData): string {
  const { features, groups, deps } = data;

  const blockedIds = new Set(deps.filter(d => d.dep_status !== "done").map(d => d.feature_id));
  const depsOf     = new Map<string, DepRow[]>();
  for (const d of deps) {
    if (!depsOf.has(d.feature_id)) depsOf.set(d.feature_id, []);
    depsOf.get(d.feature_id)!.push(d);
  }

  // Group features
  const byGroup = new Map<number | null, FeatureRow[]>();
  byGroup.set(null, []);
  for (const g of groups) byGroup.set(g.id, []);
  for (const f of features) {
    const gid = f.group_id ?? null;
    if (!byGroup.has(gid)) byGroup.set(gid, []);
    byGroup.get(gid)!.push(f);
  }

  function featureCard(f: FeatureRow): string {
    const isBlocked = f.status === "pending" && blockedIds.has(f.id);
    const effStatus = isBlocked ? "blocked" : f.status;
    const icon   = statusIcon(f.status, isBlocked);
    const color  = statusColor(f.status, isBlocked);
    const fDeps  = depsOf.get(f.id) ?? [];
    const unmet  = fDeps.filter(d => d.dep_status !== "done");
    const itemArr = f.items ? f.items.split(",").map(s => s.trim()).filter(Boolean) : [];
    const pd = f.progress_done ?? 0;
    const pt = f.progress_total ?? itemArr.length;

    const popData = JSON.stringify({
      id: f.id, name: f.name, status: effStatus, priority: f.priority,
      description: f.description ?? "",
      items: itemArr,
      progress: pt > 0 ? `${pd}/${pt}` : "",
      deps: fDeps.map(d => ({ name: d.dep_name, status: d.dep_status })),
    });

    return `<div class="feat-card s-${esc(effStatus)}" onclick='showPopup(${JSON.stringify(popData)})'>
  <div class="fc-top">
    <span class="fc-icon" style="color:${color}">${icon}</span>
    <span class="fc-name">${esc(f.name)}</span>
    <span class="fc-pri p-${esc(f.priority)}">${esc(f.priority)}</span>
  </div>
  ${f.description ? `<div class="fc-desc">${esc(f.description.slice(0, 80))}</div>` : ""}
  ${pt > 0 ? `<div class="fc-prog">${progressBarHtml(pd, pt, color)}<span class="fc-pgnum">${pd}/${pt}</span></div>` : ""}
  ${unmet.length > 0 ? `<div class="fc-deps">⊘ ${unmet.map(d => `<span class="dep-tag">${esc(d.dep_name)}</span>`).join(" ")}</div>` : ""}
  ${fDeps.length > 0 && unmet.length === 0 ? `<div class="fc-deps ok">↳ ${fDeps.map(d => `<span class="dep-ok">${esc(d.dep_name)}</span>`).join(" ")}</div>` : ""}
</div>`;
  }

  const orderedGroups: Array<{id: number | null; label: string; feats: FeatureRow[]}> = [];
  for (const g of groups) {
    const feats = byGroup.get(g.id) ?? [];
    if (feats.length > 0) orderedGroups.push({ id: g.id, label: g.label || g.name, feats });
  }
  const ungrouped = byGroup.get(null) ?? [];
  if (ungrouped.length > 0) orderedGroups.push({ id: null, label: "OTHER", feats: ungrouped });

  const sections = orderedGroups.map(grp => {
    const doneCt  = grp.feats.filter(f => f.status === "done").length;
    const total   = grp.feats.length;
    const pct     = total > 0 ? Math.round(doneCt / total * 100) : 0;
    const gColor  = pct === 100 ? "#00ff88" : pct >= 50 ? "#ffaa00" : "#888";

    return `<div class="plan-group">
  <div class="pg-header">
    <span class="pg-name">${esc(grp.label)}</span>
    <div class="pg-prog"><div class="pg-bar-track"><div class="pg-bar-fill" style="width:${pct}%;background:${gColor}"></div></div></div>
    <span class="pg-count" style="color:${gColor}">${doneCt}/${total}</span>
  </div>
  <div class="feat-grid">${grp.feats.map(featureCard).join("\n")}</div>
</div>`;
  });

  const legend = `<div class="plan-legend">
  <span><span style="color:#00ff88">✓</span> done</span>
  <span class="leg-sep">·</span>
  <span><span style="color:#ffaa00">●</span> en cours</span>
  <span class="leg-sep">·</span>
  <span><span style="color:#888">○</span> disponible</span>
  <span class="leg-sep">·</span>
  <span><span style="color:#ff4444">⊘</span> bloqué</span>
  <span class="leg-sep">·</span>
  <span style="color:#555">clic sur une carte → détails + launch</span>
</div>`;

  const modal = `<div id="popup" class="popup-overlay" onclick="if(event.target===this)closePopup()">
  <div class="popup-box">
    <button class="popup-close" onclick="closePopup()">✕</button>
    <div id="popup-content"></div>
  </div>
</div>`;

  return `<div class="plan-view">${legend}${sections.join("")}${modal}</div>`;
}

// ── VUE LE CHANTIER ──────────────────────────────────────────────────────────

function renderChantier(data: DbData): string {
  const { features, claims, deps, files, groups } = data;

  const blockedIds = new Set(deps.filter(d => d.dep_status !== "done").map(d => d.feature_id));
  const pending    = features.filter(f => f.status === "pending");
  const ready      = pending.filter(f => !blockedIds.has(f.id));
  const blocked    = pending.filter(f =>  blockedIds.has(f.id));
  const isStale    = (c: ClaimRow) => Date.now() - new Date(c.claimed_at).getTime() > 7_200_000;

  // Agents en cours
  const agentsHtml = claims.length > 0
    ? claims.map(c => {
        const stale     = isStale(c);
        const el        = elapsed(c.claimed_at);
        const sessFiles = files.filter(f => f.session_id === c.session_id).length;
        return `<div class="agent-card${stale ? " stale" : ""}">
  <div class="ac-header">
    <span class="ac-dot" style="color:${stale ? "#ff4444" : "#ffaa00"}">●</span>
    <span class="ac-name">${esc(c.feature_name)}</span>
    <span class="ac-badge ${stale ? "stale" : "active"}">${stale ? "⚠ STALE" : "EN COURS"}</span>
  </div>
  <div class="ac-meta">Session <code>${esc(c.session_id.slice(0,8))}</code> · démarré il y a ${el} · ${sessFiles} fichier${sessFiles !== 1 ? "s" : ""}</div>
  ${stale ? `<div class="ac-warn">⚠ Pas d'activité depuis plus de 2h — <code>groundctl stale</code></div>` : ""}
</div>`;
      }).join("")
    : `<div class="ch-empty">Aucun agent actif</div>`;

  // Prêt à lancer
  const readyHtml = ready.length > 0
    ? `<div class="launch-grid">${ready.slice(0, 6).map(f => `<div class="launch-card">
  <div class="lc-header">
    <span style="color:#888">○</span>
    <span class="lc-name">${esc(f.name)}</span>
  </div>
  <div class="lc-meta">${`<span class="lc-pri p-${esc(f.priority)}">${esc(f.priority)}</span>`}${groupLabel(f.group_id, groups)}</div>
  <div class="lc-desc">${esc((f.description ?? "—").slice(0, 60))}</div>
  <button class="launch-btn" onclick="launchFeature('${esc(f.id)}','${esc(f.name)}',this)">▶ LAUNCH</button>
</div>`).join("")}</div>`
    : `<div class="ch-empty">${data.meta.done === data.meta.total ? "🎉 Tous les features sont done" : "Aucun feature disponible"}</div>`;

  // Bloqué
  const blockedHtml = blocked.length > 0
    ? `<div class="blocked-list">${blocked.map(f => {
        const unmet = deps.filter(d => d.feature_id === f.id && d.dep_status !== "done");
        return `<div class="blocked-row">
  <span class="br-icon">⊘</span>
  <span class="br-name">${esc(f.name)}</span>
  <span class="br-needs">nécessite : ${unmet.map(d => `<span class="br-dep">${esc(d.dep_name)}</span>`).join(", ")}</span>
</div>`;
      }).join("")}</div>`
    : "";

  // Alertes
  const staleCount = claims.filter(isStale).length;
  const alertsHtml = staleCount > 0
    ? `<div class="alert-row warn">⚠ ${staleCount} claim${staleCount > 1 ? "s" : ""} stale — <code>groundctl stale</code></div>`
    : `<div class="ch-empty ok"><span style="color:#00ff88">✓</span> Aucune alerte active</div>`;

  return `<div class="chantier-view">
<div class="ch-section">
  <div class="ch-title">AGENTS EN COURS <span class="ch-ct">${claims.length}</span></div>
  ${agentsHtml}
</div>
<div class="ch-section">
  <div class="ch-title">PRÊT À LANCER <span class="ch-ct">${ready.length}</span></div>
  ${readyHtml}
</div>
${blocked.length > 0 ? `<div class="ch-section">
  <div class="ch-title" style="color:#ff4444">BLOQUÉ <span class="ch-ct">${blocked.length}</span></div>
  ${blockedHtml}
</div>` : ""}
<div class="ch-section">
  <div class="ch-title">ALERTES</div>
  ${alertsHtml}
</div>
<div id="launch-toast" class="toast"></div>
</div>`;
}

// ── VUE LES CORPS DE MÉTIER ──────────────────────────────────────────────────

function renderMetiers(data: DbData): string {
  const { features, groups, deps, decisions, files } = data;

  const blockedIds = new Set(deps.filter(d => d.dep_status !== "done").map(d => d.feature_id));
  const depPairSet = new Set(deps.map(d => `${d.feature_id}:${d.depends_on_id}`));

  const byGroup = new Map<number | null, FeatureRow[]>();
  byGroup.set(null, []);
  for (const g of groups) byGroup.set(g.id, []);
  for (const f of features) {
    const gid = f.group_id ?? null;
    if (!byGroup.has(gid)) byGroup.set(gid, []);
    byGroup.get(gid)!.push(f);
  }

  const orderedGroups: Array<{id: number | null; label: string; feats: FeatureRow[]}> = [];
  for (const g of groups) {
    const feats = byGroup.get(g.id) ?? [];
    if (feats.length > 0) orderedGroups.push({ id: g.id, label: g.label || g.name, feats });
  }
  const ungrouped = byGroup.get(null) ?? [];
  if (ungrouped.length > 0) orderedGroups.push({ id: null, label: "OTHER", feats: ungrouped });

  const sections = orderedGroups.map(grp => {
    if (grp.feats.length === 0) return "";
    const doneCt  = grp.feats.filter(f => f.status === "done").length;
    const total   = grp.feats.length;
    const pct     = total > 0 ? Math.round(doneCt / total * 100) : 0;
    const gColor  = pct === 100 ? "#00ff88" : pct >= 50 ? "#ffaa00" : "#888";

    const available = grp.feats.filter(f => f.status === "pending" && !blockedIds.has(f.id));

    // Find parallel pairs
    const parallelPairs: [FeatureRow, FeatureRow][] = [];
    outer: for (let i = 0; i < available.length; i++) {
      for (let j = i + 1; j < available.length; j++) {
        const a = available[i], b = available[j];
        if (!depPairSet.has(`${a.id}:${b.id}`) && !depPairSet.has(`${b.id}:${a.id}`)) {
          parallelPairs.push([a, b]);
          if (parallelPairs.length >= 2) break outer;
        }
      }
    }

    const featRows = grp.feats.map(f => {
      const isBlocked = f.status === "pending" && blockedIds.has(f.id);
      const effStatus = isBlocked ? "blocked" : f.status;
      const icon  = statusIcon(f.status, isBlocked);
      const col   = statusColor(f.status, isBlocked);
      const pd = f.progress_done ?? 0;
      const pt = f.progress_total ?? 0;

      return `<div class="mt-feat-row">
  <span class="mt-icon" style="color:${col}">${icon}</span>
  <span class="mt-name s-${esc(effStatus)}">${esc(f.name)}</span>
  <div class="mt-bar">${pt > 0 ? progressBarHtml(pd, pt, col) : ""}</div>
  <span class="mt-desc">${esc((f.description ?? "").slice(0, 50))}</span>
  ${f.status !== "done" && !isBlocked ? `<button class="mt-launch" onclick="launchFeature('${esc(f.id)}','${esc(f.name)}',this)">▶</button>` : `<span></span>`}
</div>`;
    }).join("");

    const parallelHtml = parallelPairs.length > 0
      ? `<div class="mt-parallel">
  <span class="mt-para-label">Runs en // :</span>
  ${parallelPairs.map(([a,b]) => `
  <div class="mt-para-pair">
    <button class="launch-btn-sm" onclick="launchFeature('${esc(a.id)}','${esc(a.name)}',this)">▶ ${esc(a.name)}</button>
    <span style="color:#555">+</span>
    <button class="launch-btn-sm" onclick="launchFeature('${esc(b.id)}','${esc(b.name)}',this)">▶ ${esc(b.name)}</button>
  </div>`).join("")}
</div>`
      : doneCt === total
        ? `<div class="mt-parallel ok"><span style="color:#00ff88">✓</span> Corps de métier complet</div>`
        : available.length === 0
          ? `<div class="mt-parallel dim">Runs en // : aucun disponible</div>`
          : `<div class="mt-parallel dim">Runs en // : un seul feature disponible</div>`;

    return `<div class="metier-card">
  <div class="mc-header">
    <span class="mc-name">${esc(grp.label)}</span>
    <div class="mc-prog"><div class="mc-bar-track"><div class="mc-bar-fill" style="width:${pct}%;background:${gColor}"></div></div></div>
    <span class="mc-count" style="color:${gColor}">${doneCt}/${total} done &nbsp; ${pct}%</span>
  </div>
  <div class="mt-feats">${featRows}</div>
  ${parallelHtml}
</div>`;
  }).filter(Boolean);

  return `<div class="metiers-view">
${sections.join("\n")}
<div id="launch-toast" class="toast"></div>
</div>`;
}

// ── CSS ──────────────────────────────────────────────────────────────────────

const CSS = `
:root {
  --bg:#0d0d0d; --b2:#111; --b3:#161616; --b4:#1a1a1a;
  --br:#1e1e1e; --br2:#2a2a2a;
  --tx:#e0e0e0; --md:#888; --dm:#555;
  --gn:#00ff88; --yw:#ffaa00; --rd:#ff4444; --bl:#4488ff;
  --mo:'Courier New',monospace;
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;background:var(--bg);color:var(--tx);font-family:var(--mo);font-size:14px;line-height:1.6}
a{color:inherit;text-decoration:none}
button{cursor:pointer;font-family:var(--mo);font-size:14px;border:none}
code{font-family:var(--mo);font-size:13px}

/* Topbar */
.topbar{display:flex;align-items:center;border-bottom:1px solid var(--br);background:#0a0a0a;position:sticky;top:0;z-index:100;height:48px;padding-right:24px}
.tabs{display:flex;height:100%}
.tab{padding:0 24px;height:48px;display:flex;align-items:center;font-size:14px;letter-spacing:.06em;color:var(--md);border-bottom:2px solid transparent;transition:color .15s}
.tab:hover{color:var(--tx)}
.tab.active{color:var(--gn);border-bottom-color:var(--gn)}
.topbar-right{margin-left:auto;display:flex;align-items:center;gap:20px;font-size:14px}
.tb-proj{color:var(--md)}
.tb-pct{font-weight:700}

/* View */
.view{padding:28px 32px;min-height:calc(100vh - 48px)}

/* Progress bar */
.pbar-track{flex:1;height:5px;background:var(--br2);border-radius:3px;overflow:hidden}
.pbar-fill{height:100%;border-radius:3px;transition:width .3s}

/* ─── LE PLAN ─── */
.plan-view{display:flex;flex-direction:column;gap:32px}
.plan-legend{display:flex;gap:16px;align-items:center;flex-wrap:wrap;font-size:14px;color:var(--md);padding-bottom:12px;border-bottom:1px solid var(--br)}
.leg-sep{color:var(--dm)}
.plan-group{display:flex;flex-direction:column;gap:14px}
.pg-header{display:flex;align-items:center;gap:16px}
.pg-name{font-size:15px;font-weight:700;color:#fff;letter-spacing:.06em;text-transform:uppercase;min-width:170px}
.pg-prog{flex:1;max-width:200px}
.pg-bar-track{height:4px;background:var(--br2);border-radius:2px;overflow:hidden}
.pg-bar-fill{height:100%;border-radius:2px}
.pg-count{font-size:14px;color:var(--md)}
.feat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}
.feat-card{background:var(--b2);border:1px solid var(--br);border-radius:8px;padding:18px;cursor:pointer;transition:border-color .15s,background .15s;display:flex;flex-direction:column;gap:9px}
.feat-card:hover{border-color:var(--br2);background:var(--b3)}
.feat-card.s-done{border-color:rgba(0,255,136,.12)}
.feat-card.s-in_progress{border-color:rgba(255,170,0,.3);background:rgba(255,170,0,.03)}
.feat-card.s-blocked{border-color:rgba(255,68,68,.2)}
.fc-top{display:flex;align-items:center;gap:10px}
.fc-icon{font-size:16px;width:20px;text-align:center}
.fc-name{flex:1;font-size:14px;font-weight:700;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fc-pri{font-size:12px;padding:1px 7px;border-radius:3px}
.p-critical{color:#ff4444;background:rgba(255,68,68,.1)}
.p-high{color:#ffaa00;background:rgba(255,170,0,.1)}
.p-medium{color:var(--md);background:var(--br)}
.p-low{color:var(--dm);background:var(--br)}
.fc-desc{font-size:14px;color:var(--md);line-height:1.5}
.fc-prog{display:flex;align-items:center;gap:10px}
.fc-pgnum{font-size:13px;color:var(--md);white-space:nowrap}
.fc-deps{font-size:13px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.fc-deps.ok{color:var(--dm)}
.dep-tag{color:#ff4444;background:rgba(255,68,68,.1);padding:1px 6px;border-radius:3px;font-size:12px}
.dep-ok{color:var(--dm)}

/* Popup */
.popup-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.82);z-index:1000;align-items:center;justify-content:center}
.popup-overlay.open{display:flex}
.popup-box{background:#111;border:1px solid var(--br2);border-radius:10px;padding:28px;min-width:420px;max-width:580px;max-height:82vh;overflow-y:auto;position:relative}
.popup-close{position:absolute;top:16px;right:18px;background:none;border:none;color:var(--dm);font-size:16px;cursor:pointer}
.popup-close:hover{color:var(--tx)}
.popup-name{font-size:18px;font-weight:700;color:#fff;margin-bottom:14px}
.popup-meta{display:flex;gap:14px;margin-bottom:14px;font-size:14px}
.popup-section{margin-top:16px}
.popup-slabel{font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:var(--dm);margin-bottom:6px}
.popup-text{font-size:14px;color:var(--md);line-height:1.6}
.popup-item{font-size:14px;color:var(--md);padding:3px 0}
.popup-item::before{content:"· ";color:var(--dm)}
.popup-cmd{margin-top:18px;padding:12px 14px;background:var(--b4);border-radius:6px;border:1px solid var(--br);font-size:13px;color:var(--md)}
.popup-launch-btn{display:inline-flex;align-items:center;gap:8px;margin-top:14px;padding:10px 20px;background:rgba(0,255,136,.1);border:1px solid rgba(0,255,136,.3);border-radius:6px;color:var(--gn);font-size:14px;font-weight:700;font-family:var(--mo)}
.popup-launch-btn:hover{background:rgba(0,255,136,.2)}
.popup-launch-btn:disabled{opacity:.4;cursor:not-allowed}

/* ─── LE CHANTIER ─── */
.chantier-view{display:flex;flex-direction:column;gap:28px}
.ch-section{display:flex;flex-direction:column;gap:14px}
.ch-title{font-size:14px;letter-spacing:.1em;text-transform:uppercase;color:var(--dm);display:flex;align-items:center;gap:10px;padding-bottom:10px;border-bottom:1px solid var(--br)}
.ch-ct{background:var(--br2);color:var(--md);padding:1px 7px;border-radius:3px;font-size:13px;letter-spacing:0}
.ch-empty{font-size:14px;color:var(--dm);padding:8px 0}
.ch-empty.ok{color:var(--md)}
.agent-card{background:var(--b2);border:1px solid var(--br);border-radius:8px;padding:18px;display:flex;flex-direction:column;gap:8px}
.agent-card.stale{border-color:rgba(255,68,68,.35);background:rgba(255,68,68,.04)}
.ac-header{display:flex;align-items:center;gap:12px}
.ac-dot{font-size:18px}
.ac-name{flex:1;font-size:16px;font-weight:700;color:#fff}
.ac-badge{padding:2px 10px;border-radius:4px;font-size:13px}
.ac-badge.active{color:#ffaa00;background:rgba(255,170,0,.12);border:1px solid rgba(255,170,0,.3)}
.ac-badge.stale{color:#ff4444;background:rgba(255,68,68,.12);border:1px solid rgba(255,68,68,.3)}
.ac-meta{font-size:14px;color:var(--md)}
.ac-meta code{color:var(--bl)}
.ac-warn{font-size:14px;color:#ff4444}
.ac-warn code{color:var(--md)}
.launch-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}
.launch-card{background:var(--b2);border:1px solid var(--br);border-radius:8px;padding:18px;display:flex;flex-direction:column;gap:10px}
.lc-header{display:flex;align-items:center;gap:10px}
.lc-name{flex:1;font-size:15px;font-weight:700;color:#fff}
.lc-meta{display:flex;gap:10px;align-items:center;font-size:13px}
.lc-group{color:var(--dm);background:var(--br);padding:1px 6px;border-radius:3px}
.lc-desc{font-size:14px;color:var(--md)}
.launch-btn{margin-top:4px;padding:10px 18px;background:rgba(0,255,136,.1);border:1px solid rgba(0,255,136,.3);border-radius:6px;color:var(--gn);font-size:14px;font-weight:700;font-family:var(--mo);align-self:flex-start;transition:background .15s}
.launch-btn:hover{background:rgba(0,255,136,.2)}
.launch-btn:disabled{opacity:.4;cursor:not-allowed}
.blocked-list{display:flex;flex-direction:column;gap:10px}
.blocked-row{display:flex;align-items:center;gap:12px;background:var(--b2);border:1px solid rgba(255,68,68,.15);border-radius:8px;padding:14px 16px;font-size:14px}
.br-icon{color:#ff4444;font-size:16px}
.br-name{font-weight:700;color:#fff;min-width:200px}
.br-needs{color:var(--md);display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.br-dep{color:#ff4444}
.alert-row{padding:14px 18px;border-radius:8px;font-size:14px}
.alert-row.warn{color:#ffaa00;background:rgba(255,170,0,.07);border:1px solid rgba(255,170,0,.2)}
.alert-row.warn code{color:var(--md)}

/* ─── LES CORPS DE MÉTIER ─── */
.metiers-view{display:flex;flex-direction:column;gap:24px}
.metier-card{background:var(--b2);border:1px solid var(--br);border-radius:10px;overflow:hidden}
.mc-header{display:flex;align-items:center;gap:16px;padding:16px 20px;background:var(--b4);border-bottom:1px solid var(--br)}
.mc-name{font-size:16px;font-weight:700;color:#fff;text-transform:uppercase;letter-spacing:.06em;min-width:180px}
.mc-prog{flex:1;max-width:240px}
.mc-bar-track{height:5px;background:var(--br2);border-radius:3px;overflow:hidden}
.mc-bar-fill{height:100%;border-radius:3px}
.mc-count{font-size:14px;font-weight:600}
.mt-feats{display:flex;flex-direction:column}
.mt-feat-row{display:grid;grid-template-columns:26px 1fr 160px auto 44px;gap:12px;align-items:center;padding:12px 20px;border-bottom:1px solid var(--br);font-size:14px}
.mt-feat-row:last-child{border-bottom:none}
.mt-icon{font-size:15px;text-align:center}
.mt-name{font-weight:600;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mt-name.s-done{color:var(--md);opacity:.7}
.mt-name.s-blocked{color:#ff4444}
.mt-bar{display:flex;align-items:center}
.mt-desc{font-size:13px;color:var(--dm);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mt-launch{padding:5px 10px;background:rgba(0,255,136,.08);border:1px solid rgba(0,255,136,.25);border-radius:4px;color:var(--gn);font-size:13px;font-family:var(--mo)}
.mt-launch:hover{background:rgba(0,255,136,.16)}
.mt-launch:disabled{opacity:.4;cursor:not-allowed}
.mt-parallel{padding:14px 20px;border-top:1px solid var(--br);display:flex;align-items:center;gap:14px;flex-wrap:wrap;font-size:14px}
.mt-parallel.dim{color:var(--dm)}
.mt-parallel.ok{color:var(--md)}
.mt-para-label{color:var(--dm);font-size:13px}
.mt-para-pair{display:flex;align-items:center;gap:10px}
.launch-btn-sm{padding:6px 12px;background:rgba(0,255,136,.08);border:1px solid rgba(0,255,136,.25);border-radius:4px;color:var(--gn);font-size:13px;font-family:var(--mo)}
.launch-btn-sm:hover{background:rgba(0,255,136,.16)}
.launch-btn-sm:disabled{opacity:.4;cursor:not-allowed}

/* Toast */
.toast{position:fixed;bottom:24px;right:24px;background:#111;border:1px solid var(--br2);border-radius:8px;padding:14px 20px;font-size:14px;color:var(--tx);box-shadow:0 4px 24px rgba(0,0,0,.6);transform:translateY(80px);opacity:0;transition:transform .25s,opacity .25s;z-index:500;min-width:280px;pointer-events:none}
.toast.show{transform:translateY(0);opacity:1}

/* Footer */
.footer{padding:12px 32px;border-top:1px solid var(--br);font-size:13px;color:var(--dm);display:flex;justify-content:space-between}

@media(max-width:900px){
  .feat-grid,.launch-grid{grid-template-columns:1fr}
  .mt-feat-row{grid-template-columns:26px 1fr 44px}
  .mt-bar,.mt-desc{display:none}
}`;

// ── JS ───────────────────────────────────────────────────────────────────────

const JS = `
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function statusColor(s){return s==='done'?'#00ff88':s==='in_progress'?'#ffaa00':s==='blocked'?'#ff4444':'#888'}
function statusIcon(s){return s==='done'?'✓':s==='in_progress'?'●':s==='blocked'?'⊘':'○'}

function showPopup(jsonStr){
  const d=JSON.parse(jsonStr);
  const el=document.getElementById('popup-content');
  const col=statusColor(d.status);
  let h='<div class="popup-name">'+esc(d.name)+'</div>';
  h+='<div class="popup-meta"><span style="color:'+col+'">'+statusIcon(d.status)+' '+d.status+'</span><span style="color:#555">·</span><span style="color:#888">'+esc(d.priority)+'</span>';
  if(d.progress)h+='<span style="color:#555">·</span><span style="color:#888">'+esc(d.progress)+'</span>';
  h+='</div>';
  if(d.description)h+='<div class="popup-section"><div class="popup-slabel">Description</div><div class="popup-text">'+esc(d.description)+'</div></div>';
  if(d.items&&d.items.length>0){
    h+='<div class="popup-section"><div class="popup-slabel">Items</div>';
    d.items.forEach(function(i){h+='<div class="popup-item">'+esc(i)+'</div>';});
    h+='</div>';
  }
  if(d.deps&&d.deps.length>0){
    h+='<div class="popup-section"><div class="popup-slabel">Dépendances</div>';
    d.deps.forEach(function(dep){h+='<div style="font-size:14px;color:'+statusColor(dep.status)+';padding:3px 0">'+statusIcon(dep.status)+' '+esc(dep.name)+'</div>';});
    h+='</div>';
  }
  if(d.status!=='done'){
    h+='<button class="popup-launch-btn" id="popup-launch-btn" onclick="launchFeature('+JSON.stringify(d.id)+','+JSON.stringify(d.name)+',this)">▶ LAUNCH</button>';
  }
  h+='<div class="popup-cmd">groundctl claim "'+esc(d.name)+'"</div>';
  el.innerHTML=h;
  document.getElementById('popup').classList.add('open');
}
function closePopup(){document.getElementById('popup').classList.remove('open')}
document.addEventListener('keydown',function(e){if(e.key==='Escape')closePopup();});

function showToast(msg,isErr){
  const t=document.getElementById('launch-toast');
  if(!t)return;
  t.textContent=msg;
  t.style.borderColor=isErr?'rgba(255,68,68,.4)':'rgba(0,255,136,.4)';
  t.classList.add('show');
  setTimeout(function(){t.classList.remove('show');},3500);
}

async function launchFeature(id,name,btn){
  if(btn){btn.textContent='…';btn.disabled=true;}
  try{
    const r=await fetch('/api/claim',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({featureId:id})});
    const data=await r.json();
    if(data.ok){
      showToast('✓ "'+name+'" claimed — lancez claude dans le terminal');
      closePopup();
      setTimeout(function(){location.reload();},900);
    }else{
      showToast('✗ '+(data.error||'Erreur'),true);
      if(btn){btn.textContent='▶ LAUNCH';btn.disabled=false;}
    }
  }catch(e){
    showToast('✗ Erreur réseau',true);
    if(btn){btn.textContent='▶ LAUNCH';btn.disabled=false;}
  }
}

setInterval(function(){location.reload();},5000);
`;

// ── renderHtml ───────────────────────────────────────────────────────────────

function renderHtml(data: DbData, projectName: string, dbPath: string, view: string): string {
  const isPlan     = view === "plan";
  const isChantier = view === "chantier";
  const isMetiers  = !isPlan && !isChantier;

  const pColor = data.meta.pct    >= 70 ? "#00ff88" : data.meta.pct    >= 40 ? "#ffaa00" : "#ff4444";
  const hColor = data.meta.health >= 70 ? "#00ff88" : data.meta.health >= 40 ? "#ffaa00" : "#ff4444";

  const topbar = `<header class="topbar">
  <nav class="tabs">
    <a class="tab ${isPlan     ? "active" : ""}" href="?view=plan">LE PLAN</a>
    <a class="tab ${isChantier ? "active" : ""}" href="?view=chantier">LE CHANTIER</a>
    <a class="tab ${isMetiers  ? "active" : ""}" href="?view=metiers">LES CORPS DE MÉTIER</a>
  </nav>
  <div class="topbar-right">
    <span class="tb-proj">${esc(projectName)}</span>
    <span class="tb-pct" style="color:${pColor}">${data.meta.pct}%</span>
    <span style="color:${hColor};font-size:14px">⬡ ${data.meta.health}/100</span>
  </div>
</header>`;

  const content = isPlan     ? renderPlan(data)
                : isChantier ? renderChantier(data)
                :              renderMetiers(data);

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(projectName)} — groundctl</title>
<style>${CSS}</style>
</head>
<body>
${topbar}
<div class="view">${content}</div>
<div class="footer">
  <span>${esc(dbPath.split("/").slice(-3).join("/"))}</span>
  <span>auto-refresh 5s · ${data.meta.total} features · ${data.sessions.length} sessions</span>
</div>
<script>${JS}</script>
</body>
</html>`;
}

// ── Command ───────────────────────────────────────────────────────────────────

export async function dashboardCommand(options: { port?: string }): Promise<void> {
  const port = parseInt(options.port ?? "4242");

  const server = createServer(async (req, res) => {
    const reqUrl = new URL(req.url ?? "/", `http://localhost:${port}`);
    const dbPath = findDbPath();

    // POST /api/claim
    if (req.method === "POST" && reqUrl.pathname === "/api/claim") {
      res.setHeader("Content-Type", "application/json");
      if (!dbPath) { res.writeHead(404); res.end(JSON.stringify({ok:false,error:"No DB"})); return; }
      const chunks: Buffer[] = [];
      req.on("data", c => chunks.push(c));
      req.on("end", async () => {
        try {
          const body   = JSON.parse(Buffer.concat(chunks).toString());
          const result = await claimFeatureInDb(dbPath, body.featureId ?? body.feature ?? "");
          res.writeHead(result.ok ? 200 : 400);
          res.end(JSON.stringify(result));
        } catch (e) {
          res.writeHead(400);
          res.end(JSON.stringify({ok:false,error:(e as Error).message}));
        }
      });
      return;
    }

    if (reqUrl.pathname !== "/" && reqUrl.pathname !== "") {
      res.writeHead(404); res.end("Not found"); return;
    }

    const view = reqUrl.searchParams.get("view") ?? "plan";

    if (!dbPath) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><html><body style="background:#0d0d0d;color:#e0e0e0;font-family:'Courier New',monospace;padding:48px;font-size:14px">
        <h2 style="color:#00ff88">groundctl</h2>
        <p style="color:#ff4444;margin-top:16px">No .groundctl/db.sqlite found.</p>
        <p style="margin-top:12px;color:#555">Run: <code style="color:#e0e0e0">groundctl init</code></p>
      </body></html>`);
      return;
    }

    try {
      const data = await readDb(dbPath);
      const name = dbPath.split("/").slice(-3, -2)[0] ?? process.cwd().split("/").pop() ?? "project";
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderHtml(data, name, dbPath, view));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`Error: ${(err as Error).message}`);
    }
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(chalk.bold(`\n  groundctl dashboard v3\n`));
    console.log(`  ${chalk.green("LE PLAN")}           ${chalk.blue(`http://localhost:${port}?view=plan`)}`);
    console.log(`  ${chalk.yellow("LE CHANTIER")}      ${chalk.blue(`http://localhost:${port}?view=chantier`)}`);
    console.log(`  ${chalk.cyan("LES CORPS DE MÉTIER")} ${chalk.blue(`http://localhost:${port}?view=metiers`)}\n`);
    console.log(chalk.gray("  Auto-refresh 5s. Ctrl+C to stop.\n"));
    exec(`open "http://localhost:${port}?view=plan" 2>/dev/null || xdg-open "http://localhost:${port}?view=plan" 2>/dev/null || true`);
  });

  await new Promise<void>((_, reject) => { server.on("error", reject); });
}

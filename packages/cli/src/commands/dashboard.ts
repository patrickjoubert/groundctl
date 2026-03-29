import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { exec } from "node:child_process";
import { URL } from "node:url";
import chalk from "chalk";
import initSqlJs from "sql.js";

// ── DB types ────────────────────────────────────────────────────────────────

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

async function readDb(dbPath: string): Promise<DbData> {
  const SQL  = await initSqlJs();
  const buf  = readFileSync(dbPath);
  const db   = new SQL.Database(buf);

  function q<T>(sql: string, params: unknown[] = []): T[] {
    const stmt = db.prepare(sql);
    stmt.bind(params as Parameters<typeof stmt.bind>[0]);
    const rows: T[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject() as T);
    stmt.free();
    return rows;
  }

  // Detect available columns (graceful compat with older DBs)
  interface ColInfo { name: string; }
  const featCols = new Set(q<ColInfo>("PRAGMA table_info(features)").map(c => c.name));
  const hasTables = new Set(q<{name: string}>("SELECT name FROM sqlite_master WHERE type='table'").map(t => t.name));

  const groupSel = featCols.has("group_id") ? ", group_id" : ", null as group_id";
  const itemsSel = featCols.has("items") ? ", items" : ", null as items";
  const progSel  = (featCols.has("progress_done") && featCols.has("progress_total"))
    ? ", progress_done, progress_total" : ", null as progress_done, null as progress_total";

  const features  = q<FeatureRow>(
    `SELECT id, name, status, priority, description${groupSel}${itemsSel}${progSel}
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
  const files     = q<FileRow>("SELECT id, session_id, path FROM files_modified ORDER BY id DESC LIMIT 200");
  const groups    = hasTables.has("feature_groups")
    ? q<GroupRow>("SELECT * FROM feature_groups ORDER BY order_index") : [];
  const deps      = hasTables.has("feature_dependencies") ? q<DepRow>(
    `SELECT d.feature_id, d.depends_on_id, f2.name as dep_name, f2.status as dep_status
     FROM feature_dependencies d
     JOIN features f2 ON f2.id = d.depends_on_id
     WHERE d.type = 'blocks'`
  ) : [];

  const total      = features.length;
  const done       = features.filter(f => f.status === "done").length;
  const pct        = total > 0 ? Math.round(done / total * 100) : 0;
  const testFiles  = files.filter(f => /\.(test|spec)\./.test(f.path) || f.path.includes("__tests__")).length;
  const decCount   = decisions.length;
  const stale      = claims.filter(c => Date.now() - new Date(c.claimed_at).getTime() > 86_400_000).length;
  const hFeatures  = Math.round((done / Math.max(1, total)) * 40);
  const hTests     = Math.min(20, testFiles * 5);
  const hArch      = Math.min(20, decCount * 2);
  const hClaims    = stale === 0 ? 10 : 0;
  const health     = Math.min(100, hFeatures + hTests + hArch + hClaims);

  db.close();
  return { features, sessions, claims, decisions, files, groups, deps,
           meta: { total, done, pct, health, testFiles, decCount, stale, hFeatures, hTests, hArch, hClaims } };
}

// ── Shared utils ─────────────────────────────────────────────────────────────

function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function rel(ts: string | null | undefined): string {
  if (!ts) return "—";
  const m = Math.floor((Date.now() - new Date(ts).getTime()) / 60_000);
  if (m <  1)  return "just now";
  if (m < 60)  return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function bar(done: number, total: number, w = 24): string {
  const n = total > 0 ? Math.round((done / total) * w) : 0;
  return "█".repeat(n) + "░".repeat(w - n);
}

function miniBar(score: number, max: number, w = 12): string {
  const n = Math.round((score / max) * w);
  return "█".repeat(n) + "░".repeat(w - n);
}

function statusIcon(status: string): string {
  if (status === "done")        return "✓";
  if (status === "in_progress") return "●";
  if (status === "blocked")     return "⊘";
  return "○";
}

function statusClass(status: string): string {
  if (status === "done")        return "s-done";
  if (status === "in_progress") return "s-active";
  if (status === "blocked")     return "s-blocked";
  return "s-pending";
}

// ── VUE NOW ──────────────────────────────────────────────────────────────────

function renderNow(data: DbData, projectName: string): string {
  const { features, sessions, claims, deps, meta } = data;

  // Compute ready / blocked for action zone
  const blockedIds = new Set(deps.filter(d => d.dep_status !== "done").map(d => d.feature_id));
  const pending    = features.filter(f => f.status === "pending");
  const ready      = pending.filter(f => !blockedIds.has(f.id)).slice(0, 5);
  const blocked    = pending.filter(f =>  blockedIds.has(f.id)).slice(0, 5);
  // Next recommended = first ready
  const next       = ready[0] ?? null;

  const pColor  = meta.pct    >= 70 ? "#00ff88" : meta.pct    >= 40 ? "#ffaa00" : "#ff4444";
  const hColor  = meta.health >= 70 ? "#00ff88" : meta.health >= 40 ? "#ffaa00" : "#ff4444";

  // ── Left column ────────────────────────────────────────────────────
  const leftHtml = `
    <div class="now-left">
      <div class="project-name">${esc(projectName)}</div>
      <div class="pct-label" style="color:${pColor}">${meta.pct}% implemented</div>
      <div class="prog-bar" style="color:${pColor}">${bar(meta.done, meta.total, 28)}</div>
      <div class="prog-sub">${meta.done} / ${meta.total} features done</div>

      <div class="stat-grid">
        <div class="stat-row"><span class="stat-label">Sessions</span><span class="stat-val">${sessions.length}</span></div>
        <div class="stat-row"><span class="stat-label">Last session</span><span class="stat-val">${rel(sessions[0]?.started_at)}</span></div>
        <div class="stat-row"><span class="stat-label">Active claims</span><span class="stat-val" style="color:${claims.length > 0 ? "#ffaa00" : "#555"}">${claims.length}</span></div>
        <div class="stat-row"><span class="stat-label">Arch decisions</span><span class="stat-val">${meta.decCount}</span></div>
      </div>

      <div class="health-block">
        <div class="section-label">HEALTH SCORE</div>
        <div class="health-score" style="color:${hColor}">${meta.health}<span class="health-max">/100</span></div>
        <div class="health-bars">
          <div class="hbar-row">
            <span class="hbar-label">Features</span>
            <span class="hbar-track" style="color:${meta.hFeatures >= 28 ? "#00ff88" : "#ffaa00"}">${miniBar(meta.hFeatures, 40)}</span>
            <span class="hbar-score">${meta.hFeatures}/40</span>
          </div>
          <div class="hbar-row">
            <span class="hbar-label">Tests</span>
            <span class="hbar-track" style="color:${meta.hTests >= 10 ? "#00ff88" : "#ff4444"}">${miniBar(meta.hTests, 20)}</span>
            <span class="hbar-score">${meta.hTests}/20</span>
          </div>
          <div class="hbar-row">
            <span class="hbar-label">Arch log</span>
            <span class="hbar-track" style="color:${meta.hArch >= 10 ? "#00ff88" : "#ffaa00"}">${miniBar(meta.hArch, 20)}</span>
            <span class="hbar-score">${meta.hArch}/20</span>
          </div>
          <div class="hbar-row">
            <span class="hbar-label">Claims</span>
            <span class="hbar-track" style="color:${meta.hClaims === 10 ? "#00ff88" : "#ff4444"}">${miniBar(meta.hClaims, 10)}</span>
            <span class="hbar-score">${meta.hClaims}/10</span>
          </div>
        </div>
      </div>
    </div>`;

  // ── Right column ───────────────────────────────────────────────────
  const inProgressHtml = claims.length
    ? claims.map(c => {
        const elapsed = Math.floor((Date.now() - new Date(c.claimed_at).getTime()) / 60_000);
        const elStr   = elapsed < 60 ? `${elapsed}m` : `${Math.floor(elapsed/60)}h ${elapsed%60}m`;
        const isStale = elapsed > 1440;
        return `<div class="az-row">
          <span class="az-icon" style="color:#ffaa00">●</span>
          <span class="az-name">${esc(c.feature_name)}</span>
          <span class="az-meta">${esc(c.session_id.slice(0,8))}</span>
          <span class="az-time" style="color:${isStale ? "#ff4444" : "#555"}">${elStr}</span>
        </div>`;
      }).join("")
    : `<div class="az-empty">No active claims</div>`;

  const readyHtml = ready.length
    ? ready.map((f, i) => `<div class="az-row">
        <span class="az-icon" style="color:${i === 0 ? "#00ff88" : "#444"}">○</span>
        <span class="az-name">${esc(f.name)}</span>
        <span class="az-pri p-${esc(f.priority)}">${esc(f.priority)}</span>
      </div>`).join("")
    : `<div class="az-empty">Nothing pending</div>`;

  const blockedHtml = blocked.length
    ? blocked.map(f => {
        const unmet = deps.filter(d => d.feature_id === f.id && d.dep_status !== "done");
        return `<div class="az-row">
          <span class="az-icon" style="color:#ff4444">⊘</span>
          <span class="az-name">${esc(f.name)}</span>
          <span class="az-needs">needs: ${unmet.map(d => esc(d.dep_name)).join(", ")}</span>
        </div>`;
      }).join("")
    : `<div class="az-empty">No blocked features</div>`;

  const nextHtml = next
    ? `<div class="next-box">
        <span style="color:#00ff88">→</span>
        <span class="next-name">${esc(next.name)}</span>
        <span class="next-hint">groundctl claim "${esc(next.name)}"</span>
      </div>`
    : `<div class="az-empty">${meta.done === meta.total ? "All features done 🎉" : "Nothing available"}</div>`;

  const rightHtml = `
    <div class="now-right">
      <div class="az-section">
        <div class="az-title">IN PROGRESS <span class="az-count">${claims.length}</span></div>
        ${inProgressHtml}
      </div>
      <div class="az-section">
        <div class="az-title">READY TO BUILD <span class="az-count">${ready.length}</span></div>
        ${readyHtml}
      </div>
      ${blocked.length > 0 ? `<div class="az-section">
        <div class="az-title" style="color:#ff4444">BLOCKED <span class="az-count">${blocked.length}</span></div>
        ${blockedHtml}
      </div>` : ""}
      <div class="az-section">
        <div class="az-title" style="color:#00ff88">NEXT RECOMMENDED</div>
        ${nextHtml}
      </div>
    </div>`;

  return `<div class="now-layout">${leftHtml}${rightHtml}</div>`;
}

// ── VUE PLAN ─────────────────────────────────────────────────────────────────

function renderPlan(data: DbData): string {
  const { features, groups, deps } = data;

  // Build dep maps
  const depsOf = new Map<string, string[]>(); // feature_id → depends_on_ids
  const rdepsOf = new Map<string, string[]>(); // feature_id → feature_ids that depend on it
  for (const d of deps) {
    if (!depsOf.has(d.feature_id)) depsOf.set(d.feature_id, []);
    depsOf.get(d.feature_id)!.push(d.depends_on_id);
    if (!rdepsOf.has(d.depends_on_id)) rdepsOf.set(d.depends_on_id, []);
    rdepsOf.get(d.depends_on_id)!.push(d.feature_id);
  }

  // Find blocked features (for legend display)
  const blockedIds = new Set(
    deps.filter(d => d.dep_status !== "done").map(d => d.feature_id)
  );

  // Group features
  const byGroup = new Map<number | null, FeatureRow[]>();
  byGroup.set(null, []);
  for (const g of groups) byGroup.set(g.id, []);
  for (const f of features) {
    const gid = f.group_id ?? null;
    if (!byGroup.has(gid)) byGroup.set(gid, []);
    byGroup.get(gid)!.push(f);
  }

  function nodeHtml(f: FeatureRow): string {
    const icon   = statusIcon(f.status === "pending" && blockedIds.has(f.id) ? "blocked" : f.status);
    const cls    = statusClass(f.status === "pending" && blockedIds.has(f.id) ? "blocked" : f.status);
    const itemsArr = f.items ? f.items.split(",").map(s => s.trim()).filter(Boolean) : [];
    const prog   = (f.progress_done != null && f.progress_total != null)
      ? `${f.progress_done}/${f.progress_total}` : "";
    const dataDesc  = esc(f.description ?? "");
    const dataItems = esc(itemsArr.join(" · ") ?? "");
    const dataDeps  = esc((depsOf.get(f.id) ?? []).join(","));
    return `<span class="dag-node ${cls}" onclick="showPopup(${JSON.stringify(JSON.stringify({
      id: f.id, name: f.name, status: f.status, priority: f.priority,
      description: f.description ?? "", items: itemsArr, progress: prog,
      deps: (depsOf.get(f.id) ?? [])
    }))})" title="${dataDesc || esc(f.name)}">${icon} ${esc(f.name)}</span>`;
  }

  // Build chain rows using topological sort within each group
  function buildRows(feats: FeatureRow[]): string[][] {
    if (feats.length === 0) return [];
    const ids = new Set(feats.map(f => f.id));

    // Compute in-degree within group
    const inDeg = new Map<string, number>();
    for (const f of feats) inDeg.set(f.id, 0);
    for (const d of deps) {
      if (ids.has(d.feature_id) && ids.has(d.depends_on_id)) {
        inDeg.set(d.feature_id, (inDeg.get(d.feature_id) ?? 0) + 1);
      }
    }

    // Roots
    const roots = feats.filter(f => (inDeg.get(f.id) ?? 0) === 0);
    if (roots.length === 0) return [feats.map(f => f.id)]; // cycle fallback

    // BFS chains from each root
    const visited = new Set<string>();
    const chains: string[][] = [];

    for (const root of roots) {
      if (visited.has(root.id)) continue;
      const chain: string[] = [];
      let cur: string | null = root.id;
      while (cur && ids.has(cur) && !visited.has(cur)) {
        visited.add(cur);
        chain.push(cur);
        const children = (rdepsOf.get(cur) ?? []).filter(id => ids.has(id) && !visited.has(id));
        cur = children.length === 1 ? children[0] : null;
        // If multiple children, start new chains for them later
        if (children.length > 1) {
          for (const c of children.slice(1)) {
            if (!visited.has(c)) roots.push(feats.find(f => f.id === c)!);
          }
        }
      }
      if (chain.length > 0) chains.push(chain);
    }

    // Catch any unvisited
    const remaining = feats.filter(f => !visited.has(f.id));
    if (remaining.length > 0) {
      // pack into rows of 4
      for (let i = 0; i < remaining.length; i += 4) {
        chains.push(remaining.slice(i, i + 4).map(f => f.id));
      }
    }

    return chains;
  }

  const sections: string[] = [];
  const featById = new Map(features.map(f => [f.id, f]));

  const orderedGroups: Array<{ id: number | null; label: string; feats: FeatureRow[] }> = [];
  for (const g of groups) {
    const feats = byGroup.get(g.id) ?? [];
    if (feats.length > 0) orderedGroups.push({ id: g.id, label: g.label || g.name, feats });
  }
  const ungrouped = byGroup.get(null) ?? [];
  if (ungrouped.length > 0) orderedGroups.push({ id: null, label: "OTHER", feats: ungrouped });

  for (const grp of orderedGroups) {
    const chains = buildRows(grp.feats);
    const chainHtml = chains.map(chain => {
      const nodes = chain
        .map(id => featById.get(id))
        .filter(Boolean) as FeatureRow[];
      // Check if consecutive nodes actually have a dep relationship
      const parts: string[] = [];
      for (let i = 0; i < nodes.length; i++) {
        parts.push(nodeHtml(nodes[i]));
        if (i < nodes.length - 1) {
          const hasDep = (rdepsOf.get(nodes[i].id) ?? []).includes(nodes[i+1].id);
          parts.push(`<span class="dag-arrow">${hasDep ? "→" : "  "}</span>`);
        }
      }
      return `<div class="dag-chain">${parts.join("")}</div>`;
    }).join("");

    const doneCount = grp.feats.filter(f => f.status === "done").length;
    sections.push(`
      <div class="dag-group">
        <div class="dag-group-header">
          <span class="dag-group-name">${esc(grp.label)}</span>
          <span class="dag-group-meta">${doneCount}/${grp.feats.length} done</span>
        </div>
        <div class="dag-chains">${chainHtml}</div>
      </div>`);
  }

  const legend = `
    <div class="dag-legend">
      <span class="s-done">✓ done</span>
      <span class="dag-sep">·</span>
      <span class="s-active">● in progress</span>
      <span class="dag-sep">·</span>
      <span class="s-pending">○ ready</span>
      <span class="dag-sep">·</span>
      <span class="s-blocked">⊘ blocked</span>
      <span class="dag-sep">·</span>
      <span style="color:#555">→ depends on</span>
      <span class="dag-sep">·</span>
      <span style="color:#555;font-size:.8rem">click node for details</span>
    </div>`;

  const modal = `
    <div id="popup" class="popup-overlay" onclick="if(event.target===this)closePopup()">
      <div class="popup-box">
        <div class="popup-close" onclick="closePopup()">✕</div>
        <div id="popup-content"></div>
      </div>
    </div>`;

  return `<div class="plan-wrap">${legend}${sections.join("")}${modal}</div>`;
}

// ── VUE HEALTH ───────────────────────────────────────────────────────────────

function renderHealth(data: DbData, projectName: string): string {
  const { features, sessions, decisions, files, meta } = data;

  const hColor  = meta.health >= 70 ? "#00ff88" : meta.health >= 40 ? "#ffaa00" : "#ff4444";

  // Recommendations
  const recs: string[] = [];
  if (meta.hTests < 10)    recs.push("Add test files — only " + meta.testFiles + " test file(s) detected. Target ≥4 for full score.");
  if (meta.hArch < 10)     recs.push("Log architecture decisions. " + meta.decCount + " entries found. Target ≥10 for full score.");
  if (meta.stale > 0)      recs.push(`Release ${meta.stale} stale claim(s) (older than 24h) to free up the feature backlog.`);
  if (meta.pct < 70)       recs.push(`${meta.total - meta.done} features still pending. Run \`groundctl next\` to pick the next one.`);
  if (sessions.length < 5) recs.push("Log more sessions. Run `groundctl ingest` after each agent session.");
  if (recs.length === 0)   recs.push("All systems nominal. Ship it. 🚀");

  // Debt tracker
  const staleDebt  = meta.stale;
  const testDebt   = Math.max(0, 4 - meta.testFiles);
  const archDebt   = Math.max(0, 10 - meta.decCount);
  const pendDebt   = features.filter(f => f.status === "pending").length;

  // Session timeline (last 10)
  const recentSessions = sessions.slice(0, 10);
  const sessionRows = recentSessions.map(s => {
    const fCount = files.filter(f => f.session_id === s.id).length;
    const dCount = decisions.filter(d => d.session_id === s.id).length;
    const dur    = s.ended_at
      ? Math.floor((new Date(s.ended_at).getTime() - new Date(s.started_at).getTime()) / 60_000)
      : null;
    const durStr = dur != null ? (dur < 60 ? `${dur}m` : `${Math.floor(dur/60)}h${dur%60}m`) : "active";
    const isDone = !!s.ended_at;
    return `<div class="tl-row">
      <span class="tl-id">${esc(s.id.slice(0,8))}</span>
      <span class="tl-dot" style="color:${isDone ? "#00ff88" : "#ffaa00"}">${isDone ? "●" : "◌"}</span>
      <span class="tl-sum">${esc((s.summary ?? "—").slice(0, 70))}</span>
      <span class="tl-meta">${fCount}f · ${dCount}d · ${durStr}</span>
      <span class="tl-time">${rel(s.started_at)}</span>
    </div>`;
  }).join("");

  const scoreBar = (label: string, score: number, max: number, color: string) => {
    const pct = Math.round((score / max) * 100);
    return `<div class="sb-row">
      <span class="sb-label">${esc(label)}</span>
      <div class="sb-track">
        <div class="sb-fill" style="width:${pct}%;background:${color}"></div>
      </div>
      <span class="sb-score" style="color:${color}">${score}<span class="sb-max">/${max}</span></span>
    </div>`;
  };

  const fColor = meta.hFeatures >= 28 ? "#00ff88" : "#ffaa00";
  const tColor = meta.hTests    >= 10 ? "#00ff88" : "#ff4444";
  const aColor = meta.hArch     >= 10 ? "#00ff88" : "#ffaa00";
  const cColor = meta.hClaims   === 10 ? "#00ff88" : "#ff4444";

  return `<div class="health-wrap">
    <div class="health-top">
      <div class="ht-score-block">
        <div class="ht-label">HEALTH SCORE</div>
        <div class="ht-score" style="color:${hColor}">${meta.health}<span class="ht-max">/100</span></div>
        <div class="ht-project">${esc(projectName)}</div>
      </div>
      <div class="ht-bars">
        ${scoreBar("Features (40)", meta.hFeatures, 40, fColor)}
        ${scoreBar("Tests (20)", meta.hTests, 20, tColor)}
        ${scoreBar("Arch log (20)", meta.hArch, 20, aColor)}
        ${scoreBar("Claims (10)", meta.hClaims, 10, cColor)}
        ${scoreBar("Deploy (10)", 0, 10, "#555")}
      </div>
    </div>

    <div class="health-mid">
      <div class="debt-block">
        <div class="section-label">DEBT TRACKER</div>
        <div class="debt-grid">
          <div class="debt-row"><span class="debt-icon" style="color:${staleDebt > 0 ? "#ff4444" : "#00ff88"}">${staleDebt > 0 ? "✗" : "✓"}</span><span class="debt-label">Stale claims</span><span class="debt-val">${staleDebt}</span></div>
          <div class="debt-row"><span class="debt-icon" style="color:${testDebt > 0 ? "#ffaa00" : "#00ff88"}">${testDebt > 0 ? "⚠" : "✓"}</span><span class="debt-label">Missing test files</span><span class="debt-val">${testDebt}</span></div>
          <div class="debt-row"><span class="debt-icon" style="color:${archDebt > 0 ? "#ffaa00" : "#00ff88"}">${archDebt > 0 ? "⚠" : "✓"}</span><span class="debt-label">Arch decisions needed</span><span class="debt-val">${archDebt}</span></div>
          <div class="debt-row"><span class="debt-icon" style="color:${pendDebt > 5 ? "#ffaa00" : "#00ff88"}">${pendDebt > 5 ? "⚠" : "✓"}</span><span class="debt-label">Features pending</span><span class="debt-val">${pendDebt}</span></div>
        </div>
      </div>
      <div class="rec-block">
        <div class="section-label">RECOMMENDATIONS</div>
        <ol class="rec-list">
          ${recs.map(r => `<li>${esc(r)}</li>`).join("")}
        </ol>
      </div>
    </div>

    <div class="tl-block">
      <div class="section-label">SESSION TIMELINE <span style="color:#555;font-size:.8rem">(last ${recentSessions.length})</span></div>
      <div class="tl-rows">${sessionRows || '<div class="az-empty">No sessions yet</div>'}</div>
    </div>
  </div>`;
}

// ── Main HTML wrapper ─────────────────────────────────────────────────────────

function renderHtml(data: DbData, projectName: string, dbPath: string, view: string): string {
  const viewNow    = view === "now";
  const viewPlan   = view === "plan";
  const viewHealth = view === "health";

  const tabBar = `
    <nav class="tabs">
      <a class="tab ${viewNow    ? "active" : ""}" href="?view=now">NOW</a>
      <a class="tab ${viewPlan   ? "active" : ""}" href="?view=plan">PLAN</a>
      <a class="tab ${viewHealth ? "active" : ""}" href="?view=health">HEALTH</a>
      <span class="tab-right">
        <span class="tab-proj">${esc(projectName)}</span>
        <span class="tab-ver">groundctl</span>
      </span>
    </nav>`;

  const content = viewPlan   ? renderPlan(data)
                : viewHealth ? renderHealth(data, projectName)
                :              renderNow(data, projectName);

  const css = `
:root{
  --bg:#0d0d0d;--b2:#111;--b3:#161616;--br:#1e1e1e;--br2:#2a2a2a;
  --tx:#e0e0e0;--dm:#555;--md:#888;
  --gn:#00ff88;--yw:#ffaa00;--rd:#ff4444;--bl:#4488ff;
  --mo:'Courier New',monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;background:var(--bg);color:var(--tx);font-family:var(--mo);font-size:13px;line-height:1.55}
a{color:inherit;text-decoration:none}

/* ── Tabs ── */
.tabs{display:flex;align-items:center;border-bottom:1px solid var(--br);padding:0 24px;height:44px;gap:0;background:#0a0a0a;position:sticky;top:0;z-index:100}
.tab{padding:0 18px;height:44px;display:flex;align-items:center;font-size:.8rem;letter-spacing:.12em;color:var(--md);border-bottom:2px solid transparent;cursor:pointer;transition:color .15s}
.tab:hover{color:var(--tx)}
.tab.active{color:var(--gn);border-bottom-color:var(--gn)}
.tab-right{margin-left:auto;display:flex;align-items:center;gap:16px;font-size:.75rem;color:var(--dm)}
.tab-proj{color:var(--md)}

/* ── Main content area ── */
.view{padding:28px 32px;min-height:calc(100vh - 44px)}

/* ── NOW view ── */
.now-layout{display:grid;grid-template-columns:360px 1fr;gap:32px;align-items:start}
.project-name{font-size:1.4rem;font-weight:700;color:#fff;margin-bottom:6px}
.pct-label{font-size:1rem;margin-bottom:8px}
.prog-bar{font-size:.9rem;letter-spacing:1px;margin-bottom:4px}
.prog-sub{font-size:.8rem;color:var(--md);margin-bottom:24px}
.stat-grid{display:flex;flex-direction:column;gap:6px;margin-bottom:24px;padding:14px 16px;background:var(--b2);border:1px solid var(--br);border-radius:6px}
.stat-row{display:flex;justify-content:space-between;font-size:.82rem}
.stat-label{color:var(--md)}
.stat-val{color:var(--tx)}
.health-block{padding:16px;background:var(--b2);border:1px solid var(--br);border-radius:6px}
.section-label{font-size:.68rem;letter-spacing:.12em;text-transform:uppercase;color:var(--dm);margin-bottom:10px}
.health-score{font-size:2.6rem;font-weight:700;margin:4px 0 14px}
.health-max{font-size:1.2rem;color:var(--dm)}
.health-bars{display:flex;flex-direction:column;gap:6px}
.hbar-row{display:flex;align-items:center;gap:8px;font-size:.8rem}
.hbar-label{width:58px;color:var(--md);font-size:.75rem}
.hbar-track{letter-spacing:1px;font-size:.7rem}
.hbar-score{color:var(--md);font-size:.75rem;margin-left:2px}

/* ── Action zone (right column) ── */
.now-right{display:flex;flex-direction:column;gap:16px}
.az-section{background:var(--b2);border:1px solid var(--br);border-radius:6px;overflow:hidden}
.az-title{padding:8px 14px;font-size:.68rem;letter-spacing:.12em;text-transform:uppercase;color:var(--dm);border-bottom:1px solid var(--br);background:var(--bg);display:flex;align-items:center;gap:8px}
.az-count{background:var(--br2);color:var(--md);padding:1px 6px;border-radius:3px;font-size:.7rem;letter-spacing:0}
.az-row{display:flex;align-items:center;gap:10px;padding:9px 14px;border-bottom:1px solid var(--br);font-size:.85rem}
.az-row:last-child{border-bottom:none}
.az-icon{font-size:.9rem;width:16px;text-align:center}
.az-name{flex:1;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.az-meta{color:var(--dm);font-size:.78rem}
.az-time{font-size:.78rem}
.az-needs{font-size:.78rem;color:#ff4444}
.az-pri{font-size:.75rem}
.az-empty{padding:12px 14px;color:var(--dm);font-size:.82rem}
.next-box{padding:12px 14px;display:flex;align-items:center;gap:10px}
.next-name{font-size:.95rem;color:#fff;font-weight:600}
.next-hint{font-size:.75rem;color:var(--dm);margin-left:4px}
.p-critical{color:#ff4444}.p-high{color:#ffaa00}.p-medium{color:var(--md)}.p-low{color:var(--dm)}

/* ── PLAN view ── */
.plan-wrap{display:flex;flex-direction:column;gap:28px}
.dag-legend{font-size:.8rem;color:var(--md);display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:8px}
.dag-sep{color:var(--dm)}
.dag-group{background:var(--b2);border:1px solid var(--br);border-radius:6px;overflow:hidden}
.dag-group-header{padding:9px 16px;border-bottom:1px solid var(--br);background:var(--bg);display:flex;align-items:center;gap:12px}
.dag-group-name{font-size:.7rem;letter-spacing:.1em;text-transform:uppercase;color:var(--md)}
.dag-group-meta{font-size:.7rem;color:var(--dm)}
.dag-chains{padding:16px;display:flex;flex-direction:column;gap:10px}
.dag-chain{display:flex;align-items:center;flex-wrap:wrap;gap:4px}
.dag-node{padding:4px 10px;border:1px solid var(--br2);border-radius:3px;font-size:.82rem;cursor:pointer;transition:border-color .15s,background .15s}
.dag-node:hover{border-color:var(--md);background:var(--b3)}
.dag-arrow{color:var(--dm);padding:0 4px;font-size:.9rem}
.s-done{color:#00ff88}.s-active{color:#ffaa00}.s-pending{color:var(--md)}.s-blocked{color:#ff4444}
.dag-node.s-done{border-color:rgba(0,255,136,.15)}
.dag-node.s-active{border-color:rgba(255,170,0,.3);background:rgba(255,170,0,.04)}
.dag-node.s-blocked{border-color:rgba(255,68,68,.2)}

/* ── Popup modal ── */
.popup-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:1000;align-items:center;justify-content:center}
.popup-overlay.open{display:flex}
.popup-box{background:#111;border:1px solid var(--br2);border-radius:8px;padding:24px;min-width:380px;max-width:560px;position:relative;max-height:80vh;overflow-y:auto}
.popup-close{position:absolute;top:14px;right:16px;color:var(--dm);cursor:pointer;font-size:1rem}
.popup-close:hover{color:var(--tx)}
.popup-name{font-size:1rem;font-weight:700;color:#fff;margin-bottom:12px}
.popup-meta{display:flex;gap:12px;margin-bottom:12px;font-size:.8rem}
.popup-section{margin-top:12px}
.popup-slabel{font-size:.68rem;text-transform:uppercase;letter-spacing:.1em;color:var(--dm);margin-bottom:4px}
.popup-text{font-size:.85rem;color:var(--md);line-height:1.6}
.popup-item{font-size:.82rem;color:var(--md);padding:2px 0}
.popup-item::before{content:"· ";color:var(--dm)}

/* ── HEALTH view ── */
.health-wrap{display:flex;flex-direction:column;gap:24px}
.health-top{display:grid;grid-template-columns:200px 1fr;gap:32px;background:var(--b2);border:1px solid var(--br);border-radius:6px;padding:24px}
.ht-label{font-size:.68rem;letter-spacing:.12em;text-transform:uppercase;color:var(--dm);margin-bottom:8px}
.ht-score{font-size:3.5rem;font-weight:700;line-height:1}
.ht-max{font-size:1.5rem;color:var(--dm)}
.ht-project{font-size:.82rem;color:var(--md);margin-top:8px}
.ht-bars{display:flex;flex-direction:column;gap:14px;justify-content:center}
.sb-row{display:flex;align-items:center;gap:12px}
.sb-label{width:110px;font-size:.82rem;color:var(--md)}
.sb-track{flex:1;height:4px;background:var(--br2);border-radius:2px;overflow:hidden}
.sb-fill{height:100%;border-radius:2px;transition:width .3s}
.sb-score{width:50px;text-align:right;font-size:.82rem}
.sb-max{color:var(--dm)}
.health-mid{display:grid;grid-template-columns:1fr 1fr;gap:24px}
.debt-block,.rec-block{background:var(--b2);border:1px solid var(--br);border-radius:6px;padding:16px}
.debt-grid{display:flex;flex-direction:column;gap:8px}
.debt-row{display:flex;align-items:center;gap:8px;font-size:.85rem}
.debt-icon{width:16px;text-align:center}
.debt-label{flex:1;color:var(--md)}
.debt-val{color:var(--tx);text-align:right}
.rec-list{list-style:none;display:flex;flex-direction:column;gap:8px}
.rec-list li{font-size:.83rem;color:var(--md);padding-left:16px;position:relative;line-height:1.5}
.rec-list li::before{content:counter(li-counter) ".";counter-increment:li-counter;position:absolute;left:0;color:var(--gn)}
.rec-list{counter-reset:li-counter}
.tl-block{background:var(--b2);border:1px solid var(--br);border-radius:6px;padding:16px}
.tl-rows{display:flex;flex-direction:column;gap:2px;margin-top:8px}
.tl-row{display:grid;grid-template-columns:70px 14px 1fr 100px 80px;gap:8px;padding:7px 8px;border-radius:4px;font-size:.8rem;align-items:center}
.tl-row:hover{background:var(--b3)}
.tl-id{color:var(--bl);font-weight:600;font-size:.75rem}
.tl-dot{font-size:.7rem}
.tl-sum{color:var(--md);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tl-meta{color:var(--dm);font-size:.75rem;text-align:right}
.tl-time{color:var(--dm);font-size:.75rem;text-align:right}

/* ── Footer ── */
.footer{padding:12px 32px;border-top:1px solid var(--br);font-size:.72rem;color:var(--dm);display:flex;justify-content:space-between}

@media(max-width:900px){
  .now-layout{grid-template-columns:1fr}
  .health-top{grid-template-columns:1fr}
  .health-mid{grid-template-columns:1fr}
}`;

  const js = `
function showPopup(jsonStr) {
  const d = JSON.parse(jsonStr);
  const el = document.getElementById('popup-content');
  const si = (s) => s === 'done' ? '✓' : s === 'in_progress' ? '●' : s === 'blocked' ? '⊘' : '○';
  const sc = (s) => s === 'done' ? '#00ff88' : s === 'in_progress' ? '#ffaa00' : s === 'blocked' ? '#ff4444' : '#888';
  let h = '<div class="popup-name">' + esc(d.name) + '</div>';
  h += '<div class="popup-meta">';
  h += '<span style="color:' + sc(d.status) + '">' + si(d.status) + ' ' + d.status + '</span>';
  h += '<span style="color:#555">·</span>';
  h += '<span style="color:#888">' + d.priority + '</span>';
  if (d.progress) h += '<span style="color:#555">·</span><span style="color:#888">' + esc(d.progress) + '</span>';
  h += '</div>';
  if (d.description) {
    h += '<div class="popup-section"><div class="popup-slabel">Description</div><div class="popup-text">' + esc(d.description) + '</div></div>';
  }
  if (d.items && d.items.length > 0) {
    h += '<div class="popup-section"><div class="popup-slabel">Items</div>';
    d.items.forEach(function(item) { h += '<div class="popup-item">' + esc(item) + '</div>'; });
    h += '</div>';
  }
  if (d.deps && d.deps.length > 0) {
    h += '<div class="popup-section"><div class="popup-slabel">Depends on</div><div class="popup-text">' + d.deps.map(esc).join(', ') + '</div></div>';
  }
  h += '<div class="popup-section" style="margin-top:16px"><code style="font-size:.8rem;color:#555">groundctl claim "' + esc(d.name) + '"</code></div>';
  el.innerHTML = h;
  document.getElementById('popup').classList.add('open');
}
function closePopup() { document.getElementById('popup').classList.remove('open'); }
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
document.addEventListener('keydown', function(e) { if (e.key === 'Escape') closePopup(); });
setInterval(function() { location.reload(); }, 10000);`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(projectName)} — groundctl dashboard</title>
<style>${css}</style>
</head>
<body>
${tabBar}
<div class="view">${content}</div>
<div class="footer">
  <span>${esc(dbPath.split("/").slice(-3).join("/"))}</span>
  <span>auto-refresh 10s · ${data.meta.total} features · ${data.sessions.length} sessions</span>
</div>
<script>${js}</script>
</body>
</html>`;
}

// ── Command ───────────────────────────────────────────────────────────────────

export async function dashboardCommand(options: { port?: string }): Promise<void> {
  const port = parseInt(options.port ?? "4242");

  const server = createServer(async (req, res) => {
    const reqUrl = new URL(req.url ?? "/", `http://localhost:${port}`);

    if (reqUrl.pathname !== "/" && reqUrl.pathname !== "") {
      res.writeHead(404); res.end("Not found"); return;
    }

    const view   = reqUrl.searchParams.get("view") ?? "now";
    const dbPath = findDbPath();

    if (!dbPath) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><html><body style="background:#0d0d0d;color:#e0e0e0;font-family:'Courier New',monospace;padding:48px">
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
      res.end(`Error reading database: ${(err as Error).message}`);
    }
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(chalk.bold(`\n  groundctl dashboard v2\n`));
    console.log(`  ${chalk.dim("NOW")}  ${chalk.blue(`http://localhost:${port}?view=now`)}`);
    console.log(`  ${chalk.dim("PLAN")} ${chalk.blue(`http://localhost:${port}?view=plan`)}`);
    console.log(`  ${chalk.dim("HLTH")} ${chalk.blue(`http://localhost:${port}?view=health`)}\n`);
    console.log(chalk.gray("  Auto-refreshes every 10s. Press Ctrl+C to stop.\n"));
    exec(`open http://localhost:${port}?view=now 2>/dev/null || xdg-open http://localhost:${port}?view=now 2>/dev/null || true`);
  });

  await new Promise<void>((_, reject) => {
    server.on("error", reject);
  });
}

import { readFileSync } from "node:fs";
import type {
  ParsedSession,
  ParsedFile,
  ParsedCommit,
  ParsedDecision,
  ParsedPlannedFeature,
} from "./types.js";

// ── Codex JSONL raw types ────────────────────────────────────────────────────

interface CodexLine {
  timestamp?: string;
  type: string;
  payload: Record<string, unknown>;
}

interface CodexSessionMeta {
  id: string;
  cwd: string;
  timestamp?: string;
}

interface CodexContentBlock {
  type: string;
  text?: string;    // output_text / input_text
  name?: string;    // function_call / custom_tool_call
  arguments?: string; // function_call (JSON string)
  input?: string;   // custom_tool_call (patch text)
  output?: string;  // function_call_output
}

// ── Decision detection (mirrors claude-parser logic) ─────────────────────────

const DECISION_PATTERNS = [
  /\bI(?:'m going to| decided| chose| picked| went with| opted for)\b(.{10,120})/i,
  /\bgoing with\b(.{5,100})/i,
  /\bchose?\s+(\w[\w\s-]+)\s+(?:over|instead of|rather than)\b(.{0,80})/i,
  /\btradeoff[:\s]+(.{10,120})/i,
  /\bdecision[:\s]+(.{10,120})/i,
  /\brationale[:\s]+(.{10,120})/i,
  /\bbecause\s+(.{10,100})\s+(?:—|\.)/i,
  /\bswitched?\s+(?:from\s+\S+\s+)?to\s+(.{5,80})\s+(?:—|because|since|for)/i,
];

const SKIP_DECISION_PHRASES = new Set([
  "i decided to read",
  "i decided to check",
  "i decided to look",
  "i'm going to read",
  "i'm going to check",
  "i'm going to look",
  "i'm going to run",
  "i'm going to use",
]);

function clean(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .replace(/^[.,;:\-—\s]+/, "")
    .replace(/[.,;:\-—\s]+$/, "")
    .trim();
}

function extractRationale(text: string): string | null {
  const match = text.match(/^[^.!?]*(?:because|since|—|:)\s*([^.!?\n]{15,120})/i);
  if (match) return clean(match[1]);
  const first = text.split(/[.!?\n]/)[0]?.trim();
  if (first && first.length > 15 && first.length < 120 && !first.match(/^(Let|I |Now|Next|This )/)) {
    return clean(first);
  }
  return null;
}

function extractDecisions(text: string, decisions: ParsedDecision[]): void {
  for (const pattern of DECISION_PATTERNS) {
    const matches = text.matchAll(new RegExp(pattern.source, "gi"));
    for (const m of matches) {
      const raw = m[1]?.trim() ?? "";
      if (raw.length < 10 || raw.length > 200) continue;

      const lower = raw.toLowerCase();
      if (SKIP_DECISION_PHRASES.has(lower.slice(0, 30))) continue;
      if (lower.startsWith("the ") && lower.length < 20) continue;
      if (/^(it|this|that|to |the file|a |an )/.test(lower) && lower.length < 25) continue;

      const matchIndex = m.index ?? 0;
      const surrounding = text.slice(
        Math.max(0, matchIndex + m[0].length),
        Math.min(text.length, matchIndex + m[0].length + 200)
      );
      const rationale = extractRationale(surrounding);
      decisions.push({
        description: clean(raw),
        rationale,
        confidence: rationale ? "high" : "low",
      });
      if (decisions.length >= 20) return;
    }
  }
}

function extractCommitMessage(cmd: string): string | null {
  const heredocMatch = cmd.match(/git commit -m "\$\(cat <<'EOF'\n([\s\S]+?)\nEOF/);
  if (heredocMatch) return heredocMatch[1].split("\n")[0].trim();

  const simpleMatch = cmd.match(/git commit -m ["']([^"']+)["']/);
  if (simpleMatch) return simpleMatch[1].trim();

  const mMatch = cmd.match(/git commit.*?-m\s+"([^"]+)"/);
  if (mMatch) return mMatch[1].trim();

  return null;
}

// ── apply_patch file path extraction ─────────────────────────────────────────

/**
 * Parse a Codex apply_patch payload to extract the file paths being modified.
 * Format:
 *   *** Begin Patch
 *   *** Update File: /path/to/file
 *   *** Add File: /path/to/new-file
 *   *** Delete File: /path/to/old-file
 */
function parsePatchPaths(
  patchInput: string,
  projectPath: string | undefined
): ParsedFile[] {
  const files: ParsedFile[] = [];
  const updateRe = /^\*\*\* Update File: (.+)$/m;
  const addRe    = /^\*\*\* Add File: (.+)$/m;
  const deleteRe = /^\*\*\* Delete File: (.+)$/m;

  for (const m of patchInput.matchAll(new RegExp(updateRe.source, "gm"))) {
    files.push({ path: relativePath(m[1].trim(), projectPath), operation: "modified", linesChanged: 0 });
  }
  for (const m of patchInput.matchAll(new RegExp(addRe.source, "gm"))) {
    files.push({ path: relativePath(m[1].trim(), projectPath), operation: "created", linesChanged: 0 });
  }
  for (const m of patchInput.matchAll(new RegExp(deleteRe.source, "gm"))) {
    files.push({ path: relativePath(m[1].trim(), projectPath), operation: "deleted", linesChanged: 0 });
  }
  return files;
}

function relativePath(abs: string, projectPath?: string): string {
  if (!projectPath) return abs;
  if (abs.startsWith(projectPath)) return abs.slice(projectPath.length).replace(/^\//, "");
  return abs;
}

// ── Main parser ───────────────────────────────────────────────────────────────

/**
 * Parse a Codex JSONL transcript file.
 * Returns null when the session does not belong to projectPath.
 */
export function parseCodexTranscript(
  transcriptPath: string,
  projectPath?: string
): ParsedSession | null {
  const raw = readFileSync(transcriptPath, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim());

  const parsed: CodexLine[] = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line) as CodexLine);
    } catch {
      // skip malformed lines
    }
  }

  // ── Session meta ──────────────────────────────────────────────────────────
  const metaLine = parsed.find((l) => l.type === "session_meta");
  if (!metaLine) return null;

  const meta = metaLine.payload as CodexSessionMeta;
  const sessionId  = meta.id ?? transcriptPath.split("/").pop()?.replace(".jsonl", "") ?? "unknown";
  const sessionCwd = meta.cwd ?? "";

  // Project match: if projectPath provided, verify the session cwd matches
  if (projectPath && sessionCwd !== projectPath) return null;

  // Collect timestamps
  const timestamps: string[] = [];
  for (const entry of parsed) {
    if (entry.timestamp) timestamps.push(entry.timestamp);
  }
  const startedAt = timestamps[0] ?? new Date().toISOString();
  const endedAt   = timestamps[timestamps.length - 1] ?? new Date().toISOString();

  const filesMap  = new Map<string, ParsedFile>();
  const commits:  ParsedCommit[]          = [];
  const decisions: ParsedDecision[]       = [];
  const plannedFeatureMap = new Map<string, ParsedPlannedFeature>();
  let   lastAssistantText = "";

  for (const entry of parsed) {
    // ── event_msg: agent_message ────────────────────────────────────────────
    if (entry.type === "event_msg") {
      const epayload = entry.payload as { type?: string; message?: string };
      if (epayload.type === "agent_message" && typeof epayload.message === "string") {
        const text = epayload.message;
        if (text.length > 20) {
          lastAssistantText = text;
          extractDecisions(text, decisions);
        }
      }
      continue;
    }

    // ── response_item ────────────────────────────────────────────────────────
    if (entry.type !== "response_item") continue;
    const rpayload = entry.payload as { type?: string; role?: string; content?: CodexContentBlock[]; name?: string; arguments?: string; input?: string };

    // Assistant text message
    if (rpayload.type === "message" && rpayload.role === "assistant") {
      for (const block of rpayload.content ?? []) {
        if (block.type === "output_text" && block.text) {
          const text = block.text;
          if (text.length > 20) {
            lastAssistantText = text;
            extractDecisions(text, decisions);
          }
        }
      }
    }

    // function_call: exec_command (shell) — extract git commits + bash file ops
    if (rpayload.type === "function_call" && rpayload.name === "exec_command") {
      const args = rpayload.arguments ?? (entry.payload as { arguments?: string }).arguments;
      if (args) {
        try {
          const parsed_args = JSON.parse(args) as { cmd?: string };
          const cmd = parsed_args.cmd ?? "";

          // Git commits
          if (cmd.includes("git commit")) {
            const msg = extractCommitMessage(cmd);
            if (msg) commits.push({ message: msg, command: cmd.slice(0, 100) });
          }

          // Shell rm
          const rmMatches = cmd.matchAll(/\brm\s+(?:-[rf]+\s+)?([^\s;&|]+\.[a-zA-Z0-9]+)/g);
          for (const m of rmMatches) {
            const rel = relativePath(m[1], projectPath);
            filesMap.set(rel, { path: rel, operation: "deleted", linesChanged: 0 });
          }
        } catch {
          // ignore invalid JSON args
        }
      }
    }

    // custom_tool_call: apply_patch — extract modified/added/deleted files
    if (rpayload.type === "custom_tool_call" && rpayload.name === "apply_patch") {
      const patchInput = (entry.payload as { input?: string }).input ?? "";
      if (patchInput) {
        for (const pf of parsePatchPaths(patchInput, projectPath)) {
          const existing = filesMap.get(pf.path);
          if (existing) {
            existing.linesChanged += pf.linesChanged;
          } else {
            filesMap.set(pf.path, pf);
          }
        }
      }
    }
  }

  // Deduplicate decisions
  const seenDecisions = new Set<string>();
  const uniqueDecisions = decisions.filter((d) => {
    const key = d.description.slice(0, 40).toLowerCase();
    if (seenDecisions.has(key)) return false;
    seenDecisions.add(key);
    return true;
  });

  const summary = buildSummary(
    sessionId,
    filesMap.size,
    commits.length,
    uniqueDecisions.length,
    lastAssistantText
  );

  return {
    sessionId,
    startedAt,
    endedAt,
    filesModified: Array.from(filesMap.values()),
    commits,
    decisions: uniqueDecisions,
    plannedFeatures: Array.from(plannedFeatureMap.values()),
    summary,
    agent: "codex",
  };
}

/**
 * Read only the first line of a JSONL file and return the cwd
 * from session_meta (or null if not found / doesn't match format).
 * Used for lightweight project-match check before full parse.
 */
export function readCodexSessionCwd(filePath: string): string | null {
  try {
    const buf = readFileSync(filePath);
    const nl  = buf.indexOf(10); // newline byte
    const firstLine = nl === -1 ? buf.toString() : buf.slice(0, nl).toString();
    const line = JSON.parse(firstLine) as CodexLine;
    if (line.type === "session_meta") {
      return (line.payload as CodexSessionMeta).cwd ?? null;
    }
  } catch {
    // empty file or malformed
  }
  return null;
}

function buildSummary(
  sessionId: string,
  fileCount: number,
  commitCount: number,
  decisionCount: number,
  lastText: string
): string {
  const firstLine = lastText.split("\n")[0]?.trim() ?? "";
  if (firstLine.length > 20 && firstLine.length < 200 && !firstLine.includes("```")) {
    return firstLine;
  }
  return `Session ${sessionId}: ${fileCount} files, ${commitCount} commits, ${decisionCount} decisions`;
}

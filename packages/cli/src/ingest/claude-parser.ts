import { readFileSync } from "node:fs";
import type {
  ParsedSession,
  ParsedFile,
  ParsedCommit,
  ParsedDecision,
  TranscriptLine,
  ToolUseBlock,
  ToolResultBlock,
  TextBlock,
} from "./types.js";

// Decision detection patterns in assistant text
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

// File path extraction helpers
const PROJECT_PATH_RE = /^\/[^\s'"]+\.[a-zA-Z0-9]{1,10}$/;

function isFilePath(s: string): boolean {
  return PROJECT_PATH_RE.test(s) && !s.includes("*") && !s.includes("?");
}

function countContentLines(content: string): number {
  return content.split("\n").length;
}

/**
 * Parse a Claude Code JSONL transcript file.
 */
export function parseTranscript(
  transcriptPath: string,
  sessionId: string,
  projectPath?: string
): ParsedSession {
  const raw = readFileSync(transcriptPath, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim());

  const parsed: TranscriptLine[] = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line) as TranscriptLine);
    } catch {
      // skip malformed lines
    }
  }

  // Collect timestamps
  const timestamps: string[] = [];
  for (const entry of parsed) {
    if (entry.timestamp) timestamps.push(entry.timestamp);
  }
  const startedAt =
    timestamps[0] ?? new Date().toISOString();
  const endedAt =
    timestamps[timestamps.length - 1] ?? new Date().toISOString();

  // Build a map of tool_use_id → result for success checking
  const toolResults = new Map<string, ToolResultBlock>();
  for (const entry of parsed) {
    if (entry.type !== "user") continue;
    const content = entry.message?.content ?? [];
    for (const block of content) {
      if (block.type === "tool_result") {
        toolResults.set(block.tool_use_id, block as ToolResultBlock);
      }
    }
  }

  const filesMap = new Map<string, ParsedFile>();
  const commits: ParsedCommit[] = [];
  const decisions: ParsedDecision[] = [];
  let lastAssistantText = "";

  for (const entry of parsed) {
    if (entry.type !== "assistant") continue;
    const content = entry.message?.content ?? [];

    for (const block of content) {
      if (block.type === "text") {
        const text = (block as TextBlock).text;
        if (text.length > 20) {
          lastAssistantText = text;
          extractDecisions(text, decisions);
        }
      }

      if (block.type === "tool_use") {
        const tool = block as ToolUseBlock;
        const result = toolResults.get(tool.id);
        const succeeded = result ? !result.is_error : true;

        if (tool.name === "Write") {
          const filePath = tool.input.file_path as string | undefined;
          if (filePath && isFilePath(filePath)) {
            const content = tool.input.content as string | undefined;
            const lines = content ? countContentLines(content) : 0;
            const rel = relativePath(filePath, projectPath);
            if (!filesMap.has(rel)) {
              filesMap.set(rel, {
                path: rel,
                operation: "created",
                linesChanged: lines,
              });
            }
          }
        }

        if (tool.name === "Edit" && succeeded) {
          const filePath = tool.input.file_path as string | undefined;
          if (filePath && isFilePath(filePath)) {
            const rel = relativePath(filePath, projectPath);
            const existing = filesMap.get(rel);
            const oldStr = tool.input.old_string as string | undefined;
            const newStr = tool.input.new_string as string | undefined;
            const lines = Math.max(
              oldStr ? countContentLines(oldStr) : 0,
              newStr ? countContentLines(newStr) : 0
            );
            if (existing) {
              existing.linesChanged += lines;
            } else {
              filesMap.set(rel, {
                path: rel,
                operation: "modified",
                linesChanged: lines,
              });
            }
          }
        }

        if (tool.name === "Bash") {
          const command = tool.input.command as string | undefined;
          if (!command) continue;

          // Git commits (only succeeded ones)
          if (succeeded && command.includes("git commit")) {
            const msg = extractCommitMessage(command);
            if (msg) {
              commits.push({ message: msg, command: command.slice(0, 100) });
            }
          }

          // Bash-level file ops: rm, touch, cp, mv
          if (succeeded) {
            extractBashFileOps(command, filesMap, projectPath);
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
    summary,
    agent: "claude-code",
  };
}

function relativePath(abs: string, projectPath?: string): string {
  if (!projectPath) return abs;
  if (abs.startsWith(projectPath)) {
    return abs.slice(projectPath.length).replace(/^\//, "");
  }
  return abs;
}

function extractCommitMessage(command: string): string | null {
  // Match: git commit -m "..." or git commit -m $'...' or heredoc form
  const heredocMatch = command.match(/git commit -m "\$\(cat <<'EOF'\n([\s\S]+?)\nEOF/);
  if (heredocMatch) {
    return heredocMatch[1].split("\n")[0].trim();
  }

  const simpleMatch = command.match(/git commit -m ["']([^"']+)["']/);
  if (simpleMatch) return simpleMatch[1].trim();

  // Try to find -m followed by string
  const mMatch = command.match(/git commit.*?-m\s+"([^"]+)"/);
  if (mMatch) return mMatch[1].trim();

  return null;
}

function extractBashFileOps(
  command: string,
  filesMap: Map<string, ParsedFile>,
  projectPath?: string
): void {
  // rm <file>
  const rmMatches = command.matchAll(/\brm\s+(?:-[rf]+\s+)?([^\s;&|]+\.[a-zA-Z0-9]+)/g);
  for (const m of rmMatches) {
    if (isFilePath(m[1])) {
      const rel = relativePath(m[1], projectPath);
      filesMap.set(rel, { path: rel, operation: "deleted", linesChanged: 0 });
    }
  }
}

const SKIP_DECISION_PHRASES = new Set([
  "i decided to read",
  "i decided to check",
  "i decided to look",
  "i'm going to read",
  "i'm going to check",
  "i'm going to look",
  "i'm going to run",
  "i'm going to use",
  "let me",
  "going with npm",
]);

function extractDecisions(text: string, decisions: ParsedDecision[]): void {
  for (const pattern of DECISION_PATTERNS) {
    const matches = text.matchAll(new RegExp(pattern.source, "gi"));
    for (const m of matches) {
      const raw = m[1]?.trim() ?? "";
      if (raw.length < 10 || raw.length > 200) continue;

      // Filter noise
      const lower = raw.toLowerCase();
      if (SKIP_DECISION_PHRASES.has(lower.slice(0, 30))) continue;
      if (lower.startsWith("the ") && lower.length < 20) continue;
      if (/^(it|this|that|to |the file|a |an )/.test(lower) && lower.length < 25) continue;

      // Extract rationale from surrounding text
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

      if (decisions.length >= 20) return; // cap per session
    }
  }
}

function extractRationale(text: string): string | null {
  const match = text.match(
    /^[^.!?]*(?:because|since|—|:)\s*([^.!?\n]{15,120})/i
  );
  if (match) return clean(match[1]);

  // Take first sentence if it's explanatory
  const first = text.split(/[.!?\n]/)[0]?.trim();
  if (first && first.length > 15 && first.length < 120 && !first.match(/^(Let|I |Now|Next|This )/)) {
    return clean(first);
  }

  return null;
}

function clean(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .replace(/^[.,;:\-—\s]+/, "")
    .replace(/[.,;:\-—\s]+$/, "")
    .trim();
}

function buildSummary(
  sessionId: string,
  fileCount: number,
  commitCount: number,
  decisionCount: number,
  lastText: string
): string {
  // Use last assistant message if it's a good summary (short, descriptive)
  const firstLine = lastText.split("\n")[0]?.trim() ?? "";
  if (firstLine.length > 20 && firstLine.length < 200 && !firstLine.includes("```")) {
    return firstLine;
  }

  return `Session ${sessionId}: ${fileCount} files, ${commitCount} commits, ${decisionCount} decisions`;
}

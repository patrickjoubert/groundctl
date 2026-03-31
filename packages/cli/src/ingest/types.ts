export interface ParsedPlannedFeature {
  name:      string; // kebab-case, max 6 words
  rawText:   string; // original line from transcript
  confidence: "high" | "medium" | "low";
}

export interface ParsedSession {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  filesModified: ParsedFile[];
  commits: ParsedCommit[];
  decisions: ParsedDecision[];
  plannedFeatures: ParsedPlannedFeature[];
  summary: string;
  agent: "claude-code" | "codex";
}

export interface ParsedFile {
  path: string;
  operation: "created" | "modified" | "deleted";
  linesChanged: number;
}

export interface ParsedCommit {
  message: string;
  command: string;
}

export interface ParsedDecision {
  description: string;
  rationale: string | null;
  confidence: "high" | "low";
}

// Raw transcript line structures
export interface TranscriptLine {
  type: "assistant" | "user" | "queue-operation" | "last-prompt" | "system";
  uuid?: string;
  parentUuid?: string;
  timestamp?: string;
  message?: {
    role: "assistant" | "user";
    content: ContentBlock[];
  };
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

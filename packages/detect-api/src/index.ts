/**
 * groundctl detect-api — Cloudflare Worker
 * POST /detect → calls claude-haiku → returns { features: [...] }
 *
 * Deploy: wrangler deploy
 * URL:    detect.groundctl.org
 */

export interface Env {
  ANTHROPIC_API_KEY: string;
  RATE_LIMIT: KVNamespace;
}

interface RequestBody {
  gitLog?:      string;
  fileTree?:    string;
  readme?:      string;
  projectState?: string;
}

interface ClaudeMessage {
  content?: Array<{ type: string; text: string }>;
  error?:   { type: string; message: string };
}

// ── Constants ────────────────────────────────────────────────────────────────

const CORS_HEADERS: HeadersInit = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
  "Access-Control-Allow-Headers": "Content-Type, User-Agent",
};

const MAX_BODY_BYTES = 50_000;
const RATE_LIMIT_PER_DAY = 10;
const MODEL = "claude-haiku-4-5-20251001";

const SYSTEM_PROMPT =
  "You are a product analyst. Analyze this project and identify the main product features.";

// ── Helpers ──────────────────────────────────────────────────────────────────

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

function buildUserPrompt(body: RequestBody): string {
  const sections: string[] = [];
  if (body.gitLog)      sections.push(`## Git history\n${body.gitLog.slice(0, 8_000)}`);
  if (body.fileTree)    sections.push(`## File structure\n${body.fileTree.slice(0, 4_000)}`);
  if (body.readme)      sections.push(`## README\n${body.readme.slice(0, 3_000)}`);
  if (body.projectState) sections.push(`## Existing PROJECT_STATE.md\n${body.projectState.slice(0, 2_000)}`);

  return `Based on this project context, identify the product features with their status and priority.

Rules:
- Features are functional capabilities, not technical tasks
- Maximum 12 features
- status: "done" if clearly shipped, otherwise "open"
- priority: critical / high / medium / low
- name: short, kebab-case, human-readable

Respond ONLY with valid JSON, no markdown:
{"features":[{"name":"...","status":"done","priority":"high","description":"..."}]}

${sections.join("\n\n")}`;
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

async function checkRateLimit(env: Env, ip: string): Promise<{ allowed: boolean; remaining: number }> {
  const today = new Date().toISOString().slice(0, 10);
  const key   = `rl:${ip}:${today}`;
  const count = parseInt((await env.RATE_LIMIT.get(key)) ?? "0", 10);

  if (count >= RATE_LIMIT_PER_DAY) {
    return { allowed: false, remaining: 0 };
  }

  await env.RATE_LIMIT.put(key, String(count + 1), { expirationTtl: 86_400 });
  return { allowed: true, remaining: RATE_LIMIT_PER_DAY - count - 1 };
}

// ── Claude API call ───────────────────────────────────────────────────────────

async function callClaude(apiKey: string, body: RequestBody): Promise<Array<Record<string, string>>> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method:  "POST",
    headers: {
      "x-api-key":          apiKey,
      "anthropic-version":  "2023-06-01",
      "content-type":       "application/json",
    },
    body: JSON.stringify({
      model:      MODEL,
      max_tokens: 1024,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: "user", content: buildUserPrompt(body) }],
    }),
  });

  const msg = await response.json() as ClaudeMessage;
  if (msg.error) throw new Error(msg.error.message);

  const textBlock = (msg.content ?? []).find((b) => b.type === "text");
  if (!textBlock) throw new Error("Empty response from model");

  // Strip markdown fences if present
  const text = textBlock.text.replace(/^```[^\n]*\n?/, "").replace(/\n?```$/, "").trim();

  // Extract first JSON object in case there's any preamble
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON in model response");

  const parsed = JSON.parse(match[0]) as { features?: unknown };
  if (!Array.isArray(parsed.features)) throw new Error("No features array in response");

  return (parsed.features as Array<Record<string, string>>).filter(
    (f) => typeof f.name === "string" && f.name.length > 0
  );
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Health check
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ status: "ok", service: "groundctl-detect", model: MODEL });
    }

    // Only POST /detect from here
    if (url.pathname !== "/detect" || request.method !== "POST") {
      return json({ error: "Not found" }, 404);
    }

    // ── Guard: User-Agent must contain "groundctl" ──────────────────────────
    const ua = request.headers.get("user-agent") ?? "";
    if (!ua.toLowerCase().includes("groundctl")) {
      return json({ error: "Forbidden: set User-Agent to include 'groundctl'" }, 403);
    }

    // ── Guard: Body size ───────────────────────────────────────────────────
    const contentLength = parseInt(request.headers.get("content-length") ?? "0", 10);
    if (contentLength > MAX_BODY_BYTES) {
      return json({ error: `Payload too large (max ${MAX_BODY_BYTES / 1000}KB)` }, 413);
    }

    // ── Rate limit ─────────────────────────────────────────────────────────
    const ip = (
      request.headers.get("cf-connecting-ip") ??
      request.headers.get("x-forwarded-for") ??
      "unknown"
    ).split(",")[0].trim();

    const { allowed, remaining } = await checkRateLimit(env, ip);
    if (!allowed) {
      return json(
        { error: `Rate limit exceeded (${RATE_LIMIT_PER_DAY}/day per IP)` },
        429
      );
    }

    // ── Parse body ─────────────────────────────────────────────────────────
    let body: RequestBody;
    try {
      body = await request.json() as RequestBody;
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    // ── Call Claude ────────────────────────────────────────────────────────
    try {
      const features = await callClaude(env.ANTHROPIC_API_KEY, body);
      return new Response(JSON.stringify({ features }), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "x-rate-limit-remaining": String(remaining),
          ...CORS_HEADERS,
        },
      });
    } catch (err) {
      return json({ error: `Detection failed: ${(err as Error).message}` }, 500);
    }
  },
};

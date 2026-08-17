const LOCAL_CONVEX_CLOUD_URL = "http://127.0.0.1:3210";
const LOCAL_CODEX_BRIDGE_URL = "http://127.0.0.1:5173/api/local-codex";
const MIN_BRIDGE_TOKEN_BYTES = 32;
const MAX_PROMPT_BYTES = 480 * 1024;
const MAX_RESPONSE_BYTES = 300 * 1024;
const REQUEST_TIMEOUT_MS = 125_000;

export type LocalCodexTask =
  | "chat"
  | "weak_word_suggestions"
  | "personalized_feedback"
  | "transcript_analysis";

export type WeakWordSuggestionsResult = {
  suggestions: Array<{
    index: number;
    replacement: string;
    rewrite: string;
  }>;
};

export type PersonalizedFeedbackResult = {
  summary: string;
  strengths: string[];
  improvements: string[];
  actionItems: string[];
};

export type TranscriptAnalysisResult = {
  S1_facts: string[];
  S2_facts: string[];
  summary: string;
};

type LocalCodexResultByTask = {
  chat: string;
  weak_word_suggestions: WeakWordSuggestionsResult;
  personalized_feedback: PersonalizedFeedbackResult;
  transcript_analysis: TranscriptAnalysisResult;
};

export class LocalCodexRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "LocalCodexRequestError";
  }
}

function utf8Length(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function requireConfiguredProvider() {
  const isLocalDeployment = process.env.CONVEX_CLOUD_URL === LOCAL_CONVEX_CLOUD_URL;
  const provider = (
    process.env.AUDORA_AI_PROVIDER ?? (isLocalDeployment ? "codex" : "openai")
  ).trim();

  if (provider === "" || provider === "openai") return false;
  if (provider !== "codex") {
    throw new Error(
      `Unsupported AUDORA_AI_PROVIDER: ${provider}. Expected "openai" or "codex".`
    );
  }

  if (!isLocalDeployment) {
    throw new Error(
      `AUDORA_AI_PROVIDER=codex is restricted to the exact local Convex deployment ${LOCAL_CONVEX_CLOUD_URL}`
    );
  }

  const token = process.env.AUDORA_CODEX_BRIDGE_TOKEN?.trim() ?? "";
  if (utf8Length(token) < MIN_BRIDGE_TOKEN_BYTES) {
    throw new Error("AUDORA_CODEX_BRIDGE_TOKEN must contain at least 32 bytes");
  }

  return true;
}

export function shouldUseLocalCodex() {
  return requireConfiguredProvider();
}

async function readBoundedResponse(response: Response) {
  const contentLength = response.headers.get("Content-Length");
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (!Number.isFinite(parsedLength) || parsedLength < 0) {
      throw new Error("Local Codex bridge returned an invalid Content-Length");
    }
    if (parsedLength > MAX_RESPONSE_BYTES) {
      throw new Error("Local Codex bridge response exceeded its limit");
    }
  }

  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    receivedBytes += value.byteLength;
    if (receivedBytes > MAX_RESPONSE_BYTES) {
      await reader.cancel("Response too large");
      throw new Error("Local Codex bridge response exceeded its limit");
    }
    chunks.push(value);
  }

  const body = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new Error("Local Codex bridge returned invalid UTF-8");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string, maxLength: number) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new Error(`Local Codex bridge returned an invalid ${field}`);
  }
  return value;
}

function requireStringArray(
  value: unknown,
  field: string,
  maxItems: number,
  maxLength: number
) {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`Local Codex bridge returned an invalid ${field}`);
  }
  return value.map((item, index) =>
    requireString(item, `${field}[${index}]`, maxLength)
  );
}

function validateResult<T extends LocalCodexTask>(
  task: T,
  value: unknown
): LocalCodexResultByTask[T] {
  if (task === "chat") {
    return requireString(value, "chat result", 256 * 1024) as LocalCodexResultByTask[T];
  }

  if (!isRecord(value)) {
    throw new Error("Local Codex bridge returned a non-object result");
  }

  if (task === "weak_word_suggestions") {
    if (!Array.isArray(value.suggestions) || value.suggestions.length > 5) {
      throw new Error("Local Codex bridge returned invalid weak-word suggestions");
    }

    const suggestions = value.suggestions.map((suggestion, position) => {
      if (!isRecord(suggestion)) {
        throw new Error(`Local Codex bridge returned invalid suggestion ${position}`);
      }
      if (
        typeof suggestion.index !== "number" ||
        !Number.isInteger(suggestion.index) ||
        suggestion.index < 0 ||
        suggestion.index > 4
      ) {
        throw new Error("Local Codex bridge returned an invalid suggestion index");
      }
      const rewrite = suggestion.rewrite;
      if (typeof rewrite !== "string" || rewrite.length > 220) {
        throw new Error("Local Codex bridge returned an invalid rewrite");
      }
      return {
        index: suggestion.index,
        replacement: requireString(suggestion.replacement, "replacement", 80),
        rewrite,
      };
    });

    return { suggestions } as LocalCodexResultByTask[T];
  }

  if (task === "personalized_feedback") {
    return {
      summary: requireString(value.summary, "summary", 2_000),
      strengths: requireStringArray(value.strengths, "strengths", 10, 1_000),
      improvements: requireStringArray(value.improvements, "improvements", 10, 1_000),
      actionItems: requireStringArray(value.actionItems, "actionItems", 10, 1_000),
    } as LocalCodexResultByTask[T];
  }

  return {
    S1_facts: requireStringArray(value.S1_facts, "S1_facts", 100, 2_000),
    S2_facts: requireStringArray(value.S2_facts, "S2_facts", 100, 2_000),
    summary: requireString(value.summary, "summary", 10_000),
  } as LocalCodexResultByTask[T];
}

export async function runLocalCodex<T extends LocalCodexTask>(
  task: T,
  prompt: string
): Promise<LocalCodexResultByTask[T]> {
  if (!requireConfiguredProvider()) {
    throw new Error("Local Codex was called while the configured provider is not codex");
  }
  if (!prompt.trim()) throw new Error("Local Codex prompt must not be empty");
  if (utf8Length(prompt) > MAX_PROMPT_BYTES) {
    throw new Error("Local Codex prompt exceeded its limit");
  }

  const token = process.env.AUDORA_CODEX_BRIDGE_TOKEN!.trim();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(LOCAL_CODEX_BRIDGE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ task, prompt }),
      redirect: "error",
      signal: controller.signal,
    });
    const responseText = await readBoundedResponse(response);

    let body: unknown;
    try {
      body = JSON.parse(responseText);
    } catch {
      throw new Error("Local Codex bridge returned malformed JSON");
    }

    if (!response.ok) {
      const message =
        isRecord(body) && typeof body.error === "string"
          ? body.error.slice(0, 1_000)
          : `HTTP ${response.status}`;
      const retryAfterSeconds =
        isRecord(body) &&
        typeof body.retryAfterSeconds === "number" &&
        Number.isFinite(body.retryAfterSeconds)
          ? Math.max(1, Math.ceil(body.retryAfterSeconds))
          : undefined;
      throw new LocalCodexRequestError(message, response.status, retryAfterSeconds);
    }
    if (!isRecord(body) || !("result" in body)) {
      throw new Error("Local Codex bridge response did not contain a result");
    }

    return validateResult(task, body.result);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Local Codex bridge request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

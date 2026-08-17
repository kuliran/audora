import type { Route } from "./+types/local-codex";
import { LOCAL_AUTH_ISSUER } from "~/lib/local-auth/config";

const MAX_REQUEST_BODY_BYTES = 512 * 1024;
const MIN_BRIDGE_TOKEN_BYTES = 32;
const REQUEST_LIMIT = 5;
const REQUEST_WINDOW_MS = 5 * 60 * 1000;
const ALLOWED_TASKS = new Set([
  "chat",
  "weak_word_suggestions",
  "personalized_feedback",
  "transcript_analysis",
]);

let activeRequests = 0;
const admittedRequestTimes: number[] = [];

function jsonResponse(body: unknown, status: number, headers?: HeadersInit) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      Pragma: "no-cache",
      ...headers,
    },
  });
}

function admitRateLimitedRequest(now = Date.now()) {
  while (
    admittedRequestTimes.length > 0 &&
    admittedRequestTimes[0] <= now - REQUEST_WINDOW_MS
  ) {
    admittedRequestTimes.shift();
  }

  if (admittedRequestTimes.length >= REQUEST_LIMIT) {
    const retryAfterMs = admittedRequestTimes[0] + REQUEST_WINDOW_MS - now;
    return Math.max(1, Math.ceil(retryAfterMs / 1000));
  }

  admittedRequestTimes.push(now);
  return null;
}

async function readBoundedBody(request: Request) {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (!Number.isFinite(parsedLength) || parsedLength < 0) {
      throw new Response("Invalid Content-Length", { status: 400 });
    }
    if (parsedLength > MAX_REQUEST_BODY_BYTES) {
      throw new Response("Request body too large", { status: 413 });
    }
  }

  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    receivedBytes += value.byteLength;
    if (receivedBytes > MAX_REQUEST_BODY_BYTES) {
      await reader.cancel("Request body too large");
      throw new Response("Request body too large", { status: 413 });
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
    throw new Response("Request body must be valid UTF-8", { status: 400 });
  }
}

async function hasValidBridgeToken(request: Request, expectedToken: string) {
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return false;

  const suppliedToken = authorization.slice("Bearer ".length);
  const { timingSafeEqual } = await import("node:crypto");
  const expected = Buffer.from(expectedToken, "utf8");
  const supplied = Buffer.from(suppliedToken, "utf8");

  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export async function action({ request }: Route.ActionArgs) {
  if (!import.meta.env.DEV || import.meta.env.VITE_LOCAL_AUTH !== "true") {
    return new Response("Not found", { status: 404 });
  }

  const requestUrl = new URL(request.url);
  if (requestUrl.origin !== LOCAL_AUTH_ISSUER) {
    return new Response("Not found", { status: 404 });
  }

  // Browsers always send at least one of these headers for a JSON POST. The
  // bridge is exclusively for the local Convex backend, never browser code.
  if (request.headers.has("Origin") || request.headers.has("Sec-Fetch-Site")) {
    return new Response("Forbidden", { status: 403 });
  }

  if (request.headers.get("Content-Type")?.split(";", 1)[0].trim() !== "application/json") {
    return new Response("Content-Type must be application/json", { status: 415 });
  }

  const expectedToken = process.env.AUDORA_CODEX_BRIDGE_TOKEN?.trim() ?? "";
  if (Buffer.byteLength(expectedToken, "utf8") < MIN_BRIDGE_TOKEN_BYTES) {
    return jsonResponse({ error: "Codex bridge token is not configured" }, 503);
  }
  if (!(await hasValidBridgeToken(request, expectedToken))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  if (activeRequests >= 1) {
    return jsonResponse({ error: "Codex bridge is busy" }, 429);
  }

  let rawBody: string;
  try {
    rawBody = await readBoundedBody(request);
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ error: "Malformed JSON" }, 400);
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return jsonResponse({ error: "Request body must be an object" }, 400);
  }

  const { task, prompt } = body as Record<string, unknown>;
  if (typeof task !== "string" || !ALLOWED_TASKS.has(task)) {
    return jsonResponse({ error: "Unsupported Codex task" }, 400);
  }
  if (typeof prompt !== "string" || !prompt.trim()) {
    return jsonResponse({ error: "Prompt must be a non-empty string" }, 400);
  }

  const retryAfterSeconds = admitRateLimitedRequest();
  if (retryAfterSeconds !== null) {
    return jsonResponse(
      {
        error: `Codex request limit reached. Try again in ${retryAfterSeconds} seconds.`,
        limit: REQUEST_LIMIT,
        windowSeconds: REQUEST_WINDOW_MS / 1000,
        retryAfterSeconds,
      },
      429,
      { "Retry-After": String(retryAfterSeconds) }
    );
  }

  activeRequests += 1;
  try {
    const { runCodexBridgeTask } = await import("~/lib/codex-bridge.server");
    const result = await runCodexBridgeTask(
      task as Parameters<typeof runCodexBridgeTask>[0],
      prompt,
      request.signal
    );
    return jsonResponse({ result }, 200);
  } catch (error) {
    const { CodexBridgeExecutionError } = await import("~/lib/codex-bridge.server");
    if (error instanceof CodexBridgeExecutionError) {
      return jsonResponse({ error: error.message }, error.status);
    }

    console.error("Local Codex bridge failed", error);
    return jsonResponse({ error: "Local Codex bridge failed" }, 502);
  } finally {
    activeRequests -= 1;
  }
}

// Shared harness: boot a cordis app with the real DSH services the CodeTime
// backend injects (`sessions`, `timer`), stub the network, and expose the
// requests the backend makes.
import { Context } from "@deepseek-ai/cordis";
import TimerService from "@deepseek-ai/cordis-plugin-timer";
import SessionStore from "@deepseek-ai/dsh-session";
import { createAssistantMessage, createToolResultMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import CodetimeSessionBackend from "../lib/index.js";

export const WORKSPACE = "E:\\dsh-codetime-fixture";

/** Boot the plugin and return the app plus the captured ingest requests. */
export async function startBackend(options = {}) {
  const posts = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    posts.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ inserted: posts.length, skipped: 0, conflicts: 0 }) };
  };

  const ctx = new Context();
  await ctx.plugin(TimerService);
  await ctx.plugin(SessionStore);
  await ctx.plugin(CodetimeSessionBackend, {
    mode: options.mode ?? "FULL",
    apiUrl: "https://codetime.test",
    token: "test-token",
    flushIntervalMs: 60_000,
    ...options.config,
  });

  return {
    ctx,
    posts,
    backend: ctx.sessionTelemetry,
    /** Force the periodic flush path without waiting for the interval. */
    flush: () => ctx.sessionTelemetry.flushAll(),
    async dispose() {
      await ctx.fiber.dispose();
      globalThis.fetch = originalFetch;
    },
  };
}

export function userMessage(text) {
  return createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });
}

export function assistantMessage(text, provider = "deepseek-official", model = "deepseek-flash") {
  return createAssistantMessage({ content: [{ type: "text", text }], source: { provider, model } });
}

export function toolResult(callId, text, isError = false) {
  return createToolResultMessage({ callId, content: [{ type: "text", text }], isError });
}

/** Append one tool call/result pair to a session. */
export function appendTool(session, { turn = 1, step = 1, callId, name, args, isError = false, result = "ok" }) {
  session.append("tool/call", { turn, step, callId, name, arguments: JSON.stringify(args) });
  session.append(
    "tool/result",
    { turn, step, message: toolResult(callId, result, isError) },
    { surfaceOp: "append" },
  );
}

/**
 * One representative session covering every canonical event the backend maps:
 * a prompt, a model answer with usage, file reads/searches/writes/edits, a
 * shell command, and a tool failure.
 */
export function seedSession(session, workspace = WORKSPACE) {
  session.append("turn/start", { turn: 1 });
  session.append("user/message", userMessage("wire up the codetime backend"), { surfaceOp: "append" });
  session.append("request/context", { provider: "deepseek-official", model: "deepseek-flash" });
  session.append(
    "assistant/message",
    {
      turn: 1,
      step: 1,
      message: assistantMessage("on it"),
      stream: [],
      usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 4000, cacheWriteTokens: 50, reasoningTokens: 30 },
    },
    { surfaceOp: "append" },
  );

  appendTool(session, {
    callId: "call-read",
    name: "read",
    args: { file_path: `${workspace}\\lib\\index.js`, limit: 40 },
  });
  appendTool(session, { callId: "call-grep", name: "grep", args: { pattern: "SessionTelemetry", path: workspace } });
  appendTool(session, {
    callId: "call-write",
    name: "write",
    args: { file_path: `${workspace}\\lib\\new.js`, content: "one\ntwo\nthree" },
  });
  appendTool(session, {
    callId: "call-edit",
    name: "edit",
    args: { file_path: `${workspace}\\lib\\index.js`, old_string: "a\nb", new_string: "a\nb\nc" },
  });
  appendTool(session, {
    callId: "call-editor",
    name: "str_replace_editor",
    args: { command: "str_replace", path: `${workspace}\\lib\\index.js`, old_str: "x\ny", new_str: "x\ny\nz" },
  });
  appendTool(session, { callId: "call-shell", name: "pwsh", args: { command: "node --test test/" } });
  appendTool(session, {
    callId: "call-fail",
    name: "edit",
    args: { file_path: `${workspace}\\lib\\broken.js`, old_string: "nope", new_string: "still nope" },
    isError: true,
    result: "old_string not found",
  });

  session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
  return session;
}

/** The single session rollup from the first (or only) captured request. */
export function rollupFrom(posts, index = 0) {
  const rollups = posts.at(index)?.body?.rollups ?? [];
  if (rollups.length !== 1) throw new Error(`expected exactly one rollup, saw ${rollups.length}`);
  return rollups[0];
}

export function fileRollup(rollup, displayPath) {
  return rollup.fileRollups.find((file) => file.displayPath === displayPath);
}

/** Poll until `predicate` holds, so fire-and-forget flushes can settle. */
export async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// CodeTime backend for the DeepSeek Harness session-telemetry seam.
//
// Implements the `SessionTelemetryBackend` contract (`emit` / `flush` /
// `shutdown`) that `@deepseek-ai/dsh-session-telemetry`'s
// `SessionTelemetryCoordinator` drives, and reports the captured session
// activity to codetime.dev using the same agent rollup wire format as
// `codetime-cli` (POST /v3/agent/ingest).
//
// This is a HOST-plane plugin (a process-global `sessionTelemetry` Service):
// exactly one such backend may be mounted per context, mirroring
// `dsh-session-telemetry-otel`.

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { SessionTelemetryBackend, SessionTelemetryCoordinator } from "@deepseek-ai/dsh-session-telemetry";

// ── wire constants (mirror codetime-cli) ──────────────────────────────────
const SOURCE_ID = "dsh"; // the `source` id codetime-cli backfill would reuse
const AGENT_NAME = "dsh"; // the short `agent` label shown on the dashboard
const AGENT_TIME_SCHEMA_VERSION = "2026-04-29";
const AGENT_ROLLUP_SCHEMA_VERSION = 3;
const ROLLUP_BUCKET_MS = 15 * 60 * 1000;
const TURN_GAP_CLAMP_MS = 5 * 60 * 1000;
const DEFAULT_BASE_URL = "https://codetime.dev";
const PACKAGE_VERSION = "0.1.0";
const DEFAULT_FLUSH_INTERVAL_MS = 60 * 1000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5 * 1000;

// ── stable hashing (mirror codetime-cli's stableStringify / fnv1a) ────────
function stableStringify(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const entries = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
  return `{${entries.join(",")}}`;
}

function createStableHash(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function fnv1a(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function createWorkspaceId(input) {
  const basis = input.repoUrl || input.repoRoot || input.projectName || "unknown";
  return `workspace_${fnv1a(basis)}`;
}

function createImportKey(parts) {
  return parts
    .filter((part) => part !== undefined && part !== null && part !== "")
    .map((part) => encodeURIComponent(String(part)))
    .join(":");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function removeVolatileHashFields(value) {
  if (Array.isArray(value)) return value.map((item) => removeVolatileHashFields(item));
  if (!isRecord(value)) return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "receivedAt") continue;
    if (key === "refs" && isRecord(item)) {
      const refs = { ...item };
      delete refs.payloadHash;
      result[key] = removeVolatileHashFields(refs);
      continue;
    }
    result[key] = removeVolatileHashFields(item);
  }
  return result;
}

function createPayloadHash(value) {
  return `sha256:${createStableHash(removeVolatileHashFields(value))}`;
}

function iso(epochMs) {
  return new Date(epochMs).toISOString();
}

// ── small field helpers ───────────────────────────────────────────────────
function firstString(object, keys) {
  if (!isRecord(object)) return undefined;
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function countTextLines(text) {
  if (typeof text !== "string" || text.length === 0) return undefined;
  return text.split(/\r\n|\r|\n/).length;
}

function safeParseJson(text) {
  if (typeof text !== "string") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function messageText(content) {
  if (!Array.isArray(content)) return undefined;
  const parts = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

// ── DSH tool vocabulary → codetime file activity ──────────────────────────
function isWriteOperation(operation) {
  return operation === "create" || operation === "write" || operation === "edit" || operation === "delete";
}

function eventTypeFromFileActivities(files) {
  if (files.some((file) => isWriteOperation(file.operation))) return "file.changed";
  if (files.some((file) => file.operation === "search")) return "file.searched";
  return "file.read";
}

function summarizeFileActivities(files) {
  const linesAdded = files.reduce((total, file) => total + (file.linesAdded || 0), 0);
  const linesRemoved = files.reduce((total, file) => total + (file.linesRemoved || 0), 0);
  return {
    linesAdded: linesAdded || undefined,
    linesRemoved: linesRemoved || undefined,
  };
}

function isShellTool(tool) {
  const normalized = (tool || "").toLowerCase();
  return ["bash", "pwsh", "terminal", "exec", "shell", "run_command", "subprocess", "cmd"].includes(normalized);
}

// Derive file activities from a DSH tool name + its parsed arguments. Returns
// `[]` when the tool has no usable file path (e.g. shell or web tools).
function fileActivitiesForTool(tool, args, ts) {
  if (!isRecord(args)) return [];
  const normalized = (tool || "").toLowerCase();

  const filePath = firstString(args, ["file_path", "filePath", "path", "notebook_path"]);
  if (!filePath) return [];

  if (["read", "notebookread", "read_image", "view_image"].includes(normalized)) {
    const limit = typeof args.limit === "number" && Number.isFinite(args.limit) ? args.limit : undefined;
    return [{ ts, path: filePath, operation: "read", linesRead: limit, confidence: "derived" }];
  }

  if (normalized === "write") {
    const content = args.content;
    return [{
      ts,
      path: filePath,
      operation: "write",
      linesAdded: countTextLines(content),
      charsWritten: typeof content === "string" ? content.length : undefined,
      confidence: "derived",
    }];
  }

  if (["edit", "multiedit", "notebookedit", "apply_patch", "applypatch", "str_replace_editor", "str_replace"].includes(normalized)) {
    const newString = args.new_string;
    const oldString = args.old_string;
    return [{
      ts,
      path: filePath,
      operation: "edit",
      linesAdded: countTextLines(newString),
      linesRemoved: countTextLines(oldString),
      charsWritten: typeof newString === "string" ? newString.length : undefined,
      confidence: "derived",
    }];
  }

  if (["grep", "glob", "ls", "search", "rg"].includes(normalized)) {
    return [{ ts, path: filePath, operation: "search", confidence: "derived" }];
  }

  return [];
}

function mapTokenUsage(usage) {
  if (!isRecord(usage)) return undefined;
  const input = usage.inputTokens || 0;
  const output = usage.outputTokens || 0;
  const cacheRead = usage.cacheReadTokens || 0;
  const cacheWrite = usage.cacheWriteTokens || 0;
  const reasoning = usage.reasoningTokens || 0;
  const cachedInput = cacheRead + cacheWrite;
  const totalInput = input + cachedInput;
  const total = totalInput + output;
  return {
    tokensInput: totalInput || undefined,
    tokensCachedInput: cachedInput || undefined,
    tokensCacheReadInput: cacheRead || undefined,
    tokensCacheCreationInput: cacheWrite || undefined,
    tokensReasoningOutput: reasoning || undefined,
    tokensOutput: output || undefined,
    tokensTotal: total || undefined,
    modelCalls: 1,
  };
}

// ── rollup construction (mirror codetime-cli buildSessionRollup) ──────────
function floorRollupBucket(ts) {
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms)) return ts;
  return new Date(Math.floor(ms / ROLLUP_BUCKET_MS) * ROLLUP_BUCKET_MS).toISOString();
}

function totalTokensFromEvent(event) {
  const explicit = event.metrics?.tokensTotal;
  if (typeof explicit === "number" && explicit > 0) return explicit;
  return Math.max(0, event.metrics?.tokensInput || 0) + Math.max(0, event.metrics?.tokensOutput || 0);
}

function lineStatsFromEvent(event) {
  const files = event.fileActivities || [];
  const fileLinesAdded = files.reduce((total, file) => total + (file.linesAdded || 0), 0);
  const fileLinesRemoved = files.reduce((total, file) => total + (file.linesRemoved || 0), 0);
  return {
    linesAdded: Math.max(fileLinesAdded, event.metrics?.linesAdded || 0),
    linesRemoved: Math.max(fileLinesRemoved, event.metrics?.linesRemoved || 0),
  };
}

function eventDurationMs(event) {
  return Math.max(
    0,
    event.metrics?.durationMs || event.metrics?.commandDurationMs || event.metrics?.toolDurationMs || event.metrics?.modelDurationMs || 0,
  );
}

function gapClampedTurnDurationMs(rollup, eventTimes) {
  const millis = [rollup.promptSubmittedAt, rollup.startedAt, ...eventTimes]
    .map((ts) => (ts ? Date.parse(ts) : Number.NaN))
    .filter((ms) => Number.isFinite(ms));
  const unique = [...new Set(millis)].sort((a, b) => a - b);
  if (unique.length < 2) return 0;
  let duration = 0;
  for (let i = 1; i < unique.length; i += 1) {
    duration += Math.min(unique[i] - unique[i - 1], TURN_GAP_CLAMP_MS);
  }
  return Math.max(0, duration);
}

function buildSessionRollup(sessionId, events) {
  const ordered = [...events].sort((a, b) => a.ts.localeCompare(b.ts));
  const first = ordered[0];
  const sourcePathHash = `sha256:${createStableHash(sessionId)}`;
  const project = first.project || ordered.find((event) => event.project)?.project;
  const agent = first.agent || ordered.find((event) => event.agent)?.agent;
  const startedAt = ordered[0]?.ts || new Date().toISOString();
  const lastEventAt = ordered.at(-1)?.ts || startedAt;

  const timeBuckets = new Map();
  const modelRollups = new Map();
  const modelBuckets = new Map();
  const toolRollups = new Map();
  const fileRollups = new Map();
  const turnRollups = new Map();
  const turnEventTimes = new Map();

  let promptCount = 0;
  let turnCount = 0;
  let toolCallCount = 0;
  let commandCallCount = 0;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let cacheCreationInputTokens = 0;
  let cacheReadInputTokens = 0;
  let outputTokens = 0;
  let reasoningOutputTokens = 0;
  let totalTokens = 0;
  let linesAdded = 0;
  let linesRemoved = 0;

  for (const event of ordered) {
    const eventInputTokens = Math.max(0, event.metrics?.tokensInput || 0);
    const eventCachedInputTokens = Math.max(0, event.metrics?.tokensCachedInput || 0);
    const eventCacheCreationInputTokens = Math.max(0, event.metrics?.tokensCacheCreationInput || 0);
    const eventCacheCreation5mInputTokens = Math.max(0, event.metrics?.tokensCacheCreation5mInput || 0);
    const eventCacheCreation1hInputTokens = Math.max(0, event.metrics?.tokensCacheCreation1hInput || 0);
    const eventCacheReadInputTokens = Math.max(0, event.metrics?.tokensCacheReadInput || 0);
    const eventOutputTokens = Math.max(0, event.metrics?.tokensOutput || 0);
    const eventReasoningOutputTokens = Math.max(0, event.metrics?.tokensReasoningOutput || 0);
    const eventTotalTokens = totalTokensFromEvent(event);
    const lineStats = lineStatsFromEvent(event);
    const bucketTs = floorRollupBucket(event.ts);
    const bucket = timeBuckets.get(bucketTs) || {
      ts: bucketTs,
      activityCount: 0,
      sessionStarts: 0,
      modelCalls: 0,
      toolCalls: 0,
      commandCalls: 0,
      fileReads: 0,
      fileWrites: 0,
      linesAdded: 0,
      linesRemoved: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
    };

    if (event.type === "prompt.submitted") promptCount += 1;
    if (event.type === "turn.started") turnCount += 1;
    if (event.type === "tool.started") toolCallCount += 1;
    if (event.type === "command.completed" || event.type === "command.failed") commandCallCount += 1;

    if (event.turnId) {
      const existing = turnRollups.get(event.turnId);
      const turnRollup = existing || {
        turnId: event.turnId,
        startedAt: event.ts,
        lastEventAt: event.ts,
        completedAt: undefined,
        promptSubmittedAt: undefined,
        promptChars: 0,
        eventCount: 0,
        toolCallCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        durationMs: 0,
      };
      if (event.type === "prompt.submitted") {
        turnRollup.promptSubmittedAt = turnRollup.promptSubmittedAt || event.ts;
        turnRollup.startedAt = turnRollup.promptSubmittedAt;
        if (turnRollup.lastEventAt < turnRollup.startedAt) turnRollup.lastEventAt = turnRollup.startedAt;
        turnRollup.promptChars += Math.max(0, event.metrics?.promptChars || 0);
      } else if (event.type === "turn.completed") {
        turnRollup.completedAt = event.ts;
      } else if (!existing) {
        turnRollup.startedAt = event.ts;
      } else if (!turnRollup.promptSubmittedAt && event.ts < turnRollup.startedAt) {
        turnRollup.startedAt = event.ts;
      }
      if (event.ts >= turnRollup.startedAt && event.ts > turnRollup.lastEventAt) {
        turnRollup.lastEventAt = event.ts;
      }
      if (event.type === "tool.started") turnRollup.toolCallCount += 1;
      turnRollup.eventCount += 1;
      turnRollup.inputTokens += eventInputTokens;
      turnRollup.outputTokens += eventOutputTokens;
      turnRollup.totalTokens += eventTotalTokens;
      turnRollups.set(event.turnId, turnRollup);
      const times = turnEventTimes.get(event.turnId);
      if (times) times.push(event.ts);
      else turnEventTimes.set(event.turnId, [event.ts]);
    }

    inputTokens += eventInputTokens;
    cachedInputTokens += eventCachedInputTokens;
    cacheCreationInputTokens += eventCacheCreationInputTokens;
    cacheReadInputTokens += eventCacheReadInputTokens;
    outputTokens += eventOutputTokens;
    reasoningOutputTokens += eventReasoningOutputTokens;
    totalTokens += eventTotalTokens;
    linesAdded += lineStats.linesAdded;
    linesRemoved += lineStats.linesRemoved;
    bucket.inputTokens += eventInputTokens;
    bucket.cachedInputTokens += eventCachedInputTokens;
    bucket.cacheCreationInputTokens += eventCacheCreationInputTokens;
    bucket.cacheReadInputTokens += eventCacheReadInputTokens;
    bucket.outputTokens += eventOutputTokens;
    bucket.reasoningOutputTokens += eventReasoningOutputTokens;
    bucket.totalTokens += eventTotalTokens;
    bucket.linesAdded += lineStats.linesAdded;
    bucket.linesRemoved += lineStats.linesRemoved;

    if (event.type === "session.started") {
      bucket.sessionStarts += 1;
      bucket.activityCount += 1;
    }
    if (event.type === "model.usage") {
      bucket.modelCalls += 1;
      bucket.activityCount += 1;
      const modelKey = event.model || "unknown";
      const modelRollup = modelRollups.get(modelKey) || {
        model: modelKey,
        callCount: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheCreation5mInputTokens: 0,
        cacheCreation1hInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
        estimatedCostUsd: 0,
      };
      modelRollup.callCount += 1;
      modelRollup.inputTokens += eventInputTokens;
      modelRollup.cachedInputTokens += eventCachedInputTokens;
      modelRollup.cacheCreationInputTokens += eventCacheCreationInputTokens;
      modelRollup.cacheCreation5mInputTokens += eventCacheCreation5mInputTokens;
      modelRollup.cacheCreation1hInputTokens += eventCacheCreation1hInputTokens;
      modelRollup.cacheReadInputTokens += eventCacheReadInputTokens;
      modelRollup.outputTokens += eventOutputTokens;
      modelRollup.reasoningOutputTokens += eventReasoningOutputTokens;
      modelRollup.totalTokens += eventTotalTokens;
      modelRollups.set(modelKey, modelRollup);

      const modelBucketKey = `${bucketTs}\u0000${modelKey}`;
      const modelBucket = modelBuckets.get(modelBucketKey) || {
        ts: bucketTs,
        model: modelKey,
        callCount: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheCreation5mInputTokens: 0,
        cacheCreation1hInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
      };
      modelBucket.callCount += 1;
      modelBucket.inputTokens += eventInputTokens;
      modelBucket.cachedInputTokens += eventCachedInputTokens;
      modelBucket.cacheCreationInputTokens += eventCacheCreationInputTokens;
      modelBucket.cacheCreation5mInputTokens += eventCacheCreation5mInputTokens;
      modelBucket.cacheCreation1hInputTokens += eventCacheCreation1hInputTokens;
      modelBucket.cacheReadInputTokens += eventCacheReadInputTokens;
      modelBucket.outputTokens += eventOutputTokens;
      modelBucket.reasoningOutputTokens += eventReasoningOutputTokens;
      modelBucket.totalTokens += eventTotalTokens;
      modelBuckets.set(modelBucketKey, modelBucket);
    }
    if (event.type === "tool.started") {
      bucket.toolCalls += 1;
      bucket.activityCount += 1;
      const toolKey = event.tool || "tool";
      const toolRollup = toolRollups.get(toolKey) || { tool: toolKey, callCount: 0, failureCount: 0, totalDurationMs: 0 };
      toolRollup.callCount += 1;
      toolRollups.set(toolKey, toolRollup);
    }
    if (event.type === "tool.failed" || event.type === "tool.completed") {
      const toolKey = event.tool || "tool";
      const toolRollup = toolRollups.get(toolKey) || { tool: toolKey, callCount: 0, failureCount: 0, totalDurationMs: 0 };
      if (event.type === "tool.failed") toolRollup.failureCount += 1;
      toolRollup.totalDurationMs += eventDurationMs(event);
      toolRollups.set(toolKey, toolRollup);
    }
    if (event.type === "command.completed" || event.type === "command.failed") {
      bucket.commandCalls += 1;
      bucket.activityCount += 1;
    }
    for (const file of event.fileActivities || []) {
      const displayPath = file.path;
      const pathHash = `sha256:${createStableHash(displayPath)}`;
      const fileRollup = fileRollups.get(pathHash) || {
        pathHash,
        displayPath,
        reads: 0,
        writes: 0,
        linesAdded: 0,
        linesRemoved: 0,
        lastTouchedAt: file.ts || event.ts,
      };
      const fileLinesAdded = file.linesAdded || 0;
      const fileLinesRemoved = file.linesRemoved || 0;
      if (file.operation === "read" || file.operation === "search") {
        fileRollup.reads += 1;
        bucket.fileReads += 1;
        bucket.activityCount += 1;
      } else {
        fileRollup.writes += 1;
        bucket.fileWrites += 1;
        bucket.activityCount += 1;
      }
      fileRollup.linesAdded += fileLinesAdded;
      fileRollup.linesRemoved += fileLinesRemoved;
      if ((file.ts || event.ts) > fileRollup.lastTouchedAt) fileRollup.lastTouchedAt = file.ts || event.ts;
      fileRollups.set(pathHash, fileRollup);
    }
    timeBuckets.set(bucketTs, bucket);
  }

  const baseRollup = {
    rollupKey: createImportKey(["rollup", first.source, sourcePathHash, sessionId]),
    payloadHash: "",
    schemaVersion: AGENT_ROLLUP_SCHEMA_VERSION,
    source: first.source,
    project,
    sessionId,
    agent,
    startedAt,
    lastEventAt,
    eventCount: ordered.length,
    promptCount,
    turnCount,
    toolCallCount,
    commandCallCount,
    inputTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
    linesAdded,
    linesRemoved,
    durationMs: Math.max(0, Date.parse(lastEventAt) - Date.parse(startedAt)),
    timeBuckets: [...timeBuckets.values()].sort((a, b) => a.ts.localeCompare(b.ts)),
    modelRollups: [...modelRollups.values()].sort((a, b) => b.callCount - a.callCount || a.model.localeCompare(b.model)),
    modelBuckets: [...modelBuckets.values()].sort((a, b) => a.ts.localeCompare(b.ts) || a.model.localeCompare(b.model)),
    toolRollups: [...toolRollups.values()].sort((a, b) => b.callCount - a.callCount || a.tool.localeCompare(b.tool)),
    fileRollups: [...fileRollups.values()].sort((a, b) => b.writes - a.writes || b.reads - a.reads || a.displayPath.localeCompare(b.displayPath)),
    turnRollups: [...turnRollups.values()]
      .map((rollup) => ({
        ...rollup,
        durationMs: gapClampedTurnDurationMs(rollup, turnEventTimes.get(rollup.turnId) || []),
      }))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
  };
  return { ...baseRollup, payloadHash: createPayloadHash(baseRollup) };
}

// ── config / token / machine identity (mirror codetime-cli) ───────────────
function configPath(home) {
  return path.join(home, ".codetime", "config.json");
}

function machineIdPath(home) {
  return path.join(home, ".codetime", "machine-id");
}

function readConfigFile(home) {
  try {
    if (!existsSync(configPath(home))) return {};
    const parsed = JSON.parse(readFileSync(configPath(home), "utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function ensureMachineId(home) {
  const file = machineIdPath(home);
  const readExisting = () => {
    try {
      const value = readFileSync(file, "utf8").trim();
      return value.length > 0 ? value : null;
    } catch {
      return null;
    }
  };
  const existing = readExisting();
  if (existing) return existing;
  const id = randomUUID();
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${id}\n`, { flag: "wx", mode: 0o600 });
    return id;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    return readExisting() || id;
  }
}

function joinUrl(base, target) {
  return new URL(target, base.endsWith("/") ? base : `${base}/`).toString();
}

// ── the backend ───────────────────────────────────────────────────────────
var CodetimeSessionBackend = class extends SessionTelemetryBackend {
  static inject = ["sessions", "timer"];

  constructor(ctx, config) {
    super(ctx);

    const mode = resolveMode(config?.mode);
    this.mode = mode;
    this.sharing = sharingStatusFor(mode);

    const env = process.env || {};
    const home = homedir();
    const stored = readConfigFile(home);
    this.baseUrl = (config?.apiUrl || env.CODETIME_API_URL || stored.remoteUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.token = config?.token || env.CODETIME_TOKEN || stored.token || "";
    this.flushIntervalMs = positiveInt(config?.flushIntervalMs, DEFAULT_FLUSH_INTERVAL_MS);
    this.shutdownTimeoutMs = positiveInt(config?.shutdownTimeoutMs, DEFAULT_SHUTDOWN_TIMEOUT_MS);

    this.machine = {
      id: ensureMachineId(home),
      hostname: hostname(),
      displayName: stored.machineName || hostname(),
      platform: process.platform,
    };

    this.fetchImpl = typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined;

    // Per-session accumulation: canonical events buffered until the next flush.
    this.sessions = new Map();
    this.flushing = undefined;

    const backend = {
      emit: (record) => this.emit(record),
      flush: () => this.flush(),
      shutdown: () => this.shutdown(),
    };

    if (mode === "DISABLED") {
      ctx.on("session/event", (_session, event) => {
        if (event.type === "feedback/record") {
          ctx.logger.warn("codetime: session telemetry is DISABLED; nothing will be shared");
        }
      });
      return;
    }

    // Capture session headers (cwd, createdAt) so session.started carries the
    // exact creation time rather than the first event's derived timestamp.
    ctx.on("session/created", (session) => this.adoptHeader(session));

    if (mode === "FULL") {
      new SessionTelemetryCoordinator(ctx, backend, "live");
    } else {
      const coordinator = new SessionTelemetryCoordinator(ctx, backend, "on-demand");
      ctx.on("session/event", (session, event) => {
        if (event.type !== "feedback/record") return;
        if (session.events[event.seq] !== event) {
          ctx.logger.warn("codetime: ignored a feedback event absent from the canonical session log");
          return;
        }
        coordinator.captureSession(session, event.seq);
      });
    }

    // Periodic rollup flush. The timer service owns the interval, so it is
    // disposed with this fiber on stop.
    ctx.interval(() => this.flushAll(), this.flushIntervalMs);
  }

  adoptHeader(session) {
    const header = session?.header;
    if (!header) return;
    const cwd = header.cwd;
    const state = this.ensureSession(String(session.id));
    if (cwd !== undefined) {
      state.cwd = cwd;
      state.project = path.basename(cwd);
    }
    if (typeof header.createdAt === "number") state.createdAt = header.createdAt;
    // A resumed/forked session re-enters this process with a seed prefix; its
    // true creation predates the live activity we are about to observe, so
    // `session.started` should anchor on the first live event instead.
    state.resumed = typeof session.firstLiveSeq === "number" && session.firstLiveSeq > 0;
  }

  ensureSession(sessionId) {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = {
        id: sessionId,
        cwd: undefined,
        project: undefined,
        createdAt: undefined,
        model: undefined,
        currentTurn: undefined,
        started: false,
        resumed: false,
        dirty: false,
        events: [],
        pendingTools: new Map(),
      };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  emit(record) {
    if (this.mode === "DISABLED") return;

    // Operational channel: shutdown / agent-error markers.
    if (record?.channel === "ops") {
      const op = record.attributes?.["telemetry.op"];
      if (op === "shutdown") {
        const sessionId = String(record.attributes?.["session.id"]);
        const state = this.ensureSession(sessionId);
        this.ensureSessionStarted(state, record);
        state.events.push(this.baseEvent(state, {
          ts: iso(record.time),
          type: "session.ended",
          confidence: "derived",
        }));
        state.dirty = true;
        this.scheduleFlush();
      }
      return;
    }

    if (record?.channel !== "ledger") return;

    const sessionId = String(record.attributes?.["session.id"]);
    const state = this.ensureSession(sessionId);

    // Lazily backfill cwd/project from the record identity when no header was
    // captured (sessions already live before this backend was constructed).
    const cwd = record.attributes?.["session.cwd"];
    if (state.cwd === undefined && typeof cwd === "string" && cwd.length > 0) {
      state.cwd = cwd;
      state.project = path.basename(cwd);
    }

    this.ensureSessionStarted(state, record);

    const events = this.translate(state, record);
    if (events.length > 0) {
      state.events.push(...events);
      state.dirty = true;
    }
  }

  ensureSessionStarted(state, record) {
    if (state.started) return;
    state.started = true;
    const exact = typeof state.createdAt === "number" && !state.resumed;
    const ts = exact ? iso(state.createdAt) : iso(record.time);
    state.events.push(this.baseEvent(state, {
      ts,
      type: "session.started",
      confidence: exact ? "exact" : "derived",
    }));
  }

  baseEvent(state, overrides) {
    return {
      schemaVersion: AGENT_TIME_SCHEMA_VERSION,
      source: SOURCE_ID,
      agent: AGENT_NAME,
      workspaceId: createWorkspaceId({ projectName: state.project, repoRoot: state.cwd }),
      sessionId: state.id,
      project: state.project,
      ...overrides,
    };
  }

  translate(state, record) {
    const type = record.attributes?.["event.type"];
    const body = record.body;
    const ts = iso(record.time);
    const out = [];
    const push = (event) => out.push(event);
    const turnId = (turn) => (typeof turn === "number" ? `turn_${turn}` : undefined);

    switch (type) {
      case "turn/start": {
        if (typeof body?.turn === "number") state.currentTurn = body.turn;
        push(this.baseEvent(state, { ts, type: "turn.started", turnId: turnId(body?.turn), confidence: "exact" }));
        break;
      }
      case "turn/end": {
        const failed = body?.reason?.kind === "error";
        push(this.baseEvent(state, {
          ts,
          type: failed ? "turn.failed" : "turn.completed",
          turnId: turnId(body?.turn),
          success: !failed,
          confidence: "exact",
        }));
        break;
      }
      case "user/message": {
        if (body?.source?.kind !== "user") break; // skip injected/plugin context
        const text = messageText(body.content);
        push(this.baseEvent(state, {
          ts,
          type: "prompt.submitted",
          turnId: turnId(state.currentTurn),
          confidence: "exact",
          metrics: { prompts: 1, promptChars: text?.length },
          refs: text ? { promptHash: `sha256:${createStableHash(text)}` } : undefined,
        }));
        break;
      }
      case "assistant/message": {
        const usage = mapTokenUsage(body?.usage);
        if (body?.message?.source?.model) state.model = body.message.source.model;
        if (usage) {
          push(this.baseEvent(state, {
            ts,
            type: "model.usage",
            turnId: turnId(body?.turn),
            model: state.model,
            confidence: "exact",
            metrics: usage,
          }));
        }
        break;
      }
      case "request/context": {
        if (typeof body?.model === "string" && body.model.length > 0) state.model = body.model;
        break; // metadata only, no event
      }
      case "tool/call": {
        const callId = body?.callId;
        const tool = body?.name || "tool";
        if (callId) {
          state.pendingTools.set(String(callId), {
            name: tool,
            arguments: body?.arguments,
            turn: body?.turn,
            ts: record.time,
          });
        }
        push(this.baseEvent(state, {
          ts,
          type: "tool.started",
          operation: `${tool} started`,
          turnId: turnId(body?.turn),
          tool,
          confidence: "exact",
          metrics: { toolCalls: 1 },
          refs: callId ? { sourceId: String(callId) } : undefined,
        }));
        break;
      }
      case "tool/result": {
        const resultBlock = Array.isArray(body?.message?.content) ? body.message.content[0] : undefined;
        const callId = body?.message?.source?.callId ?? resultBlock?.toolCallId;
        const isError = resultBlock?.isError === true || body?.error != null;
        const pending = callId ? state.pendingTools.get(String(callId)) : undefined;
        if (callId) state.pendingTools.delete(String(callId));
        const tool = pending?.name || "tool";
        const duration = pending ? Math.max(0, record.time - pending.ts) : undefined;

        push(this.baseEvent(state, {
          ts,
          type: isError ? "tool.failed" : "tool.completed",
          operation: `${tool} completed`,
          turnId: turnId(body?.turn ?? pending?.turn),
          tool,
          success: !isError,
          confidence: "exact",
          metrics: duration ? { toolDurationMs: duration, durationMs: duration } : undefined,
          refs: callId ? { sourceId: String(callId) } : undefined,
        }));

        const args = safeParseJson(pending?.arguments);
        const fileActivities = fileActivitiesForTool(tool, args, ts);
        if (fileActivities.length > 0) {
          push(this.baseEvent(state, {
            ts,
            type: eventTypeFromFileActivities(fileActivities),
            operation: `${tool} file activity`,
            turnId: turnId(body?.turn ?? pending?.turn),
            tool,
            confidence: "derived",
            fileActivities,
            metrics: summarizeFileActivities(fileActivities),
            refs: callId ? { sourceId: String(callId) } : undefined,
          }));
        }

        if (isShellTool(tool)) {
          const command = typeof args?.command === "string" ? args.command : undefined;
          push(this.baseEvent(state, {
            ts,
            type: isError ? "command.failed" : "command.completed",
            operation: `${tool} completed`,
            turnId: turnId(body?.turn ?? pending?.turn),
            tool,
            success: !isError,
            confidence: "derived",
            metrics: { commandCalls: 1, commandDurationMs: duration, durationMs: duration },
            refs: command ? { commandHash: createStableHash(command) } : undefined,
          }));
        }
        break;
      }
      case "compaction/end": {
        push(this.baseEvent(state, { ts, type: "context.compacted", confidence: "derived" }));
        break;
      }
      default:
        break; // step/start, step/end, assistant/chunk, todo, approvals, … are not coding activity
    }

    return out;
  }

  // Fire-and-forget throttled flush (the seam's `flush` hint fires at turn end).
  scheduleFlush() {
    this.flushAll().catch((error) => this.ctx.logger.warn(`codetime: flush failed: ${String(error)}`));
  }

  flush() {
    this.scheduleFlush();
  }

  flushAll() {
    if (this.flushing) return this.flushing;
    this.flushing = this._flushAll().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  async _flushAll() {
    if (!this.fetchImpl || !this.token) return;
    const dirty = [...this.sessions.values()].filter((state) => state.dirty && state.events.length > 0);
    if (dirty.length === 0) return;

    const rollups = dirty.map((state) => buildSessionRollup(state.id, state.events));
    try {
      await this.postRollups(rollups);
      for (const state of dirty) state.dirty = false;
      this.ctx.logger.info(`codetime: flushed ${rollups.length} session rollup(s)`);
    } catch (error) {
      // Best-effort reporting: keep the dirty flag so the next tick retries.
      this.ctx.logger.warn(`codetime: flush failed: ${String(error)}`);
    }
  }

  async postRollups(rollups) {
    const response = await this.fetchImpl(joinUrl(this.baseUrl, "/v3/agent/ingest"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": `codetime-dsh/${PACKAGE_VERSION}`,
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...(this.machine?.id ? { "x-machine-id": this.machine.id } : {}),
        ...(this.machine?.hostname ? { "x-machine-hostname": this.machine.hostname } : {}),
        ...(this.machine?.displayName ? { "x-machine-name": this.machine.displayName } : {}),
        ...(this.machine?.platform ? { "x-machine-platform": this.machine.platform } : {}),
      },
      body: JSON.stringify({ rollups, replace: true }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`codetime API ${response.status}: ${body.slice(0, 4000)}`);
    }
    const data = await response.json();
    return {
      inserted: Number(data.inserted) || 0,
      skipped: Number(data.skipped) || 0,
      conflicts: Number(data.conflicts) || 0,
    };
  }

  async shutdown() {
    if (this.mode === "DISABLED") return;
    // Final drain, bounded so a stalled network cannot hang teardown.
    let timer;
    const deadline = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`codetime: shutdown exceeded ${this.shutdownTimeoutMs}ms`)), this.shutdownTimeoutMs);
    });
    try {
      await Promise.race([this.flushAll(), deadline]);
    } catch (error) {
      this.ctx.logger.warn(`codetime: shutdown drain failed: ${String(error)}`);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
};

function resolveMode(mode) {
  const resolved = mode ?? "DISABLED";
  if (resolved === "FULL" || resolved === "FEEDBACK_ONLY" || resolved === "DISABLED") return resolved;
  throw new Error(`codetime: unsupported mode ${JSON.stringify(resolved)}`);
}

function sharingStatusFor(mode) {
  switch (mode) {
    case "FULL": return "full";
    case "FEEDBACK_ONLY": return "feedback-only";
    case "DISABLED": return "disabled";
    default: return "disabled";
  }
}

function positiveInt(value, fallback) {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export { CodetimeSessionBackend, buildSessionRollup, CodetimeSessionBackend as default };

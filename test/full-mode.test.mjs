// FULL mode: every canonical session event is captured live and rolled up into
// the agent wire format codetime-cli uses.
import assert from "node:assert/strict";
import test from "node:test";
import { WORKSPACE, assistantMessage, fileRollup, rollupFrom, seedSession, startBackend, waitFor } from "./harness.mjs";

const INGEST_URL = "https://codetime.test/v3/agent/ingest";

test("FULL mode posts one session rollup per dirty session", async (t) => {
  const app = await startBackend();
  t.after(() => app.dispose());

  const session = app.ctx.sessions.create("session-live", { meta: { cwd: WORKSPACE } });
  seedSession(session);
  await app.flush();

  assert.equal(app.posts.length, 1);
  const post = app.posts[0];
  assert.equal(post.url, INGEST_URL);
  assert.equal(post.headers.authorization, "Bearer test-token");
  assert.match(post.headers["user-agent"], /^codetime-dsh\/\d+\.\d+\.\d+/);
  assert.equal(post.body.replace, true);

  const rollup = rollupFrom(app.posts);
  assert.equal(rollup.source, "dsh");
  assert.equal(rollup.agent, "dsh");
  assert.equal(rollup.sessionId, "session-live");
  assert.equal(rollup.project, "dsh-codetime-fixture");
  assert.equal(rollup.schemaVersion, 3);
  assert.match(rollup.rollupKey, /^rollup:dsh:sha256%3A[0-9a-f]{64}:session-live$/);
  assert.match(rollup.payloadHash, /^sha256:[0-9a-f]{64}$/);

  // session.started, turn.started, prompt.submitted, model.usage, 7×tool.started,
  // 6×tool.completed + 1×tool.failed, 5×file activity (the failed edit derives
  // none), command.completed, turn.completed.
  assert.equal(rollup.eventCount, 25);
  assert.equal(rollup.promptCount, 1);
  assert.equal(rollup.turnCount, 1);
  assert.equal(rollup.toolCallCount, 7);
  assert.equal(rollup.commandCallCount, 1);
});

test("model usage is folded per model with cache fields kept separate", async (t) => {
  const app = await startBackend();
  t.after(() => app.dispose());

  seedSession(app.ctx.sessions.create("session-tokens", { meta: { cwd: WORKSPACE } }));
  await app.flush();
  const rollup = rollupFrom(app.posts);

  // TokenUsage counters are disjoint: 1000 uncached + 4000 cache-read + 50 cache-write.
  assert.equal(rollup.inputTokens, 5050);
  assert.equal(rollup.cachedInputTokens, 4050);
  assert.equal(rollup.cacheReadInputTokens, 4000);
  assert.equal(rollup.cacheCreationInputTokens, 50);
  assert.equal(rollup.outputTokens, 200);
  assert.equal(rollup.reasoningOutputTokens, 30);
  assert.equal(rollup.totalTokens, 5250);

  assert.equal(rollup.modelRollups.length, 1);
  const model = rollup.modelRollups[0];
  assert.equal(model.model, "deepseek-flash");
  assert.equal(model.callCount, 1);
  assert.equal(model.totalTokens, 5250);
  assert.equal(rollup.modelBuckets.reduce((sum, bucket) => sum + bucket.callCount, 0), 1);
});

test("an adapter-reported aggregate total wins over the summed counters", async (t) => {
  const app = await startBackend();
  t.after(() => app.dispose());

  const session = app.ctx.sessions.create("session-total", { meta: { cwd: WORKSPACE } });
  session.append(
    "assistant/message",
    {
      turn: 1,
      step: 1,
      message: assistantMessage("hi"),
      stream: [],
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 999 },
    },
    { surfaceOp: "append" },
  );
  await app.flush();
  const rollup = rollupFrom(app.posts);
  assert.equal(rollup.totalTokens, 999);
  assert.equal(rollup.inputTokens, 10);
});

test("tool rollups count calls and real failures", async (t) => {
  const app = await startBackend();
  t.after(() => app.dispose());

  seedSession(app.ctx.sessions.create("session-tools", { meta: { cwd: WORKSPACE } }));
  await app.flush();
  const rollup = rollupFrom(app.posts);

  const byTool = new Map(rollup.toolRollups.map((tool) => [tool.tool, tool]));
  assert.equal(byTool.get("read").callCount, 1);
  assert.equal(byTool.get("read").failureCount, 0);
  // `edit` ran twice: once successfully, once with `isError` on the tool/result
  // *message* — the 0.2.x failure identity, not a content block.
  assert.equal(byTool.get("edit").callCount, 2);
  assert.equal(byTool.get("edit").failureCount, 1);
  assert.equal(byTool.get("pwsh").callCount, 1);
  assert.equal(byTool.get("str_replace_editor").callCount, 1);
});

test("file activity distinguishes reads, searches, writes and line deltas", async (t) => {
  const app = await startBackend();
  t.after(() => app.dispose());

  seedSession(app.ctx.sessions.create("session-files", { meta: { cwd: WORKSPACE } }));
  await app.flush();
  const rollup = rollupFrom(app.posts);

  const edited = fileRollup(rollup, `${WORKSPACE}\\lib\\index.js`);
  assert.equal(edited.reads, 1); // read tool
  assert.equal(edited.writes, 2); // edit + str_replace_editor str_replace
  assert.equal(edited.linesAdded, 3 + 3); // "a\nb\nc" and "x\ny\nz"
  assert.equal(edited.linesRemoved, 2 + 2); // "a\nb" and "x\ny"

  const written = fileRollup(rollup, `${WORKSPACE}\\lib\\new.js`);
  assert.equal(written.writes, 1);
  assert.equal(written.linesAdded, 3); // "one\ntwo\nthree"

  // A search tool reports against the directory it searched.
  assert.equal(fileRollup(rollup, WORKSPACE).reads, 1);

  // The failed edit never happened, so it must not appear as file activity.
  assert.equal(fileRollup(rollup, `${WORKSPACE}\\lib\\broken.js`), undefined);

  const buckets = rollup.timeBuckets;
  const sum = (key) => buckets.reduce((total, bucket) => total + bucket[key], 0);
  assert.equal(sum("fileReads"), 2);
  assert.equal(sum("fileWrites"), 3);
  assert.equal(sum("commandCalls"), 1);
  assert.equal(sum("sessionStarts"), 1);
  assert.equal(sum("toolCalls"), 7);
  assert.equal(sum("activityCount") > 0, true);
});

test("turn rollups anchor on the prompt and close on turn/end", async (t) => {
  const app = await startBackend();
  t.after(() => app.dispose());

  seedSession(app.ctx.sessions.create("session-turn", { meta: { cwd: WORKSPACE } }));
  await app.flush();
  const rollup = rollupFrom(app.posts);

  assert.equal(rollup.turnRollups.length, 1);
  const turn = rollup.turnRollups[0];
  assert.equal(turn.turnId, "turn_1");
  assert.equal(turn.toolCallCount, 7);
  assert.ok(turn.durationMs >= 0);
  assert.ok(turn.completedAt !== undefined);
  assert.ok(turn.lastEventAt >= turn.startedAt);
});

test("a growing session re-sends one idempotent rollup under a stable key", async (t) => {
  const app = await startBackend();
  t.after(() => app.dispose());

  const session = app.ctx.sessions.create("session-resend", { meta: { cwd: WORKSPACE } });
  session.append("turn/start", { turn: 1 });
  await app.flush();
  const first = rollupFrom(app.posts);
  assert.equal(first.eventCount, 2);

  session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
  await app.flush();
  assert.equal(app.posts.length, 2);
  const second = rollupFrom(app.posts, 1);
  assert.equal(second.eventCount, 3);
  assert.equal(second.rollupKey, first.rollupKey, "the stable upsert key must not change as the log grows");
  assert.notEqual(second.payloadHash, first.payloadHash);
});

test("the session/flush durability checkpoint hints an upload", async (t) => {
  const app = await startBackend();
  t.after(() => app.dispose());

  const session = app.ctx.sessions.create("session-flush", { meta: { cwd: WORKSPACE } });
  seedSession(session);
  assert.deepEqual(app.posts, [], "nothing is uploaded before a flush is requested");

  // 0.2.x relays `session/flush` to the backend's optional `flush()` hint, so a
  // durability checkpoint pushes the rollup without waiting for the interval.
  await app.ctx.sessions.flush(session);
  await waitFor(() => app.posts.length === 1);
  assert.equal(rollupFrom(app.posts).sessionId, "session-flush");
});

test("an operational shutdown record closes the session", async (t) => {
  const app = await startBackend();
  t.after(() => app.dispose());

  const session = app.ctx.sessions.create("session-end", { meta: { cwd: WORKSPACE } });
  session.append("turn/start", { turn: 1 });
  app.backend.emit({
    channel: "ops",
    time: Date.now(),
    severity: "info",
    attributes: { "telemetry.op": "shutdown", "session.id": "session-end" },
    body: { op: "shutdown" },
  });
  await app.flush();

  const rollup = rollupFrom(app.posts);
  assert.equal(rollup.sessionId, "session-end");
  assert.equal(rollup.eventCount, 3); // session.started, turn.started, session.ended
});

test("a seeded session anchors session.started on live activity, not stored history", async (t) => {
  const app = await startBackend();
  t.after(() => app.dispose());

  const storedCreatedAt = Date.now() - 86_400_000;
  // A restored/forked session re-enters with a seed prefix, so what the header
  // records as its creation time predates the activity this process sees.
  app.backend.adoptHeader({
    id: "session-seeded",
    header: { cwd: WORKSPACE, createdAt: storedCreatedAt },
    firstLiveSeq: 12,
  });
  const state = app.backend.ensureSession("session-seeded");
  assert.equal(state.resumed, true);
  assert.equal(state.project, "dsh-codetime-fixture");

  const time = Date.now();
  app.backend.emit({
    channel: "ledger",
    time,
    severity: "info",
    attributes: { "event.type": "turn/start", "session.id": "session-seeded" },
    body: { turn: 1 },
  });

  const started = state.events[0];
  assert.equal(started.type, "session.started");
  assert.equal(started.confidence, "derived");
  assert.equal(started.ts, new Date(time).toISOString());
});

test("an unseeded session reports its header creation time as exact", async (t) => {
  const app = await startBackend();
  t.after(() => app.dispose());

  const createdAt = Date.now() - 5_000;
  app.backend.adoptHeader({
    id: "session-fresh",
    header: { cwd: WORKSPACE, createdAt },
    firstLiveSeq: 0,
  });
  app.backend.emit({
    channel: "ledger",
    time: Date.now(),
    severity: "info",
    attributes: { "event.type": "turn/start", "session.id": "session-fresh" },
    body: { turn: 1 },
  });

  const started = app.backend.ensureSession("session-fresh").events[0];
  assert.equal(started.confidence, "exact");
  assert.equal(started.ts, new Date(createdAt).toISOString());
});

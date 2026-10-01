// FEEDBACK_ONLY is an authorization boundary, not a batching preference:
// nothing leaves the process until the human records feedback, and then the
// whole canonical log (including fork-inherited history) goes with it.
import assert from "node:assert/strict";
import test from "node:test";
import { SessionId, SessionLogOffset } from "@deepseek-ai/dsh-session";
import { WORKSPACE, rollupFrom, seedSession, startBackend } from "./harness.mjs";

test("FEEDBACK_ONLY uploads nothing until feedback is recorded", async (t) => {
  const app = await startBackend({ mode: "FEEDBACK_ONLY" });
  t.after(() => app.dispose());

  seedSession(app.ctx.sessions.create("session-quiet", { meta: { cwd: WORKSPACE } }));
  await app.flush();
  assert.deepEqual(app.posts, [], "ordinary activity must never be uploaded in FEEDBACK_ONLY");
});

test("FEEDBACK_ONLY uploads the whole log once feedback arrives", async (t) => {
  const app = await startBackend({ mode: "FEEDBACK_ONLY" });
  t.after(() => app.dispose());

  const session = app.ctx.sessions.create("session-feedback", { meta: { cwd: WORKSPACE } });
  seedSession(session);
  await app.flush();
  assert.deepEqual(app.posts, []);

  session.append("feedback/record", { text: "the port works" });
  await app.flush();

  assert.equal(app.posts.length, 1);
  const rollup = rollupFrom(app.posts);
  assert.equal(rollup.sessionId, "session-feedback");
  assert.equal(rollup.promptCount, 1);
  assert.equal(rollup.turnCount, 1);
  assert.equal(rollup.toolCallCount, 7, "the authorized capture replays the full canonical log");
});

test("FEEDBACK_ONLY ignores a feedback event that is not in the canonical log", async (t) => {
  const app = await startBackend({ mode: "FEEDBACK_ONLY" });
  t.after(() => app.dispose());

  const session = app.ctx.sessions.create("session-forged", { meta: { cwd: WORKSPACE } });
  session.append("turn/start", { turn: 1 });
  const notCanonical = { type: "feedback/record", seq: 99, time: Date.now(), data: { text: "nope" } };
  app.ctx.emit("session/event", session, notCanonical);
  await app.flush();

  assert.deepEqual(app.posts, [], "a feedback event absent from the log must not authorize an upload");
});

test("FEEDBACK_ONLY does not let inherited fork history authorize an upload", async (t) => {
  const app = await startBackend({ mode: "FEEDBACK_ONLY" });
  t.after(() => app.dispose());

  const parent = app.ctx.sessions.create("session-parent", { meta: { cwd: WORKSPACE } });
  parent.append("turn/start", { turn: 1 });
  parent.append("feedback/record", { text: "parent feedback" });
  await app.flush();
  // The parent's own feedback authorizes the parent.
  assert.equal(app.posts.length, 1);
  assert.equal(rollupFrom(app.posts).sessionId, "session-parent");

  // A fork inherits the parent's feedback events; they are not the child's to upload.
  app.posts.length = 0;
  const inherited = parent.snapshotEvents();
  const child = app.ctx.sessions.create("session-child", {
    seed: inherited,
    inheritedEventCount: SessionLogOffset(inherited.length),
    meta: { cwd: WORKSPACE, isSeeded: true, parentSession: SessionId("session-parent") },
  });
  await app.flush();
  assert.deepEqual(app.posts, [], "inherited feedback must not authorize the child session");

  child.append("feedback/record", { text: "child feedback" });
  await app.flush();
  assert.equal(app.posts.length, 1, "the child's own feedback authorizes its own upload");
  assert.equal(rollupFrom(app.posts).sessionId, "session-child");
});

test("FEEDBACK_ONLY captures feedback committed outside a live session", async (t) => {
  const app = await startBackend({ mode: "FEEDBACK_ONLY" });
  t.after(() => app.dispose());

  const live = app.ctx.sessions.create("session-cold", { meta: { cwd: WORKSPACE } });
  seedSession(live);
  const events = [...live.snapshotEvents()];
  const header = { ...live.header, id: SessionId("session-cold") };
  const committed = {
    type: "feedback/record",
    seq: SessionLogOffset(events.length),
    time: Date.now(),
    data: { text: "committed through the message-feedback Remote" },
  };
  await app.flush();
  assert.deepEqual(app.posts, [], "a cold session alone authorizes nothing");

  app.ctx.emit("feedback/committed", {
    events: [...events, committed],
    meta: header,
    inheritedEventCount: SessionLogOffset(0),
  });
  await app.flush();
  assert.equal(app.posts.length, 1);
  assert.equal(rollupFrom(app.posts).sessionId, "session-cold");
  assert.equal(rollupFrom(app.posts).promptCount, 1);
});

test("DISABLED reports nothing at all", async (t) => {
  const app = await startBackend({ mode: "DISABLED" });
  t.after(() => app.dispose());

  const session = app.ctx.sessions.create("session-disabled", { meta: { cwd: WORKSPACE } });
  seedSession(session);
  await app.flush();
  await app.ctx.sessionTelemetry.shutdown();
  assert.deepEqual(app.posts, []);
});

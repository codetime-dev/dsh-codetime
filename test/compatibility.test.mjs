// The one gate that decides whether DSH will install this plugin at all:
// `@deepseek-ai/dsh-app-boot`'s plugin compatibility check rejects a plugin
// whose `@deepseek-ai/dsh*` peer ranges do not satisfy the running runtime.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import TimerService from "@deepseek-ai/cordis-plugin-timer";
import SessionStore from "@deepseek-ai/dsh-session";
import { evaluatePluginCompatibility, getDshRuntimeVersion } from "@deepseek-ai/dsh-app-boot";
import CodetimeSessionBackend, { buildSessionRollup } from "../lib/index.js";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("the running dsh runtime accepts this plugin's dsh peers", () => {
  const runtimeVersion = getDshRuntimeVersion();
  const [major, minor] = runtimeVersion.split(".").map(Number);
  assert.ok(
    major > 0 || minor >= 2,
    `this backend targets the 0.2.x seam; the installed dsh is ${runtimeVersion}`,
  );
  const issue = evaluatePluginCompatibility(manifest, {}, runtimeVersion);
  assert.equal(
    issue,
    undefined,
    issue && `dsh ${issue.runtimeVersion} rejects ${issue.name}@${issue.version}: ${JSON.stringify(issue.peers)}`,
  );
});

test("no dsh peer pins a prerelease range again", () => {
  for (const [name, range] of Object.entries(manifest.peerDependencies)) {
    if (name !== "@deepseek-ai/dsh" && !name.startsWith("@deepseek-ai/dsh-")) continue;
    assert.ok(
      !/-(?:rc|alpha|beta)\./.test(range),
      `${name}:${range} pins a prerelease the next dsh prerelease would fall outside of`,
    );
  }
  assert.equal(manifest.dependencies, undefined, "the backend must not pin its own copy of a dsh package");
});

test("the backend registers the process-global sessionTelemetry service", async () => {
  const ctx = new Context();
  await ctx.plugin(TimerService);
  await ctx.plugin(SessionStore);
  await ctx.plugin(CodetimeSessionBackend, { mode: "DISABLED" });
  assert.ok(ctx.sessionTelemetry instanceof CodetimeSessionBackend);
  assert.equal(ctx.sessionTelemetry.sharing, "disabled");
  await ctx.fiber.dispose();
});

test("a second backend cannot claim the same service", async () => {
  const ctx = new Context();
  await ctx.plugin(TimerService);
  await ctx.plugin(SessionStore);
  await ctx.plugin(CodetimeSessionBackend, { mode: "FULL" });
  await assert.rejects(
    async () => {
      await ctx.plugin(CodetimeSessionBackend, { mode: "DISABLED" });
    },
    /service "sessionTelemetry" has been registered/,
  );
  // The live backend survives the rejected duplicate: `sessionTelemetry` is a
  // process-global singleton, which is why the shipped patch disables the
  // base bundle's otel backend first.
  assert.equal(ctx.get("sessionTelemetry").sharing, "full");
  await ctx.fiber.dispose();
});

test("an unsupported mode fails closed and rolls its registration back", async () => {
  const ctx = new Context();
  await ctx.plugin(TimerService);
  await ctx.plugin(SessionStore);
  await assert.rejects(async () => {
    await ctx.plugin(CodetimeSessionBackend, { mode: "SOMETIMES" });
  }, /unsupported mode "SOMETIMES"/);
  assert.equal(ctx.get("sessionTelemetry"), undefined);

  // The failure must not poison the seam: a valid backend still mounts.
  await ctx.plugin(CodetimeSessionBackend, { mode: "DISABLED" });
  assert.equal(ctx.sessionTelemetry.sharing, "disabled");
  await ctx.fiber.dispose();
});

test("buildSessionRollup is exported for wire-format consumers", () => {
  assert.equal(typeof buildSessionRollup, "function");
});

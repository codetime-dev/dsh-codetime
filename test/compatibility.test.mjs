// The gates that decide whether DSH will install this plugin at all:
// `@deepseek-ai/dsh-app-boot` refuses a package that declares no
// `dsh.bundle.patch` ("declares no dsh.bundle"), and refuses any
// `@deepseek-ai/dsh*` peer range that does not satisfy the running runtime.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import TimerService from "@deepseek-ai/cordis-plugin-timer";
import SessionStore from "@deepseek-ai/dsh-session";
import {
  bundlePatchFiles,
  bundlePatchPaths,
  evaluatePluginCompatibility,
  getDshRuntimeVersion,
  loadOverlayPatches,
} from "@deepseek-ai/dsh-app-boot";
import CodetimeSessionBackend, { buildSessionRollup } from "../lib/index.js";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("the package is installable as a dsh bundle", () => {
  const bundle = manifest.dsh?.bundle;
  assert.ok(bundle, "package.json must declare dsh.bundle or dsh refuses it as `not-a-bundle`");
  assert.deepEqual(bundlePatchFiles(bundle), ["./cordis.patch.yml"]);
  const [patchPath] = bundlePatchPaths(packageDir, bundle);
  assert.ok(existsSync(patchPath), `the declared bundle patch must exist: ${patchPath}`);
  assert.ok(manifest.files.includes("cordis.patch.yml"), "the declared patch must ship in the published tarball");
});

test("the bundle patch mounts the backend over the otel default", () => {
  const [patchPath] = bundlePatchPaths(packageDir, manifest.dsh.bundle);
  const patches = loadOverlayPatches(manifest.name, patchPath);

  const otel = patches.find((row) => row.id === "session-telemetry-otel");
  assert.equal(otel?.disabled, true, "the sessionTelemetry singleton must be released before this backend mounts");

  const row = patches.flatMap((entry) => entry.insert ?? []).find((entry) => entry.id === "session-telemetry-codetime");
  assert.ok(row, "the bundle patch must insert the plugin row");
  assert.equal(row.name, manifest.name);
  assert.equal(row.config.mode.__jsExpr, "process.env.CODETIME_MODE || 'FULL'");
  assert.equal(row.config.apiUrl.__jsExpr, "process.env.CODETIME_API_URL || 'https://codetime.dev'");
  assert.equal(row.config.flushIntervalMs, 60_000);
  assert.equal(row.config.shutdownTimeoutMs, 5_000);
});


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

# CodeTime for DeepSeek Harness

Automatic coding-time tracking for [codetime.dev](https://codetime.dev), ported
to the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(dsh). This is the **native dsh telemetry backend** — the dsh-side sibling of
`codetime-cli`'s agent adapters for Claude Code / Codex / OpenCode / Pi.

It reports session, turn, tool, file, and model activity to the same agent
ingest endpoint the CLI uses (`POST /v3/agent/ingest`), so dsh activity lands
on the same dashboard as your other AI-agent tools.

Built for **dsh `0.2.x`** (verified against `0.2.0-rc.2`).

## How it works

dsh already ships a telemetry seam (`@deepseek-ai/dsh-session-telemetry`) that
captures session events live (or on demand), projects them, runs the
`session-telemetry/record` redaction waterfall, and hands
`SessionTelemetryRecord`s to any backend that implements `emit` / `flush` /
`shutdown`. This package is such a backend:

1. `SessionTelemetryCoordinator` drives `emit(record)` for every projected
   session event.
2. Each record is translated into a codetime **canonical event**
   (`session.started`, `turn.started`, `prompt.submitted`, `tool.started`,
   `tool.completed`, `file.changed`, `command.completed`, `model.usage`, …).
3. Events accumulate per session and are rolled up (15-minute buckets, per-model
   / per-tool / per-file / per-turn aggregates) with the exact wire format
   `codetime-cli` uses.
4. A flush POSTs `{ rollups, replace: true }` to `/v3/agent/ingest`, upserting
   each session's rollup by its stable key. `emit` only queues in memory (no
   I/O), so it never blocks the session firehose; batching, the periodic timer
   (`flushIntervalMs`), the `session/flush` hint, and the bounded shutdown drain
   own the network.

## Mapping

| dsh `session/event` type | codetime canonical event |
| --- | --- |
| `turn/start` / `turn/end` | `turn.started` / `turn.completed` \| `turn.failed` |
| `user/message` (direct prompt) | `prompt.submitted` |
| `assistant/message` (with `usage`) | `model.usage` |
| `tool/call` | `tool.started` |
| `tool/result` | `tool.completed` \| `tool.failed` + `file.read/changed/searched` |
| `tool/result` (bash/pwsh/…) | `command.completed` \| `command.failed` |
| `compaction/end` | `context.compacted` |
| session `created` / `disposed` | `session.started` / `session.ended` |

File activities are derived from the tool name and its parsed arguments:

| tool | derived activity |
| --- | --- |
| `read`, `read_image` | `read` |
| `write` | `write`, `linesAdded` from `content` |
| `edit` | `edit`, `linesAdded`/`linesRemoved` from `new_string`/`old_string` |
| `str_replace_editor` | `read` for `view`, `write` for `create`, otherwise `edit` with `old_str`/`new_str` |
| `grep`, `glob` | `search` against `path` |

A tool whose `tool/result` reports `message.isError` is a failure: it becomes
`tool.failed` (or `command.failed`), counts in `failureCount`, and contributes
**no** file activity, because the arguments describe a change that never
happened. `session.cwd` becomes the codetime `project` and `workspaceId`.

## Install & wire

The package is a **host-plane** plugin (a process-global `sessionTelemetry`
Service). Install it into your profile and add one row to the composition.

```sh
dsh plugin --profile web add dsh-codetime
```

Then merge the rows from [`cordis.patch.yml`](./cordis.patch.yml) into your
profile's `cordis.patch.yml` (or `$DSH_HOME/cordis.patch.yml`).

To run a checkout before the next npm release, add the directory instead of the
package name (`pnpm` installs it as a local link):

```sh
dsh plugin --profile web add /path/to/dsh-codetime      # or E:\path\to\dsh-codetime
```

> ⚠️ `sessionTelemetry` is a singleton — one backend per process. The base
> bundle always mounts `session-telemetry-otel` (even in its default
> `FEEDBACK_ONLY` mode it registers the Service), so **disable it** before
> mounting this backend — the shipped [`cordis.patch.yml`](./cordis.patch.yml)
> already does both.

### Installability

dsh `0.2.0-rc.2` inspects a plugin's `@deepseek-ai/dsh*` `peerDependencies`
before installing it and refuses the install when they do not satisfy the
running runtime. Those packages are supplied by the host profile, not by this
package, so the peers are declared as `*` — the convention the other
out-of-repo dsh plugins use. Pinning a prerelease range (`^0.1.0-rc.6`) makes
the next dsh prerelease reject the plugin outright; `npm test` asserts the
running runtime accepts this manifest.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `mode` | `DISABLED` (the shipped patch sets `FULL`) | `FULL` (capture every session live), `FEEDBACK_ONLY` (upload a session's log only after the human records `/feedback`), or `DISABLED`. An unknown value fails the boot instead of silently degrading. |
| `apiUrl` | `https://codetime.dev` | API base URL. |
| `flushIntervalMs` | `60000` | Rollup flush cadence. |
| `shutdownTimeoutMs` | `5000` | Upper bound on the final drain at teardown. |
| `token` | — | Bearer token; overrides the environment and the shared config file. |

Token resolution (first match wins): `token` config → `CODETIME_TOKEN` env →
`token` field of `~/.codetime/config.json`. If you already signed in with the
codetime CLI or another editor extension, the shared
`~/.codetime/config.json` token is picked up automatically. The `machine-id` in
`~/.codetime/machine-id` identifies the machine on the dashboard (created on
first use, shared with the CLI).

### `FEEDBACK_ONLY` is an authorization boundary

In `FEEDBACK_ONLY` nothing leaves the process until a `feedback/record` event is
appended to that session's own canonical log — ordinary activity is never
batched out. The capture is then *on demand* with `includeHistory`, so the
upload covers the **whole** canonical log, not just the events after the
feedback. Feedback inherited from a fork parent authorizes nothing for the
child, and feedback committed through the message-feedback Remote
(`feedback/committed`, which never publishes a live session) is rebuilt from its
committed inspection before capture. Mount your own `session-telemetry/record`
rules to redact the export.

## Limitations

- Event buffers are held per session in memory and re-sent whole each flush
  (idempotent upsert); very long-lived sessions grow their in-memory buffer.
- Historical sessions are **not** backfilled — this reports only activity the
  live process observes. Pair it with a `codetime-cli` `dsh` backfill adapter to
  import `~/.dsh/sessions/**/session.jsonl.zstd` history.
- No redaction rules are shipped: records leave the process exactly as captured
  by the seam (after any `session-telemetry/record` waterfall a deployment
  mounts).

## Development

```sh
npm install   # or: pnpm install
npm test
```

The suite boots the backend on a real cordis app with the genuine `sessions` and
`timer` services, drives real `Session` appends through the seam, and asserts the
captured ingest requests — plus the dsh install-compatibility gate itself.

## Publishing (npm)

Publishing runs through GitHub Actions using an npm **Trusted Publisher**
(OIDC): the workflow requests a short-lived token with `id-token: write`, so no
npm token is ever stored in the repository.

### One-time npm setup

1. If `dsh-codetime` does not exist on npm yet, publish the first version once
   from the command line to create it:

   ```sh
   npm publish --access public
   ```

2. On npmjs.com, open the package → **Settings** → **Publishing access** →
   **Add trusted publisher** (GitHub Actions):

   | Field | Value |
   | --- | --- |
   | Owner | `codetime-dev` |
   | Repository | `dsh-codetime` |
   | Workflow | `.github/workflows/publish.yml` |

   Leave **Environment** empty.

### Release a version

```sh
npm version patch          # or: minor / major — bumps package.json, commits, tags vX.Y.Z
git push --follow-tags
```

Pushing the `v*` tag triggers [`publish.yml`](.github/workflows/publish.yml),
which runs `npm publish --provenance --access public`. You can also trigger it
manually from the repository's **Actions** tab.

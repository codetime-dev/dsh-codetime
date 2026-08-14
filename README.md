# CodeTime for DeepSeek Harness

Automatic coding-time tracking for [codetime.dev](https://codetime.dev), ported
to the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(dsh). This is the **native dsh telemetry backend** — the dsh-side sibling of
`codetime-cli`'s agent adapters for Claude Code / Codex / OpenCode / Pi.

It reports session, turn, tool, file, and model activity to the same agent
ingest endpoint the CLI uses (`POST /v3/agent/ingest`), so dsh activity lands
on the same dashboard as your other AI-agent tools.

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
4. A periodic flush POSTs `{ rollups, replace: true }` to
   `/v3/agent/ingest`, upserting each session's rollup by its stable key.

`emit` only queues in memory (no I/O), so it never blocks the session firehose.
Batching, the periodic timer, and the bounded shutdown drain own the network.

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

File activities are derived from the tool name and its parsed arguments
(`read` → `read`, `write` → `write`, `edit`/`str_replace` → `edit` with
`linesAdded`/`linesRemoved`, `glob`/`grep` → `search`). `session.cwd` becomes
the codetime `project` and `workspaceId`.

## Install & wire

The package is a **host-plane** plugin (a process-global `sessionTelemetry`
Service). Install it into your profile and add one row to the composition.

```sh
dsh plugin --profile web add dsh-codetime
```

Then merge the row from [`cordis.patch.yml`](./cordis.patch.yml) into your
profile's `cordis.patch.yml` (or `$DSH_HOME/cordis.patch.yml`).

> ⚠️ `sessionTelemetry` is a singleton — one backend per process. The base
> bundle always mounts `session-telemetry-otel` (even in its default `DISABLED`
> mode it registers the Service), so **disable it** before mounting this backend
> — the shipped [`cordis.patch.yml`](./cordis.patch.yml) already does both.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `mode` | `FULL` (in the shipped patch) | `FULL` (live capture), `FEEDBACK_ONLY` (capture on `/feedback`), or `DISABLED`. The backend itself defaults to `DISABLED` when the key is absent. |
| `apiUrl` | `https://codetime.dev` | API base URL. |
| `flushIntervalMs` | `60000` | Rollup flush cadence. |
| `shutdownTimeoutMs` | `5000` | Upper bound on the final drain at teardown. |

Token resolution (first match wins): `CODETIME_TOKEN` env →
`~/.codetime/config.json` token. If you already signed in with the codetime CLI
or another editor extension, the shared `~/.codetime/config.json` token is
picked up automatically. The `machine-id` in `~/.codetime/machine-id` identifies
the machine on the dashboard (created on first use, shared with the CLI).

## Limitations

- Event buffers are held per session in memory and re-sent whole each flush
  (idempotent upsert); very long-lived sessions grow their in-memory buffer.
- Historical sessions are **not** backfilled — this reports only activity the
  live process observes. Pair it with a `codetime-cli` `dsh` backfill adapter
  to import `~/.dsh/sessions/**/session.jsonl.zstd` history.
- No redaction rules are shipped: records leave the process exactly as captured
  by the seam. Mount your own `session-telemetry/record` waterfall rules if you
  export beyond a trusted boundary.

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


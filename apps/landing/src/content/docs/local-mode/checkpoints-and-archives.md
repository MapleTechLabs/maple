---
title: "Checkpoints & archives"
description: "How Maple Local protects your telemetry: automatic restore points, what happens after an unclean shutdown, reset and restore, and Parquet archives for long-term history."
group: "Local Mode"
order: 3
---

Maple Local keeps everything in one embedded ClickHouse store under `~/.maple/data`. Three mechanisms keep that store safe, and one keeps it small:

| Mechanism | What it protects against | Command |
| --- | --- | --- |
| **Checkpoints** | A crash, a bad upgrade, a mistake | `maple checkpoint`, `maple restore` |
| **Dirty-store policy** | Silent data loss after an unclean shutdown | `maple start --on-dirty-store` |
| **Journaled reset** | Deleting more than the store | `maple reset`, `maple start --reset` |
| **Archives** | The hot store growing without bound | `maple archive …` |

The rule behind all of them: when the CLI is unsure, it stops and tells you which paths it preserved. It never guesses its way through a destructive step.

## Checkpoints

A checkpoint is a validated, restorable snapshot of the store. The running server refreshes one every 30 minutes by default, so a crash costs at most that much telemetry. Change the cadence with `--checkpoint-interval` (`45s`, `2h`, or `off`).

```bash
maple start
maple checkpoint      # take one now, on top of the automatic ones
```

`maple checkpoint` runs as a separate process next to the server, which is why it needs the same `--host`, `--port` and `--data-dir` if you started the server with custom values.

### What a checkpoint contains

Every completed checkpoint receives an immutable UUID and lives under `<data-dir>/backups`:

```text
<data-dir>/backups/
  state.json                   # the only authority for the selected current and previous IDs
  snapshots/<checkpoint-id>/
    backup/                    # the native ClickHouse backup
    manifest.json              # written only after the backup validated
  operations/                  # evidence for reset, restore and archive operations
  pins/                        # checkpoints held by an archive export
  quarantine/                  # stores moved aside by restore, never deleted
  retiring/
```

Before a checkpoint is selected, Maple restores its backup into a throwaway instance and validates all six raw telemetry tables. Only then does it write the manifest and atomically switch `state.json`. A third checkpoint retires the oldest one, and only when that one is complete, compatible, unreferenced and unpinned. Anything uncertain is kept.

### Bring your own ClickHouse config

Checkpoints need backups enabled in the config of the **running** server, because the backup is executed by that process. `maple start` generates such a config at `~/.maple/chdb-config.xml` by default. If you pass your own `--chdb-config-file`, it must include:

```xml
<clickhouse>
  <backups>
    <allowed_disk>default</allowed_disk>
    <allowed_path>backups</allowed_path>
  </backups>
</clickhouse>
```

## Restoring

`maple restore` puts the store back to the selected checkpoint, or to one you name:

```bash
maple stop
maple restore --yes
maple restore --checkpoint-id 01234567-89ab-4cde-8fab-0123456789ab --yes
```

The server must be stopped. The current store is moved into `backups/quarantine` rather than deleted, so a restore is itself reversible. The operation is recorded before anything moves, and an interrupted restore resumes from where it stopped on the next run. Checkpoint and restore share one maintenance lock; if a server still owns the store, the command reports it as busy and does nothing.

## After an unclean shutdown

If the server did not close the store cleanly, the next `maple start` applies the `--on-dirty-store` policy:

| Policy | What happens |
| --- | --- |
| `fail` (default) | Refuse to start and say so. Nothing is deleted; choose one of the others deliberately |
| `restore-checkpoint` | Roll back to the selected checkpoint, quarantining the dirty store |
| `wipe` | Discard the live data and start empty. Checkpoints are untouched |

A detached start (`-d`) forwards the policy to the background process unchanged. A store whose schema the binary does not recognise also fails closed until you reset it or run [`maple schema migrate`](/docs/local-mode/cli-reference#maple-schema).

## Reset

`maple reset` (or `maple start --reset`) clears the live data and keeps the checkpoint registry, so a fresh store still has restore points behind it.

The reset is journaled and removes only the directories the embedded engine owns: `data`, `metadata`, `store` and `tmp`. If anything else is found in the data directory, the reset leaves everything in place and lists the unexpected paths. If a reset is interrupted, the next start finishes it before checking the store.

## Archives

The hot store is bounded: logs and traces are kept for 30 days, metrics for 90. Archives extend that with long-term, portable history as Parquet files, exported from a checkpoint and queryable on their own with DuckDB. The live store is never opened for an export, and the dashboard does not read archives back; history is a DuckDB question.

Each archive **generation** is one UTC day of one **signal**: `logs`, `traces`, `metrics_sum`, `metrics_gauge`, `metrics_histogram` or `metrics_exponential_histogram`. Aggregation tables are deliberately left out; they can be rebuilt from raw data.

```bash
maple archive create 2026-09-20 traces         # seal one day of one signal
maple archive list                             # active generations
maple archive list --output paths --signal traces   # shard paths, ready for DuckDB
maple archive verify                           # SHA-256 every active shard
maple archive retire-live 2026-09-20           # drop the day from the live tables once it is fully archived
```

`create` pins the source checkpoint, restores it into scratch, exports bounded Parquet shards, validates row counts and checksums, then selects the generation and releases the pin. Re-exporting a day (for late-arriving data) creates a new generation that supersedes the old one; the old one stays on disk but leaves the active listings until `gc` reclaims it.

| Subcommand | What it does |
| --- | --- |
| `archive create <YYYY-MM-DD> <signal>` | Seal one day of one signal from a checkpoint (`--checkpoint-id` to pick one) |
| `archive list [--output summary\|paths\|json] [--signal <name>]` | Active generations; `paths` needs `--signal` |
| `archive verify` | Stream and checksum the active shards with bounded memory |
| `archive expire <YYYY-MM-DD>` | Expire one complete archived day across all six signals |
| `archive retire-live <YYYY-MM-DD>` | Remove a day from the live raw tables after complete archive verification |
| `archive gc [--keep <n>]` | Reclaim superseded generations, keeping the newest N per signal and day (default 1) |
| `archive reconcile` | Finish an interrupted `create` or `gc` without a fresh export |
| `archive rebuild <signal>` | Rebuild a signal's `catalog.jsonl` from its generation manifests |
| `archive calibrate` | Tune the export settings by running a candidate matrix against a pinned checkpoint |

Common flags: `--data-dir` (default `~/.maple/data`), `--archive-dir` (default `~/.maple/archive`) and `--scratch-root` (default `~/.maple/scratch`). Destructive subcommands refuse to act until you pass `--apply`; `--dry-run` prints the exact plan and changes nothing.

The full model, every off-happy-path outcome, the tuning reference and the on-disk layout are in the [local telemetry archives design doc](https://github.com/MapleTechLabs/maple/blob/main/docs/local-telemetry-archives.md).

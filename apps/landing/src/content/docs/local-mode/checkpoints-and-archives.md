---
title: "Checkpoints and archives"
description: "How Maple Local protects your telemetry: automatic restore points, what happens after an unclean shutdown, reset and restore, and Parquet archives for long-term history."
group: "Local Mode"
order: 2
---

Maple Local keeps everything in one embedded ClickHouse store under `~/.maple/data`. Three mechanisms keep that store safe, and one keeps it small:

| Mechanism | What it protects against | Command |
| --- | --- | --- |
| **Checkpoints** | A crash, a bad upgrade, a mistake | `maple checkpoint`, `maple restore` |
| **Dirty-store policy** | Silent data loss after an unclean shutdown | `maple start --on-dirty-store` |
| **Journaled reset** | Deleting more than the store | `maple reset`, `maple start --reset` |
| **Archives** | The live store growing without bound | `maple archive …` |

When a destructive step is uncertain, the CLI stops and prints the paths it kept. It does not guess.

## Checkpoints

A checkpoint is a snapshot of the store that has been test-restored before it is kept. The running server takes one every 30 minutes by default, so a crash loses at most 30 minutes of telemetry. Change the cadence with `maple start --checkpoint-interval` (`45s`, `2h`, or `off` to disable).

```bash
maple start
maple checkpoint      # take one now, on top of the automatic ones
```

`maple checkpoint` asks the running server to take the checkpoint. If you started the server with a custom `--host`, `--port` or `--data-dir`, pass the same values.

### What a checkpoint contains

Each finished checkpoint gets a UUID and lives under `<data-dir>/backups`:

```text
<data-dir>/backups/
  state.json                   # which checkpoints are current and previous
  snapshots/<checkpoint-id>/
    backup/                    # the ClickHouse backup
    manifest.json              # written only after the backup passed its test restore
  operations/                  # records of reset, restore and archive runs
  pins/                        # checkpoints an archive export is reading from
  quarantine/                  # stores moved aside by restore, never deleted
  retiring/
```

Before a new checkpoint becomes the current one, Maple restores it into a temporary instance and checks all six raw telemetry tables (logs, traces and the four metric tables). If that check fails, the previous checkpoint stays current. Maple keeps the two most recent good checkpoints. When a third one succeeds, the oldest is deleted, unless an archive export is still reading from it or it cannot be confirmed as complete. In either of those cases it is kept.

### Bring your own ClickHouse config

Checkpoints need backups enabled in the config of the **running** server, because that process writes the backup. `maple start` generates such a config at `~/.maple/chdb-config.xml` by default. If you pass your own `--chdb-config-file`, it must include:

```xml
<clickhouse>
  <backups>
    <allowed_disk>default</allowed_disk>
    <allowed_path>backups</allowed_path>
  </backups>
</clickhouse>
```

## Restoring

`maple restore` puts the store back to the current checkpoint, or to one you name:

```bash
maple stop
maple restore --yes
maple restore --checkpoint-id 01234567-89ab-4cde-8fab-0123456789ab --yes
```

The server must be stopped. The store you are replacing is moved into `backups/quarantine`, not deleted, so you can go back to it. If a restore is interrupted, running `maple restore` again finishes it. Checkpoint and restore never run at the same time: if a server still owns the store, the command reports it as busy and does nothing.

## After an unclean shutdown

If the server did not close the store cleanly, the next `maple start` applies the `--on-dirty-store` policy:

| Policy | What happens |
| --- | --- |
| `fail` (default) | Refuse to start and say so. Nothing is deleted; choose one of the others deliberately |
| `restore-checkpoint` | Roll back to the current checkpoint and move the dirty store into `backups/quarantine` |
| `wipe` | Discard the live data and start empty. Checkpoints are untouched |

A detached start (`-d`) passes the policy to the background process unchanged. A store whose schema the binary does not recognize also refuses to start until you reset it or run [`maple schema migrate`](/docs/reference/cli#maple-schema).

## Reset

`maple reset` (or `maple start --reset`) clears the live data and keeps all checkpoints, so a fresh store still has restore points behind it.

A reset removes only the directories the embedded engine owns: `data`, `metadata`, `store` and `tmp`. If it finds anything else in the data directory, it changes nothing and lists the unexpected paths. If a reset is interrupted, the next `maple start` finishes it before opening the store.

## Archives

The live store keeps logs and traces for 30 days and metrics for 90 (see [Your data](/docs/local-mode#your-data)). Archives keep older history as Parquet files you can query with DuckDB. An export reads from a checkpoint, never from the live store, and the dashboard does not read archives.

An archive covers one UTC day of one **signal**: `logs`, `traces`, `metrics_sum`, `metrics_gauge`, `metrics_histogram` or `metrics_exponential_histogram`. Aggregation tables are not archived; they can be rebuilt from the raw data.

```bash
maple archive create 2026-09-20 traces              # export one day of one signal
maple archive list                                  # what is archived
maple archive list --output paths --signal traces   # file paths, ready for DuckDB
maple archive verify                                # re-check every file's SHA-256
maple archive retire-live 2026-09-20 --apply        # delete the day from the live store once it is fully archived
```

`archive create` exports the day from the current checkpoint (or the one you pass with `--checkpoint-id`), then checks row counts and checksums before the archive appears in `archive list`. The checkpoint is not deleted while the export runs. Exporting the same day again, for example after late data arrives, writes a new copy that replaces the old one in `archive list`. The old files stay on disk until `maple archive gc` removes them.

Every subcommand and flag is in the [CLI reference](/docs/reference/cli#maple-archive). The on-disk layout and the recovery rules for interrupted runs are in the [local telemetry archives design doc](https://github.com/MapleTechLabs/maple/blob/main/docs/local-telemetry-archives.md).

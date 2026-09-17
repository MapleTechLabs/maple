# Backup and recovery

What Maple backs up, how, and how recovery is proven. This is the operator guide behind the
"backups and tested restoration" control (SOC 2 A1.2/A1.3, ISO 27001 A.8.13/A.8.14): the system
inventory, the recovery mechanism for each, and the evidence each one produces.

## Inventory

| System                                          | What it holds                                                                                                               | Backup / recovery mechanism                                                                                                                                                                                                                                                                                                                                                    | Evidence                                                                      |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| **PlanetScale Postgres** (`main` branch)        | System of record: org configuration, ingest and API keys, dashboards, alert rules and incidents, error issues, integrations | Vendor-managed scheduled backups (every 12 h, retained 2 days by default policy) plus point-in-time recovery inside the retention window. Multi-replica cluster.                                                                                                                                                                                                               | Restore drill below; `pscale backup list maple main`                          |
| **Tinybird / ClickHouse** (telemetry warehouse) | Traces, logs, metrics, product events                                                                                       | Replicated, vendor-managed ClickHouse (Tinybird SOC 2 report covers durability). Rows are accepted by the ingest gateway only after a WAL commit; sealed WAL segments are shipped to S3 until exported, so a gateway task dying does not lose accepted data ([`ingest-wal-durability.md`](ingest-wal-durability.md)). Raw tables carry the retention TTLs in `datasources.ts`. | Vendor report; WAL S3 bucket lifecycle config in `apps/ingest/alchemy.run.ts` |
| **Cloudflare R2** (`replay-blobs`)              | Session-replay payloads                                                                                                     | Cloudflare-managed durability; regenerable from customers' SDKs, not a system of record                                                                                                                                                                                                                                                                                        | Vendor report                                                                 |
| **GitHub**                                      | Source, migrations, infrastructure definitions                                                                              | Every clone is a full copy; GitHub's own durability                                                                                                                                                                                                                                                                                                                            | Vendor report                                                                 |
| **Clerk**                                       | Users, organisations, memberships                                                                                           | Vendor-managed; exportable through the Clerk API                                                                                                                                                                                                                                                                                                                               | Vendor report                                                                 |
| **Infisical**                                   | Secrets                                                                                                                     | Vendor-managed                                                                                                                                                                                                                                                                                                                                                                 | Vendor report                                                                 |

The application database is the only system whose loss is not either vendor-durable by contract
or regenerable, so it is the one with a first-party restore drill.

## The restore drill

`packages/db/scripts/restore-test.ts` restores the newest successful backup of `main` into a
throwaway branch, proves the data is usable, writes a report, and deletes the branch:

```bash
PLANETSCALE_ORG=<org> bun run backup:restore-test
```

It records, in order:

1. **Backup configuration as observed** — the source branch (cluster size, region, replica count)
   and the recent backups with state, size, completion and expiry, from which the actual cadence
   and retention are derived. This is the "backup settings" half of the evidence.
2. **The restore** — `pscale branch create <db> restore-test-<stamp> --restore <backup-id>`, then
   waits for the branch to be ready. The source branch is only ever read (`branch show`,
   `backup list`); the restore lands in a new branch on its own cluster.
3. **Verification** on the restored branch, each a pass/fail row in the report:
    - the Drizzle migrations journal is present;
    - every critical table exists (`org_ingest_keys`, `api_keys`, dashboards and their versions,
      alert rules/destinations/incidents, error issues and events, integrations), and the ones that
      are never empty in production hold rows;
    - the newest record falls inside the backup's own window — no later than the backup completed,
      no older than a day before it started — which is what distinguishes "the backup's snapshot"
      from "some data";
    - a parent/child join (`dashboard_versions → dashboards`) has no orphans;
    - one record reads back with its full history.
      A query that errors is a failed row, not a crash: the report is always written.
4. **Cleanup** — the only destructive call is `branch delete`, and it passes through a gate that
   refuses any name not starting with `restore-test-` or equal to the source branch. The report
   is written before the delete is requested, and a process `exit` hook re-requests the delete
   if anything exits early, because a leaked restore branch bills until someone notices.
   `RESTORE_TEST_KEEP_BRANCH=1` keeps it for inspection.

The report lands in `packages/db/.restore-test/restore-test-report.{json,md}` (gitignored) and, in
CI, in the job summary and the `backup-restore-test-report` artifact. The repository is public and
so are its run logs and artifacts, so the report carries no org slug, row counts as orders of
magnitude rather than exact figures, and no record identifiers. A non-zero exit means a check
failed: a scheduled red run is a recovery incident, not noise.

### Testing the drill

- **Locally, for real:** `PLANETSCALE_ORG=<org> bun run backup:restore-test` with a `pscale auth
login` session. Takes 10–20 minutes, most of it PlanetScale provisioning the restored cluster;
  the branch is billed for that window (restores default to the PS-10 size). Inspect
  `packages/db/.restore-test/`. This is the run that produces the first restore evidence.
- **Keep the branch:** add `RESTORE_TEST_KEEP_BRANCH=1` to poke at the restored data by hand, then
  `pscale branch delete <db> restore-test-<stamp> --force`.
- **Failure path without a restore:** `RESTORE_TEST_SOURCE_BRANCH=does-not-exist` fails at
  `branch show`, before anything is created.
- **In CI:** the workflow only runs on its schedule or `gh workflow run backup-restore-test.yml`
  (after merge — a PR's CI does not run it). The first dispatch validates the service token. On
  the database it needs `read_branch`, `create_branch`, `delete_branch`, `connect_branch` (the
  ephemeral role), `read_backups` and `restore_production_branch_backup`; a token missing
  `read_backups` fails at `backup list`, one missing the restore access fails at `branch create`
  — in both cases before anything is created. Only the token's creator or an organization
  administrator can change its accesses, and only to accesses they hold themselves.

### Schedule

[`backup-restore-test.yml`](../.github/workflows/backup-restore-test.yml) runs the drill on the
first day of every quarter and on `workflow_dispatch`. It authenticates the `pscale` CLI with the
PlanetScale service token from Infisical (`PLANETSCALE_SERVICE_TOKEN_ID` / `_TOKEN` /
`PLANETSCALE_ORG`) — the same one the preview-orphan sweep uses, which already has branch create
and delete on the `maple` database.

Point-in-time recovery is the other restore path PlanetScale offers (any timestamp inside the
retention window, dashboard or `pscale branch create --from main --restore-point <iso>` on current
CLI releases). The drill restores a named backup because that is what proves the _backups_ are
recoverable; PITR uses the same base backups plus WAL, so it is covered by the same evidence.

## Compliance-platform automations

The control asks for two things per period: backup configuration and proof of a successful
restore. Both are read-only API calls from the compliance platform, so they run on its schedule
without anyone uploading files.

**Backup configuration** (PlanetScale, needs a service token with `read_backups` on the database):

- `GET https://api.planetscale.com/v1/organizations/<org>/databases/maple/backup-policies`
- `GET https://api.planetscale.com/v1/organizations/<org>/databases/maple/branches/main/backups?state=success&per_page=10`
- Pass when a policy exists with retention ≥ 2 days and a `success` backup completed in the last
  24 hours. Evidence: the policies and the backup rows (id, size, completed_at, expires_at).

**Restore proof** (GitHub, `actions:read` on `MapleTechLabs/maple`):

- `GET /repos/MapleTechLabs/maple/actions/workflows/backup-restore-test.yml/runs?status=success&per_page=1`
- Download that run's `backup-restore-test-report` artifact and return
  `restore-test-report.json`.
- Pass when the run's `updated_at` is inside the last 365 days and the report's `status` is
  `pass`. Evidence: the report — backup restored, branch, every verification row — plus the run
  URL.

Storing the report in the compliance platform on each run is what gives it retention beyond
GitHub's 90-day artifact cap.

For a dashboard screenshot as a supplement, the PlanetScale **Backups** page of `maple/main`
(schedule, retention, recent backups) is the one to capture.

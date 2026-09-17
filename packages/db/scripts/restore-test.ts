#!/usr/bin/env bun
/**
 * Backup restore drill for the PlanetScale application database — the
 * evidence behind the "backups + tested restoration" control (SOC 2 A1.2/A1.3,
 * ISO 27001 A.8.13). See docs/backup-and-recovery.md.
 *
 *   bun run backup:restore-test                     # from the repo root
 *   bun run --cwd packages/db db:restore-test
 *
 * What it does, end to end, against the real database:
 *
 *   1. Records the backup configuration as PlanetScale reports it: the source
 *      branch (cluster, region, replicas) and its recent backups, from which
 *      the observed cadence and retention are derived.
 *   2. Restores the newest successful backup into a fresh, throwaway branch
 *      (`restore-test-<utc stamp>`) with `pscale branch create --restore`.
 *   3. Connects to the restored branch and verifies the data is usable: the
 *      migrations journal is present, every critical table exists and holds
 *      rows, the newest record sits inside the backup's window (so this is the
 *      backup's snapshot and not something else), and a parent/child join has
 *      no orphans.
 *   4. Writes a JSON + Markdown report (RESTORE_TEST_REPORT_DIR, default
 *      packages/db/.restore-test/) and deletes the branch — always, even on
 *      failure, unless RESTORE_TEST_KEEP_BRANCH=1.
 *
 * Exit code is non-zero when any verification check fails, so a scheduled run
 * that cannot prove recovery is a red run, not a quiet one.
 *
 * Env (read by the `pscale` CLI and the shared connection helper):
 *   PLANETSCALE_ORG                        required
 *   PLANETSCALE_DATABASE                   optional, default "maple"
 *   PLANETSCALE_SERVICE_TOKEN_ID / _TOKEN  CI auth; locally `pscale auth login` works
 *   RESTORE_TEST_SOURCE_BRANCH             optional, default "main"
 *   RESTORE_TEST_REPORT_DIR                optional
 *   RESTORE_TEST_KEEP_BRANCH               "1" keeps the restored branch for inspection
 *
 * The branch is named `restore-test-*` on purpose: the preview-orphan sweep
 * only ever touches `pr-<n>`, so nothing else will delete it mid-run, and
 * nothing here can ever target `main`.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as Predicate from "effect/Predicate";
import postgres from "postgres";
import {
  fail,
  resolveDatabase,
  runPscale,
  withBranchConnection,
} from "./planetscale-connection";

const READY_TIMEOUT_MS = 30 * 60 * 1000;
const POLL_MS = 15_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Tables an auditor would call "critical records": tenant configuration,
 * credentials, alerting, dashboards, and the error-issue history. Each must
 * exist on the restored branch; the ones marked nonEmpty must also hold rows.
 */
const CRITICAL_TABLES: ReadonlyArray<{
  readonly name: string;
  readonly nonEmpty: boolean;
}> = [
  { name: "org_ingest_keys", nonEmpty: true },
  { name: "api_keys", nonEmpty: true },
  { name: "org_clickhouse_settings", nonEmpty: false },
  { name: "dashboards", nonEmpty: true },
  { name: "dashboard_versions", nonEmpty: true },
  { name: "alert_rules", nonEmpty: true },
  { name: "alert_destinations", nonEmpty: true },
  { name: "alert_incidents", nonEmpty: false },
  { name: "error_issues", nonEmpty: true },
  { name: "error_issue_events", nonEmpty: true },
  { name: "vcs_installations", nonEmpty: false },
  { name: "slack_workspaces", nonEmpty: false },
];

interface Backup {
  readonly id: string;
  readonly name: string;
  readonly state: string;
  readonly size: number;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly expires_at: string | null;
}

interface Check {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
}

type JsonObject = Record<string, unknown>;

const parseObject = (raw: string, what: string): JsonObject => {
  try {
    const value: unknown = JSON.parse(raw);
    if (!Predicate.isObject(value)) throw new TypeError("not an object");
    return value;
  } catch {
    return fail(`Could not parse ${what} as a JSON object`);
  }
};

const parseObjectArray = (
  raw: string,
  what: string,
): ReadonlyArray<JsonObject> => {
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || !value.every(Predicate.isObject))
      throw new TypeError("not an object array");
    return value;
  } catch {
    return fail(`Could not parse ${what} as a JSON object array`);
  }
};

const str = (o: JsonObject, key: string): string | null => {
  const v = o[key];
  return typeof v === "string" ? v : null;
};

const ms = (iso: string | null): number => (iso ? Date.parse(iso) : Number.NaN);
const hours = (a: number, b: number): number =>
  Math.round(((a - b) / 3_600_000) * 10) / 10;

interface BranchInfo {
  readonly name: string | null;
  readonly production: boolean;
  readonly state: string | null;
  readonly cluster: string | null;
  readonly region: string | null;
  readonly replicas: number | null;
  readonly major_version: string | null;
  readonly created_at: string | null;
}

/** The source branch as PlanetScale describes it: cluster size, region, replicas. */
const describeBranch = (database: string, branch: string): BranchInfo => {
  const show = runPscale(
    ["branch", "show", database, branch, "--format", "json"],
    { secret: true },
  );
  if (show.exitCode !== 0) fail(`Could not describe ${database}/${branch}`);
  const parsed = parseObject(show.stdout, "branch show");
  const region = Predicate.isObject(parsed.region) ? parsed.region : {};
  return {
    name: str(parsed, "name"),
    production: parsed.production === true,
    state: str(parsed, "state"),
    cluster: str(parsed, "cluster_display_name") ?? str(parsed, "cluster_name"),
    region: str(region, "display_name") ?? str(region, "slug"),
    replicas: typeof parsed.replicas === "number" ? parsed.replicas : null,
    major_version: str(parsed, "major_version"),
    created_at: str(parsed, "created_at"),
  };
};

const listBackups = (
  database: string,
  branch: string,
): ReadonlyArray<Backup> => {
  const list = runPscale(
    ["backup", "list", database, branch, "--format", "json"],
    { secret: true },
  );
  if (list.exitCode !== 0)
    fail(`Could not list backups of ${database}/${branch}`);
  return parseObjectArray(list.stdout, "backup list")
    .map((b): Backup => ({
      id: str(b, "id") ?? "",
      name: str(b, "name") ?? "",
      state: str(b, "state") ?? "unknown",
      size: typeof b.size === "number" ? b.size : 0,
      created_at: str(b, "created_at") ?? "",
      started_at: str(b, "started_at"),
      completed_at: str(b, "completed_at"),
      expires_at: str(b, "expires_at"),
    }))
    .sort((a, b) => ms(b.created_at) - ms(a.created_at));
};

/**
 * Cadence and retention as the backup list evidences them — the median gap
 * between consecutive backups and the median created→expires span — rather
 * than as a policy object says they should be. What the auditor wants is what
 * actually ran.
 */
const summarizeSchedule = (backups: ReadonlyArray<Backup>) => {
  const median = (xs: number[]): number | null => {
    const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
    return s.length === 0 ? null : (s[Math.floor(s.length / 2)] ?? null);
  };
  const gaps = backups
    .slice(0, -1)
    .map((b, i) =>
      hours(ms(b.created_at), ms(backups[i + 1]?.created_at ?? null)),
    );
  const retention = backups.map((b) =>
    hours(ms(b.expires_at), ms(b.created_at)),
  );
  return {
    backups_listed: backups.length,
    successful: backups.filter((b) => b.state === "success").length,
    observed_cadence_hours: median(gaps),
    observed_retention_hours: median(retention),
  };
};

const waitUntilReady = async (
  database: string,
  branch: string,
): Promise<void> => {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const show = runPscale(
      ["branch", "show", database, branch, "--format", "json"],
      { secret: true },
    );
    if (show.exitCode === 0) {
      const parsed = parseObject(show.stdout, "branch show");
      if (parsed.ready === true || parsed.state === "ready") {
        console.log(`✓ Branch ${branch} is ready`);
        return;
      }
      console.log(`… branch ${branch} not ready yet`);
    }
    await sleep(POLL_MS);
  }
  fail(`Timed out waiting for branch ${branch} to become ready`);
};

const deleteBranch = async (
  database: string,
  branch: string,
): Promise<boolean> => {
  const remove = runPscale(["branch", "delete", database, branch, "--force"]);
  if (
    remove.exitCode !== 0 &&
    !/not found|does not exist/i.test(`${remove.stdout}\n${remove.stderr}`)
  ) {
    console.error(
      `⚠ Could not delete ${database}/${branch} — delete it by hand, it bills while it exists`,
    );
    return false;
  }
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const show = runPscale(
      ["branch", "show", database, branch, "--format", "json"],
      { secret: true },
    );
    if (
      show.exitCode !== 0 &&
      /not found|does not exist/i.test(`${show.stdout}\n${show.stderr}`)
    ) {
      console.log(`✓ Branch ${branch} deleted`);
      return true;
    }
    await sleep(POLL_MS);
  }
  console.error(
    `⚠ Branch ${branch} still deleting after ${READY_TIMEOUT_MS / 60_000} min`,
  );
  return false;
};

interface Verification {
  readonly checks: ReadonlyArray<Check>;
  readonly migrations: {
    readonly applied: number;
    readonly latest_at: string | null;
  };
  readonly public_tables: number;
  readonly row_counts: Record<string, number>;
  readonly newest_record_at: string | null;
  readonly sample: Record<string, unknown>;
}

const verify = async (
  connectionUrl: string,
  backup: Backup,
): Promise<Verification> => {
  const sql = postgres(connectionUrl, { max: 1, fetch_types: false });
  const checks: Check[] = [];
  try {
    const [mig] = await sql<
      Array<{ applied: number; latest_at: string | null }>
    >`
			SELECT count(*)::int AS applied, max(created_at)::text AS latest_at
			FROM drizzle.__drizzle_migrations`;
    const migrations = {
      applied: mig?.applied ?? 0,
      latest_at: mig?.latest_at
        ? new Date(Number(mig.latest_at)).toISOString()
        : null,
    };
    checks.push({
      name: "migrations journal restored",
      pass: migrations.applied > 0,
      detail: `${migrations.applied} migrations recorded, latest ${migrations.latest_at ?? "n/a"}`,
    });

    const [tables] = await sql<Array<{ n: number }>>`
			SELECT count(*)::int AS n FROM information_schema.tables
			WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`;
    const publicTables = tables?.n ?? 0;

    const rowCounts: Record<string, number> = {};
    for (const { name, nonEmpty } of CRITICAL_TABLES) {
      const [exists] = await sql<Array<{ present: boolean }>>`
				SELECT to_regclass(${`public.${name}`}) IS NOT NULL AS present`;
      if (!exists?.present) {
        checks.push({
          name: `table ${name}`,
          pass: false,
          detail: "missing on restored branch",
        });
        continue;
      }
      const [row] = await sql<
        Array<{ n: number }>
      >`SELECT count(*)::int AS n FROM ${sql(name)}`;
      const n = row?.n ?? 0;
      rowCounts[name] = n;
      checks.push({
        name: `table ${name}`,
        pass: nonEmpty ? n > 0 : true,
        detail: `${n} rows${nonEmpty && n === 0 ? " (expected > 0)" : ""}`,
      });
    }

    // Newest record across two write-heavy tables: it must fall inside the
    // backup's own window (not after it completed, not stale before it
    // started) — this is what shows the branch holds the backup's snapshot.
    const [fresh] = await sql<Array<{ newest: string | null }>>`
			SELECT greatest(
				(SELECT max(created_at) FROM error_issue_events),
				(SELECT max(updated_at) FROM alert_rules),
				(SELECT max(updated_at) FROM dashboards)
			)::text AS newest`;
    const newestAt = fresh?.newest
      ? new Date(fresh.newest).toISOString()
      : null;
    const completed = ms(backup.completed_at);
    const started = ms(backup.started_at ?? backup.created_at);
    const newest = ms(newestAt);
    const inWindow =
      Number.isFinite(newest) &&
      newest <= completed + 60_000 &&
      newest >= started - 24 * 3_600_000;
    checks.push({
      name: "newest record inside the backup window",
      pass: inWindow,
      detail: `newest ${newestAt ?? "n/a"}; backup ran ${backup.started_at ?? backup.created_at} → ${backup.completed_at ?? "?"}`,
    });

    const [orphans] = await sql<Array<{ n: number }>>`
			SELECT count(*)::int AS n FROM dashboard_versions v
			LEFT JOIN dashboards d ON d.id = v.dashboard_id
			WHERE d.id IS NULL`;
    checks.push({
      name: "dashboard_versions → dashboards integrity",
      pass: (orphans?.n ?? 0) === 0,
      detail: `${orphans?.n ?? 0} orphaned versions`,
    });

    const [sample] = await sql<
      Array<{ id: string; version_count: number; updated_at: string }>
    >`
			SELECT d.id, count(v.id)::int AS version_count, max(d.updated_at)::text AS updated_at
			FROM dashboards d LEFT JOIN dashboard_versions v ON v.dashboard_id = d.id
			GROUP BY d.id ORDER BY max(d.updated_at) DESC NULLS LAST LIMIT 1`;
    checks.push({
      name: "sample record readable with its history",
      pass: sample !== undefined,
      detail: sample
        ? `dashboard ${sample.id}: ${sample.version_count} versions`
        : "no dashboards found",
    });

    return {
      checks,
      migrations,
      public_tables: publicTables,
      row_counts: rowCounts,
      newest_record_at: newestAt,
      sample: sample ?? {},
    };
  } finally {
    await sql.end();
  }
};

interface Report {
  readonly version: 1;
  readonly status: "pass" | "fail";
  readonly generated_at: string;
  readonly database: { readonly org: string; readonly database: string };
  readonly source_branch: BranchInfo;
  readonly backup_configuration: {
    readonly schedule: ReturnType<typeof summarizeSchedule>;
    readonly backups: ReadonlyArray<Backup>;
  };
  readonly restore: {
    readonly backup_id: string;
    readonly backup_completed_at: string | null;
    readonly branch: string;
    readonly ready_after_seconds: number;
    readonly deleted: boolean;
  };
  readonly verification: Verification;
}

const renderMarkdown = (r: Report): string => {
  const icon = (ok: boolean) => (ok ? "✅" : "❌");
  const lines = [
    `# Backup restore drill — ${r.status.toUpperCase()}`,
    "",
    `Generated ${r.generated_at} for PlanetScale \`${r.database.org}/${r.database.database}\` branch \`${r.source_branch.name ?? "?"}\` ` +
      `(${r.source_branch.cluster ?? "?"}, ${r.source_branch.region ?? "?"}, ${r.source_branch.replicas ?? "?"} replicas).`,
    "",
    "## Backup configuration (as observed)",
    "",
    `- Backups listed: ${r.backup_configuration.schedule.backups_listed} (${r.backup_configuration.schedule.successful} successful)`,
    `- Observed cadence: every ~${r.backup_configuration.schedule.observed_cadence_hours ?? "?"} h`,
    `- Observed retention: ~${r.backup_configuration.schedule.observed_retention_hours ?? "?"} h`,
    "",
    "| Backup | State | Size (MB) | Completed | Expires |",
    "| --- | --- | --- | --- | --- |",
    ...r.backup_configuration.backups.map(
      (b) =>
        `| ${b.id} | ${b.state} | ${(b.size / 1_000_000).toFixed(1)} | ${b.completed_at ?? "—"} | ${b.expires_at ?? "—"} |`,
    ),
    "",
    "## Restore",
    "",
    `- Restored backup \`${r.restore.backup_id}\` into branch \`${r.restore.branch}\``,
    `- Branch ready after ${r.restore.ready_after_seconds} s; deleted afterwards: ${r.restore.deleted}`,
    "",
    "## Verification",
    "",
    "| Check | Result | Detail |",
    "| --- | --- | --- |",
    ...r.verification.checks.map(
      (c) => `| ${c.name} | ${icon(c.pass)} | ${c.detail} |`,
    ),
    "",
    `Public tables: ${r.verification.public_tables} · migrations applied: ${r.verification.migrations.applied}`,
    "",
  ];
  return lines.join("\n");
};

const main = async (): Promise<void> => {
  const org = process.env.PLANETSCALE_ORG?.trim();
  if (!org) return fail("PLANETSCALE_ORG is required");
  const database = resolveDatabase();
  const sourceBranch = process.env.RESTORE_TEST_SOURCE_BRANCH?.trim() || "main";
  const reportDir = resolve(
    process.env.RESTORE_TEST_REPORT_DIR?.trim() ||
      resolve(import.meta.dir, "..", ".restore-test"),
  );
  const keepBranch = process.env.RESTORE_TEST_KEEP_BRANCH === "1";
  const startedAt = new Date();

  console.log(
    `→ Backup restore drill for ${org}/${database}/${sourceBranch}\n`,
  );

  const source = describeBranch(database, sourceBranch);
  const backups = listBackups(database, sourceBranch);
  const latest = backups.find((b) => b.state === "success" && b.completed_at);
  if (!latest)
    return fail(
      `No successful backup of ${database}/${sourceBranch} to restore`,
    );
  console.log(
    `✓ Newest successful backup: ${latest.id} (${latest.name}, completed ${latest.completed_at})\n`,
  );

  const stamp = startedAt
    .toISOString()
    .replace(/[-:]/g, "")
    .slice(0, 13)
    .replace("T", "-");
  const branch = `restore-test-${stamp}`;

  const create = runPscale([
    "branch",
    "create",
    database,
    branch,
    "--restore",
    latest.id,
    "--wait",
  ]);
  if (
    create.exitCode !== 0 &&
    !/timed out/i.test(`${create.stdout}\n${create.stderr}`)
  ) {
    fail(`Could not create ${branch} from backup ${latest.id}`);
  }
  let verification: Verification | undefined;
  let deleted = false;
  let readyAfterSeconds = 0;
  try {
    await waitUntilReady(database, branch);
    readyAfterSeconds = Math.round((Date.now() - startedAt.getTime()) / 1000);
    await withBranchConnection(branch, async (url) => {
      verification = await verify(url, latest);
    });
  } finally {
    if (keepBranch) {
      console.log(
        `… keeping ${branch} (RESTORE_TEST_KEEP_BRANCH=1) — it bills until deleted`,
      );
    } else {
      deleted = await deleteBranch(database, branch);
    }
  }
  if (!verification) return fail("Verification did not run");

  const status: Report["status"] = verification.checks.every((c) => c.pass)
    ? "pass"
    : "fail";
  const report: Report = {
    version: 1,
    status,
    generated_at: new Date().toISOString(),
    database: { org, database },
    source_branch: source,
    backup_configuration: { schedule: summarizeSchedule(backups), backups },
    restore: {
      backup_id: latest.id,
      backup_completed_at: latest.completed_at,
      branch,
      ready_after_seconds: readyAfterSeconds,
      deleted,
    },
    verification,
  };

  mkdirSync(reportDir, { recursive: true });
  const json = resolve(reportDir, "restore-test-report.json");
  const md = resolve(reportDir, "restore-test-report.md");
  writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`);
  const markdown = renderMarkdown(report);
  writeFileSync(md, markdown);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);

  console.log(`\n${markdown}`);
  console.log(`Report: ${json}`);
  if (status !== "pass")
    fail("Restore drill FAILED — see the verification table above");
  console.log("✓ Restore drill passed");
};

await main();

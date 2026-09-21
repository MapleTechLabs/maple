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
 *   2. Restores the newest successful backup into a fresh, throwaway PS_DEV
 *      branch (`restore-test-<utc stamp>`) with `pscale branch create --restore`.
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
 * Production safety. The source branch is only ever read (`branch show`,
 * `backup list`); the restore lands in a NEW branch on its own cluster. The
 * only destructive call is `branch delete`, and it goes through
 * `assertThrowaway`, which refuses anything not named `restore-test-*` or equal
 * to the source. The name never matches `pr-<n>`, so the preview-orphan sweep
 * ignores it. Cleanup also runs from a process `exit` hook: `fail()` exits the
 * process, which skips `finally`, and a leaked restore branch bills until
 * someone notices.
 *
 * The repository is public, so CI logs and artifacts are too. The report
 * therefore carries no org slug, bucketed row counts rather than exact ones,
 * and no record identifiers.
 *
 * Env (read by the `pscale` CLI and the shared connection helper):
 *   PLANETSCALE_ORG                        required
 *   PLANETSCALE_DATABASE                   optional, default "maple"
 *   PLANETSCALE_SERVICE_TOKEN_ID / _TOKEN  CI auth; locally `pscale auth login` works
 *   RESTORE_TEST_SOURCE_BRANCH             optional, default "main"
 *   RESTORE_TEST_REPORT_DIR                optional
 *   RESTORE_TEST_KEEP_BRANCH               "1" keeps the restored branch for inspection
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import * as Predicate from "effect/Predicate"
import postgres from "postgres"
import { fail, resolveDatabase, runPscale, withBranchConnection } from "./planetscale-connection"

const READY_TIMEOUT_MS = 25 * 60 * 1000
const DELETE_TIMEOUT_MS = 5 * 60 * 1000
const POLL_MS = 15_000
const BRANCH_PREFIX = "restore-test-"
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Tables an auditor would call "critical records": tenant configuration,
 * credentials, alerting, dashboards, and the error-issue history. Each must
 * exist on the restored branch; the ones marked nonEmpty must also hold rows.
 */
const CRITICAL_TABLES: ReadonlyArray<{ readonly name: string; readonly nonEmpty: boolean }> = [
	{ name: "org_ingest_keys", nonEmpty: true },
	{ name: "api_keys", nonEmpty: true },
	{ name: "org_clickhouse_settings", nonEmpty: false },
	{ name: "dashboards", nonEmpty: true },
	{ name: "dashboard_versions", nonEmpty: true },
	{ name: "alert_rules", nonEmpty: true },
	{ name: "alert_destinations", nonEmpty: false },
	{ name: "alert_incidents", nonEmpty: false },
	{ name: "error_issues", nonEmpty: true },
	{ name: "error_issue_events", nonEmpty: true },
	{ name: "vcs_installations", nonEmpty: false },
	{ name: "slack_workspaces", nonEmpty: false },
]

interface Backup {
	readonly id: string
	readonly name: string
	readonly state: string
	readonly size: number
	readonly created_at: string
	readonly started_at: string | null
	readonly completed_at: string | null
	readonly expires_at: string | null
}

interface Check {
	readonly name: string
	readonly pass: boolean
	readonly detail: string
}

type JsonObject = Record<string, unknown>

const parseObject = (raw: string, what: string): JsonObject => {
	try {
		const value: unknown = JSON.parse(raw)
		if (!Predicate.isObject(value)) throw new TypeError("not an object")
		return value
	} catch {
		return fail(`Could not parse ${what} as a JSON object`)
	}
}

const parseObjectArray = (raw: string, what: string): ReadonlyArray<JsonObject> => {
	try {
		const value: unknown = JSON.parse(raw)
		if (!Array.isArray(value) || !value.every(Predicate.isObject))
			throw new TypeError("not an object array")
		return value
	} catch {
		return fail(`Could not parse ${what} as a JSON object array`)
	}
}

const str = (o: JsonObject, key: string): string | null => {
	const v = o[key]
	return typeof v === "string" ? v : null
}

const ms = (iso: string | null): number => (iso ? Date.parse(iso) : Number.NaN)
const hours = (a: number, b: number): number => Math.round(((a - b) / 3_600_000) * 10) / 10
const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Order of magnitude, not the number: the report is public. */
const magnitude = (n: number): string => (n <= 0 ? "0" : `≥ ${10 ** Math.floor(Math.log10(n))}`)

/**
 * The one gate every destructive call passes through. A branch this script
 * may delete is one it named itself, and never the branch it restored from.
 */
const assertThrowaway = (branch: string, source: string): void => {
	if (!branch.startsWith(BRANCH_PREFIX) || branch === source || branch === "main") {
		fail(`Refusing to touch branch "${branch}": not a ${BRANCH_PREFIX}* branch`)
	}
}

interface BranchInfo {
	readonly name: string | null
	readonly production: boolean
	readonly state: string | null
	readonly cluster: string | null
	readonly region: string | null
	readonly replicas: number | null
	readonly major_version: string | null
	readonly created_at: string | null
}

/** The source branch as PlanetScale describes it: cluster size, region, replicas. */
const describeBranch = (database: string, branch: string): BranchInfo => {
	const show = runPscale(["branch", "show", database, branch, "--format", "json"], { secret: true })
	if (show.exitCode !== 0) fail(`Could not describe ${database}/${branch}`)
	const parsed = parseObject(show.stdout, "branch show")
	const region = Predicate.isObject(parsed.region) ? parsed.region : {}
	return {
		name: str(parsed, "name"),
		production: parsed.production === true,
		state: str(parsed, "state"),
		cluster: str(parsed, "cluster_display_name") ?? str(parsed, "cluster_name"),
		region: str(region, "display_name") ?? str(region, "slug"),
		replicas: typeof parsed.replicas === "number" ? parsed.replicas : null,
		major_version: str(parsed, "major_version"),
		created_at: str(parsed, "created_at"),
	}
}

const listBackups = (database: string, branch: string): ReadonlyArray<Backup> => {
	const list = runPscale(["backup", "list", database, branch, "--format", "json"], { secret: true })
	if (list.exitCode !== 0) fail(`Could not list backups of ${database}/${branch}`)
	return parseObjectArray(list.stdout, "backup list")
		.map(
			(b): Backup => ({
				id: str(b, "id") ?? "",
				name: str(b, "name") ?? "",
				state: str(b, "state") ?? "unknown",
				size: typeof b.size === "number" ? b.size : 0,
				created_at: str(b, "created_at") ?? "",
				started_at: str(b, "started_at"),
				completed_at: str(b, "completed_at"),
				expires_at: str(b, "expires_at"),
			}),
		)
		.sort((a, b) => ms(b.created_at) - ms(a.created_at))
}

/**
 * Cadence and retention as the backup list evidences them — the median gap
 * between consecutive backups and the median created→expires span — rather
 * than as a policy object says they should be. What the auditor wants is what
 * actually ran.
 */
const summarizeSchedule = (backups: ReadonlyArray<Backup>) => {
	const median = (xs: number[]): number | null => {
		const s = xs.filter(Number.isFinite).sort((a, b) => a - b)
		return s.length === 0 ? null : (s[Math.floor(s.length / 2)] ?? null)
	}
	const gaps = backups
		.slice(0, -1)
		.map((b, i) => hours(ms(b.created_at), ms(backups[i + 1]?.created_at ?? null)))
	const retention = backups.map((b) => hours(ms(b.expires_at), ms(b.created_at)))
	return {
		backups_listed: backups.length,
		successful: backups.filter((b) => b.state === "success").length,
		observed_cadence_hours: median(gaps),
		observed_retention_hours: median(retention),
	}
}

const isGone = (r: { stdout: string; stderr: string }): boolean =>
	/not found|does not exist/i.test(`${r.stdout}\n${r.stderr}`)

/** Resolves false on timeout rather than exiting: the caller still has a branch to delete. */
const waitUntilReady = async (database: string, branch: string): Promise<boolean> => {
	const deadline = Date.now() + READY_TIMEOUT_MS
	while (Date.now() < deadline) {
		const show = runPscale(["branch", "show", database, branch, "--format", "json"], { secret: true })
		if (show.exitCode === 0) {
			const parsed = parseObject(show.stdout, "branch show")
			if (parsed.ready === true || parsed.state === "ready") {
				console.log(`✓ Branch ${branch} is ready`)
				return true
			}
			console.log(`… branch ${branch} not ready yet`)
		}
		await sleep(POLL_MS)
	}
	console.error(`⚠ Branch ${branch} not ready after ${READY_TIMEOUT_MS / 60_000} min`)
	return false
}

/** Issues the delete; the branch is billed until PlanetScale finishes it. */
const requestDelete = (database: string, branch: string, source: string): boolean => {
	assertThrowaway(branch, source)
	const remove = runPscale(["branch", "delete", database, branch, "--force"])
	if (remove.exitCode !== 0 && !isGone(remove)) {
		console.error(
			`⚠ Could not delete ${database}/${branch} — delete it by hand, it bills while it exists`,
		)
		return false
	}
	return true
}

const waitUntilGone = async (database: string, branch: string): Promise<boolean> => {
	const deadline = Date.now() + DELETE_TIMEOUT_MS
	while (Date.now() < deadline) {
		const show = runPscale(["branch", "show", database, branch, "--format", "json"], { secret: true })
		if (show.exitCode !== 0 && isGone(show)) {
			console.log(`✓ Branch ${branch} deleted`)
			return true
		}
		await sleep(POLL_MS)
	}
	console.error(
		`⚠ Branch ${branch} still deleting after ${DELETE_TIMEOUT_MS / 60_000} min; PlanetScale finishes it server-side`,
	)
	return false
}

interface Verification {
	readonly checks: ReadonlyArray<Check>
	readonly migrations: { readonly applied: number; readonly latest_at: string | null }
	readonly public_tables: number
	readonly row_counts: Record<string, string>
	readonly newest_record_at: string | null
}

const verify = async (connectionUrl: string, backup: Backup): Promise<Verification> => {
	const sql = postgres(connectionUrl, { max: 1, fetch_types: false })
	const checks: Check[] = []
	// A query that fails is a failed check with the report still written, not
	// a crash that loses the report.
	const checked = async <T>(name: string, run: () => Promise<T>): Promise<T | undefined> => {
		try {
			return await run()
		} catch (e) {
			checks.push({ name, pass: false, detail: `query failed: ${errorMessage(e)}` })
			return undefined
		}
	}
	try {
		const mig = await checked("migrations journal restored", async () => {
			const [row] = await sql<Array<{ applied: number; latest_at: string | null }>>`
				SELECT count(*)::int AS applied, max(created_at)::text AS latest_at
				FROM drizzle.__drizzle_migrations`
			return row
		})
		const migrations = {
			applied: mig?.applied ?? 0,
			latest_at: mig?.latest_at ? new Date(Number(mig.latest_at)).toISOString() : null,
		}
		if (mig !== undefined) {
			checks.push({
				name: "migrations journal restored",
				pass: migrations.applied > 0,
				detail: `${migrations.applied} migrations recorded, latest ${migrations.latest_at ?? "n/a"}`,
			})
		}

		const publicTables =
			(await checked("public tables", async () => {
				const [row] = await sql<Array<{ n: number }>>`
					SELECT count(*)::int AS n FROM information_schema.tables
					WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
				return row?.n ?? 0
			})) ?? 0

		const rowCounts: Record<string, string> = {}
		for (const { name, nonEmpty } of CRITICAL_TABLES) {
			const n = await checked(`table ${name}`, async () => {
				const [exists] = await sql<Array<{ present: boolean }>>`
					SELECT to_regclass(${`public.${name}`}) IS NOT NULL AS present`
				if (!exists?.present) return null
				const [row] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM ${sql(name)}`
				return row?.n ?? 0
			})
			if (n === undefined) continue
			if (n === null) {
				checks.push({ name: `table ${name}`, pass: false, detail: "missing on restored branch" })
				continue
			}
			rowCounts[name] = magnitude(n)
			checks.push({
				name: `table ${name}`,
				pass: nonEmpty ? n > 0 : true,
				detail: `${magnitude(n)} rows${nonEmpty && n === 0 ? " (expected > 0)" : ""}`,
			})
		}

		// Newest record across write-heavy tables: it must fall inside the
		// backup's own window (not after it completed, not stale before it
		// started) — this is what shows the branch holds the backup's snapshot.
		const newestAt = await checked("newest record inside the backup window", async () => {
			const [row] = await sql<Array<{ newest: string | null }>>`
				SELECT greatest(
					(SELECT max(created_at) FROM error_issue_events),
					(SELECT max(updated_at) FROM alert_rules),
					(SELECT max(updated_at) FROM dashboards)
				)::text AS newest`
			return row?.newest ? new Date(row.newest).toISOString() : null
		})
		if (newestAt !== undefined) {
			const completed = ms(backup.completed_at)
			const started = ms(backup.started_at ?? backup.created_at)
			const newest = ms(newestAt)
			const inWindow =
				Number.isFinite(newest) && newest <= completed + 60_000 && newest >= started - 24 * 3_600_000
			checks.push({
				name: "newest record inside the backup window",
				pass: inWindow,
				detail: `newest ${newestAt ?? "n/a"}; backup ran ${backup.started_at ?? backup.created_at} → ${backup.completed_at ?? "?"}`,
			})
		}

		const orphans = await checked("dashboard_versions → dashboards integrity", async () => {
			const [row] = await sql<Array<{ n: number }>>`
				SELECT count(*)::int AS n FROM dashboard_versions v
				LEFT JOIN dashboards d ON d.id = v.dashboard_id
				WHERE d.id IS NULL`
			return row?.n ?? 0
		})
		if (orphans !== undefined) {
			checks.push({
				name: "dashboard_versions → dashboards integrity",
				pass: orphans === 0,
				detail: `${orphans} orphaned versions`,
			})
		}

		const sample = await checked("sample record readable with its history", async () => {
			const [row] = await sql<Array<{ version_count: number }>>`
				SELECT count(v.id)::int AS version_count
				FROM dashboards d LEFT JOIN dashboard_versions v ON v.dashboard_id = d.id
				GROUP BY d.id ORDER BY max(d.updated_at) DESC NULLS LAST LIMIT 1`
			return row ?? null
		})
		if (sample !== undefined) {
			checks.push({
				name: "sample record readable with its history",
				pass: sample !== null,
				detail: sample
					? `most recently updated dashboard read back with ${sample.version_count} versions`
					: "no dashboards found",
			})
		}

		return {
			checks,
			migrations,
			public_tables: publicTables,
			row_counts: rowCounts,
			newest_record_at: newestAt ?? null,
		}
	} finally {
		await sql.end()
	}
}

interface Report {
	readonly version: 1
	readonly status: "pass" | "fail"
	readonly generated_at: string
	readonly database: string
	readonly source_branch: BranchInfo
	readonly backup_configuration: {
		readonly schedule: ReturnType<typeof summarizeSchedule>
		readonly backups: ReadonlyArray<Backup>
	}
	readonly restore: {
		readonly backup_id: string
		readonly backup_completed_at: string | null
		readonly branch: string
		readonly ready_after_seconds: number
		/** null while the delete is still in flight; the report is rewritten once it settles. */
		readonly deleted: boolean | null
	}
	readonly verification: Verification
}

const renderMarkdown = (r: Report): string => {
	const icon = (ok: boolean) => (ok ? "✅" : "❌")
	const lines = [
		`# Backup restore drill — ${r.status.toUpperCase()}`,
		"",
		`Generated ${r.generated_at} for PlanetScale database \`${r.database}\` branch \`${r.source_branch.name ?? "?"}\` ` +
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
		`- Branch ready after ${r.restore.ready_after_seconds} s; deleted afterwards: ${r.restore.deleted ?? "pending"}`,
		"",
		"## Verification",
		"",
		"| Check | Result | Detail |",
		"| --- | --- | --- |",
		...r.verification.checks.map((c) => `| ${c.name} | ${icon(c.pass)} | ${c.detail} |`),
		"",
		`Public tables: ${r.verification.public_tables} · migrations applied: ${r.verification.migrations.applied}`,
		"",
	]
	return lines.join("\n")
}

const writeReport = (dir: string, report: Report): string => {
	mkdirSync(dir, { recursive: true })
	const json = resolve(dir, "restore-test-report.json")
	writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`)
	writeFileSync(resolve(dir, "restore-test-report.md"), renderMarkdown(report))
	return json
}

const main = async (): Promise<void> => {
	const org = process.env.PLANETSCALE_ORG?.trim()
	if (!org) return fail("PLANETSCALE_ORG is required")
	const database = resolveDatabase()
	const sourceBranch = process.env.RESTORE_TEST_SOURCE_BRANCH?.trim() || "main"
	const reportDir = resolve(
		process.env.RESTORE_TEST_REPORT_DIR?.trim() || resolve(import.meta.dir, "..", ".restore-test"),
	)
	const keepBranch = process.env.RESTORE_TEST_KEEP_BRANCH === "1"
	const startedAt = new Date()

	console.log(`→ Backup restore drill for ${database}/${sourceBranch}\n`)

	const source = describeBranch(database, sourceBranch)
	const backups = listBackups(database, sourceBranch)
	const latest = backups.find((b) => b.state === "success" && b.completed_at)
	if (!latest) return fail(`No successful backup of ${database}/${sourceBranch} to restore`)
	console.log(
		`✓ Newest successful backup: ${latest.id} (${latest.name}, completed ${latest.completed_at})\n`,
	)

	const stamp = startedAt.toISOString().replace(/[-:]/g, "").slice(0, 13).replace("T", "-")
	const branch = `${BRANCH_PREFIX}${stamp}`
	assertThrowaway(branch, sourceBranch)

	// Safety net for every `fail()` (process.exit) between create and delete:
	// `exit` handlers run synchronously, and so does the pscale spawn.
	let cleanupOwed = false
	process.on("exit", () => {
		if (cleanupOwed && !keepBranch) {
			console.error(`… exiting with ${branch} still present; requesting its deletion`)
			requestDelete(database, branch, sourceBranch)
		}
	})

	// PS_DEV is not only the cheapest size: a restore without an explicit size
	// lands as a PS-10 branch flagged `production: true`, which the CI token can
	// only delete with production-delete accesses — the same accesses that could
	// delete `main`. A PS_DEV restore is a development branch, so `delete_branch`
	// and `delete_branch_password` suffice and the token never holds more.
	const create = runPscale([
		"branch",
		"create",
		database,
		branch,
		"--restore",
		latest.id,
		"--cluster-size",
		"PS_DEV",
		"--wait",
	])
	cleanupOwed = true
	if (create.exitCode !== 0 && !/timed out/i.test(`${create.stdout}\n${create.stderr}`)) {
		fail(`Could not create ${branch} from backup ${latest.id}`)
	}

	let verification: Verification | undefined
	let readyAfterSeconds = 0
	try {
		if (await waitUntilReady(database, branch)) {
			readyAfterSeconds = Math.round((Date.now() - startedAt.getTime()) / 1000)
			await withBranchConnection(branch, async (url) => {
				verification = await verify(url, latest)
			})
		}
	} catch (e) {
		console.error(`✗ Verification did not complete: ${errorMessage(e)}`)
	}
	if (!verification) {
		verification = {
			checks: [
				{
					name: "restored branch usable",
					pass: false,
					detail: "branch never became ready or could not be queried",
				},
			],
			migrations: { applied: 0, latest_at: null },
			public_tables: 0,
			row_counts: {},
			newest_record_at: null,
		}
	}

	const status: Report["status"] = verification.checks.every((c) => c.pass) ? "pass" : "fail"
	const report: Report = {
		version: 1,
		status,
		generated_at: new Date().toISOString(),
		database,
		source_branch: source,
		backup_configuration: { schedule: summarizeSchedule(backups), backups },
		restore: {
			backup_id: latest.id,
			backup_completed_at: latest.completed_at,
			branch,
			ready_after_seconds: readyAfterSeconds,
			deleted: null,
		},
		verification,
	}
	// Written BEFORE the delete so a slow teardown cannot cost the evidence.
	writeReport(reportDir, report)

	let deleted: boolean | null = null
	if (keepBranch) {
		console.log(`… keeping ${branch} (RESTORE_TEST_KEEP_BRANCH=1) — it bills until deleted`)
	} else {
		deleted = requestDelete(database, branch, sourceBranch) && (await waitUntilGone(database, branch))
		cleanupOwed = false
	}
	// A restore branch that outlives the drill bills until someone notices, so
	// a failed delete is a failed run even when every data check passed.
	const cleanup: ReadonlyArray<Check> = keepBranch
		? []
		: [
				{
					name: "restore branch deleted",
					pass: deleted === true,
					detail: deleted ? branch : `${branch} still exists — delete it by hand`,
				},
			]
	const finalChecks = [...verification.checks, ...cleanup]
	const finalStatus: Report["status"] = finalChecks.every((c) => c.pass) ? "pass" : "fail"
	const finalReport: Report = {
		...report,
		status: finalStatus,
		restore: { ...report.restore, deleted },
		verification: { ...verification, checks: finalChecks },
	}
	const json = writeReport(reportDir, finalReport)
	const markdown = renderMarkdown(finalReport)
	if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`)

	console.log(`\n${markdown}`)
	console.log(`Report: ${json}`)
	if (finalStatus !== "pass") fail("Restore drill FAILED — see the verification table above")
	console.log("✓ Restore drill passed")
}

await main()

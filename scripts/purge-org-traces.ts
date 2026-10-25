#!/usr/bin/env bun
/**
 * Delete one org's traces in a time range from a managed Tinybird workspace, for
 * customer data-removal requests.
 *
 *   bun scripts/purge-org-traces.ts --org <orgId> --from <iso> --to <iso>            # dry run
 *   bun scripts/purge-org-traces.ts --org <orgId> --from <iso> --to <iso> --execute  # delete
 *
 * Targets the workspace in TINYBIRD_HOST / TINYBIRD_TOKEN (admin token). An org's
 * data can live in several workspaces (US primary, the legacy mirror, prod-eu), so
 * run it once per workspace, e.g. `infisical run --env=prod -- bun scripts/...` and
 * again with TINYBIRD_HOST/TOKEN set to the mirror and to prod-eu.
 *
 * Tinybird deletes don't cascade to materialized views, so every trace-derived
 * datasource is deleted on its own. The list is checked against the MV lineage at
 * startup: a new MV fed by `traces` fails the run until it is added below.
 *
 * Rollup tables can't be split below their bucket, so their range widens to whole
 * minutes/hours: other spans in the edge buckets lose their aggregates too.
 */
import { setTimeout as sleep } from "node:timers/promises"
import { Option, Schema } from "effect"
import * as Materializations from "../packages/domain/src/tinybird/materializations"

type Grain = "raw" | "minute" | "hour"

interface Target {
	readonly name: string
	readonly timeColumn: string
	readonly grain: Grain
	/** Narrows a table shared with other signals to its trace-derived rows. */
	readonly extra?: string
}

const raw = (name: string, extra?: string): Target => ({ name, timeColumn: "Timestamp", grain: "raw", extra })
const minute = (name: string): Target => ({ name, timeColumn: "Minute", grain: "minute" })
const hour = (name: string, extra?: string): Target => ({ name, timeColumn: "Hour", grain: "hour", extra })

const TRACE_SCOPES = "AttributeScope IN ('span', 'resource')"

// Order: leaves first, `traces` last, so a run that stops halfway leaves the raw
// spans in place and can simply be re-run.
const TARGETS: ReadonlyArray<Target> = [
	hour("trace_facets_hourly"),
	hour("service_endpoint_details_hourly"),
	hour("service_operations_hourly"),
	minute("service_operations_minutely"),
	minute("error_fingerprints_minutely"),
	minute("service_overview_minutely"),
	hour("service_overview_hourly"),
	hour("traces_aggregates_hourly"),
	hour("service_map_edges_hourly"),
	hour("service_map_db_edges_hourly"),
	hour("service_map_db_query_shapes_hourly"),
	hour("service_external_edges_hourly"),
	hour("service_address_resolutions_hourly"),
	hour("service_platforms_hourly"),
	hour("attribute_keys_hourly", TRACE_SCOPES),
	hour("attribute_values_hourly", TRACE_SCOPES),
	raw("product_events", "Source = 'trace'"),
	raw("error_events"),
	raw("error_events_by_time"),
	raw("ai_trace_index"),
	raw("ai_crawler_requests"),
	raw("ci_runs"),
	raw("ci_jobs"),
	raw("service_map_spans"),
	raw("service_map_children"),
	raw("service_overview_spans"),
	raw("trace_list_mv"),
	raw("traces"),
]

// Trace-derived, deliberately kept: billing usage counters with no span content,
// one row per (org, service or source, hour) shared with logs and metrics.
const KEPT = new Set(["service_usage", "source_usage_hourly"])

// Fed from `traces` by the scheduled service-map rollup job, not by an MV, so the
// lineage walk below can't see them.
const JOB_FED = new Set(["service_map_edges_hourly", "service_address_resolutions_hourly"])

const POLL_MS = 5_000
const JOB_TIMEOUT_MS = 2 * 60 * 60 * 1_000

const fail = (message: string): never => {
	console.error(`✗ ${message}`)
	process.exit(1)
}

const arg = (flag: string): string | undefined => {
	const i = process.argv.indexOf(flag)
	return i === -1 ? undefined : process.argv[i + 1]
}

const parseInstant = (flag: string): Date => {
	const value = arg(flag) ?? fail(`Missing ${flag} (ISO 8601, e.g. 2026-10-01T00:00:00Z)`)
	// Require an explicit zone: a bare local time would silently shift the range.
	if (!/(Z|[+-]\d{2}:\d{2})$/.test(value))
		fail(`${flag} needs an explicit timezone (Z or ±hh:mm): ${value}`)
	const date = new Date(value)
	if (Number.isNaN(date.getTime())) fail(`${flag} is not a valid timestamp: ${value}`)
	return date
}

const decodeMvLineage = Schema.decodeUnknownOption(
	Schema.Struct({
		_tag: Schema.Literal("MaterializedView"),
		ddl: Schema.Struct({ to: Schema.String, sources: Schema.Array(Schema.String) }),
	}),
)

/** Every datasource that MVs populate, directly or transitively, from `traces`. */
const traceLineage = (): Set<string> => {
	const mvs = Object.values(Materializations).flatMap((value) =>
		Option.match(decodeMvLineage(value), { onNone: () => [], onSome: ({ ddl }) => [ddl] }),
	)
	const reached = new Set(["traces", ...JOB_FED])
	let grew = true
	while (grew) {
		grew = false
		for (const mv of mvs) {
			if (!reached.has(mv.to) && mv.sources.some((source) => reached.has(source))) {
				reached.add(mv.to)
				grew = true
			}
		}
	}
	return reached
}

const checkCoverage = () => {
	const covered = new Set(TARGETS.map((target) => target.name))
	const missing = [...traceLineage()].filter((name) => !covered.has(name) && !KEPT.has(name))
	if (missing.length > 0) {
		fail(
			`Trace-derived datasources with no purge rule: ${missing.join(", ")}. Add them to TARGETS or KEPT.`,
		)
	}
}

const floorTo = (date: Date, ms: number) => new Date(Math.floor(date.getTime() / ms) * ms)
const ceilTo = (date: Date, ms: number) => new Date(Math.ceil(date.getTime() / ms) * ms)

const GRAIN_MS = { raw: 1, minute: 60_000, hour: 3_600_000 } satisfies Record<Grain, number>

const chTime = (date: Date) =>
	`toDateTime64('${date.toISOString().replace("T", " ").replace("Z", "")}', 3, 'UTC')`

const conditionFor = (target: Target, orgId: string, from: Date, to: Date) => {
	const grain = GRAIN_MS[target.grain]
	return [
		`OrgId = '${orgId}'`,
		`${target.timeColumn} >= ${chTime(floorTo(from, grain))}`,
		`${target.timeColumn} < ${chTime(ceilTo(to, grain))}`,
		...(target.extra === undefined ? [] : [target.extra]),
	].join(" AND ")
}

const host = (process.env.TINYBIRD_HOST?.trim() || fail("Missing env TINYBIRD_HOST")).replace(/\/$/, "")
const token = process.env.TINYBIRD_TOKEN?.trim() || fail("Missing env TINYBIRD_TOKEN")

const SqlCount = Schema.Struct({
	data: Schema.Array(Schema.Struct({ n: Schema.Union([Schema.Number, Schema.String]) })),
})
const DeleteJob = Schema.Struct({ job_id: Schema.String, job_url: Schema.String })
const JobStatus = Schema.Struct({ status: Schema.String, error: Schema.optionalKey(Schema.String) })

const tinybird = async <S extends Schema.Decoder<unknown>>(
	schema: S,
	path: string,
	init?: RequestInit,
): Promise<S["Type"]> => {
	const response = await fetch(path.startsWith("http") ? path : `${host}${path}`, {
		...init,
		headers: { Authorization: `Bearer ${token}`, ...init?.headers },
	})
	const body = await response.text()
	if (!response.ok) fail(`${init?.method ?? "GET"} ${path} → ${response.status}: ${body.slice(0, 500)}`)
	return Schema.decodeUnknownSync(schema)(JSON.parse(body))
}

const countRows = async (target: Target, condition: string): Promise<number> => {
	const sql = `SELECT count() AS n FROM ${target.name} WHERE ${condition} FORMAT JSON`
	const result = await tinybird(SqlCount, "/v0/sql", {
		method: "POST",
		body: new URLSearchParams({ q: sql }),
	})
	return Number(result.data[0]?.n ?? 0)
}

const deleteRows = async (target: Target, condition: string) => {
	const job = await tinybird(DeleteJob, `/v0/datasources/${target.name}/delete`, {
		method: "POST",
		body: new URLSearchParams({ delete_condition: condition }),
	})
	const deadline = Date.now() + JOB_TIMEOUT_MS
	while (Date.now() < deadline) {
		await sleep(POLL_MS)
		const { status, error } = await tinybird(JobStatus, job.job_url)
		if (status === "done") return
		if (status !== "waiting" && status !== "working") {
			fail(`Delete job ${job.job_id} on ${target.name} ended "${status}"${error ? `: ${error}` : ""}`)
		}
	}
	fail(`Delete job ${job.job_id} on ${target.name} still running after ${JOB_TIMEOUT_MS / 60_000} min`)
}

const orgId = arg("--org") ?? fail("Missing --org <orgId>")
// Interpolated into SQL, so allow only id characters.
if (!/^[A-Za-z0-9_-]{3,64}$/.test(orgId)) fail(`Unexpected org id format: ${orgId}`)
const from = parseInstant("--from")
const to = parseInstant("--to")
if (from >= to) fail("--from must be before --to")
const execute = process.argv.includes("--execute")

checkCoverage()

console.log(`Workspace ${host}`)
console.log(
	`Org ${orgId}, ${from.toISOString()} → ${to.toISOString()} (${execute ? "EXECUTE" : "dry run"})\n`,
)

let total = 0
const plan: Array<{ target: Target; condition: string; rows: number }> = []
for (const target of TARGETS) {
	const condition = conditionFor(target, orgId, from, to)
	const rows = await countRows(target, condition)
	total += rows
	plan.push({ target, condition, rows })
	console.log(
		`${target.name.padEnd(36)} ${String(rows).padStart(12)}  ${target.grain === "raw" ? "" : `(whole ${target.grain}s)`}`,
	)
}
console.log(`${"total".padEnd(36)} ${String(total).padStart(12)}\n`)

if (!execute) {
	console.log("Dry run, nothing deleted. Re-run with --execute to delete.")
	process.exit(0)
}

// Jobs run one at a time: Tinybird caps concurrent delete jobs per workspace.
for (const { target, condition, rows } of plan) {
	if (rows === 0) continue
	process.stdout.write(`Deleting ${rows} rows from ${target.name}… `)
	await deleteRows(target, condition)
	console.log("done")
}
console.log("\nVerifying…")
let remaining = 0
for (const { target, condition } of plan) remaining += await countRows(target, condition)
if (remaining > 0) fail(`${remaining} matching rows remain (ingest may have written into the range); re-run.`)
console.log(`✓ Purged ${total} rows for ${orgId} on ${host}`)

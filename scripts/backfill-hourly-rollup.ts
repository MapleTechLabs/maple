#!/usr/bin/env bun
// Backfills an hourly rollup deployed with `BACKFILL skip` on a managed Tinybird workspace: each of
// its views repopulated a day at a time, oldest first, paused between days. Dry run unless
// `--execute`; runbook in docs/warehouse-rollups.md.
import { setTimeout as sleep } from "node:timers/promises"
import { Array as Arr, Schema, String as Str } from "effect"

/** Each rollup's views, the source time column their populate condition filters on, and the source's retention. */
const ROLLUPS = {
	user_activity_hourly: {
		sourceDays: 30,
		views: [
			{
				pipe: "user_activity_hourly_traces_mv",
				node: "user_activity_hourly_traces_mv_node",
				column: "Timestamp",
			},
			{
				pipe: "user_activity_hourly_logs_mv",
				node: "user_activity_hourly_logs_mv_node",
				column: "TimestampTime",
			},
		],
	},
} as const

type View = (typeof ROLLUPS)[keyof typeof ROLLUPS]["views"][number]

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const POLL_MS = 5_000
/** How long after an hour ends its source can still receive points stamped in it. */
const LATE_POINTS_MS = 30 * 60 * 1_000
/** The deploy hour and the one before it: late points can be stamped in either. */
const REBUILT_HOURS = 2
const JOB_TIMEOUT_MS = 60 * 60 * 1_000

const fail = (message: string): never => {
	console.error(`✗ ${message}`)
	process.exit(1)
}

const arg = (flag: string): string | undefined => {
	const i = process.argv.indexOf(flag)
	return i === -1 ? undefined : process.argv[i + 1]
}

const parseInstant = (flag: string, value: string): Date => {
	// An explicit zone: a bare local time would silently shift every chunk.
	if (!/(Z|[+-]\d{2}:\d{2})$/.test(value))
		fail(`${flag} needs an explicit timezone (Z or ±hh:mm): ${value}`)
	const date = new Date(value)
	if (Number.isNaN(date.getTime())) fail(`${flag} is not a valid timestamp: ${value}`)
	return date
}

const chTime = (ms: number) =>
	`toDateTime('${Str.slice(0, 19)(Str.replace("T", " ")(new Date(ms).toISOString()))}', 'UTC')`

const host = Str.replace(/\/$/, "")(process.env.TINYBIRD_HOST?.trim() || fail("Missing env TINYBIRD_HOST"))
const token = process.env.TINYBIRD_TOKEN?.trim() || fail("Missing env TINYBIRD_TOKEN")

const isRollup = (name: string): name is keyof typeof ROLLUPS => Object.hasOwn(ROLLUPS, name)
const rollupArg = arg("--rollup") ?? ""
const target = isRollup(rollupArg)
	? rollupArg
	: fail(`--rollup must be one of: ${Arr.join(Object.keys(ROLLUPS), ", ")}`)
const { sourceDays, views } = ROLLUPS[target]

const SqlCount = Schema.Struct({
	data: Schema.Array(Schema.Struct({ n: Schema.Union([Schema.Number, Schema.String]) })),
})
const PopulateJob = Schema.Struct({ job: Schema.Struct({ id: Schema.String, job_url: Schema.String }) })
const DeleteJob = Schema.Struct({ job_url: Schema.String })
const JobStatus = Schema.Struct({ status: Schema.String, error: Schema.optionalKey(Schema.String) })

const tinybird = async <S extends Schema.Decoder<unknown>>(
	schema: S,
	path: string,
	init?: Omit<RequestInit, "headers">,
): Promise<S["Type"]> => {
	const response = await fetch(Str.startsWith("http")(path) ? path : `${host}${path}`, {
		...init,
		headers: { Authorization: `Bearer ${token}` },
	})
	const body = await response.text()
	if (!response.ok)
		fail(`${init?.method ?? "GET"} ${path} → ${response.status}: ${Str.slice(0, 500)(body)}`)
	return Schema.decodeSync(Schema.fromJsonString(schema))(body)
}

/** Rows already in the chunk's hours. */
const storedRows = async (startMs: number, endMs: number): Promise<number> => {
	const sql = `SELECT count() AS n FROM ${target} WHERE Hour >= ${chTime(startMs)} AND Hour < ${chTime(endMs)} FORMAT JSON`
	const result = await tinybird(SqlCount, "/v0/sql", {
		method: "POST",
		body: new URLSearchParams({ q: sql }),
	})
	return Number(result.data[0]?.n ?? 0)
}

const waitForJob = async (jobUrl: string, label: string) => {
	const deadline = Date.now() + JOB_TIMEOUT_MS
	while (Date.now() < deadline) {
		await sleep(POLL_MS)
		const { status, error } = await tinybird(JobStatus, jobUrl)
		if (status === "done") return
		if (status !== "waiting" && status !== "working")
			fail(`${label} ended "${status}"${error ? `: ${error}` : ""}`)
	}
	fail(`${label} still running after ${JOB_TIMEOUT_MS / 60_000} min`)
}

/** Repopulates one view over [startMs, endMs) of its source, appending to the target. */
const populate = async (view: View, startMs: number, endMs: number) => {
	const condition = `${view.column} >= ${chTime(startMs)} AND ${view.column} < ${chTime(endMs)}`
	const { job } = await tinybird(PopulateJob, `/v0/pipes/${view.pipe}/nodes/${view.node}/population`, {
		method: "POST",
		body: new URLSearchParams({ populate_condition: condition, truncate: "false" }),
	})
	await waitForJob(job.job_url, `Populate job ${job.id} on ${view.pipe}`)
}

/** Deletes the target's rows for [startMs, endMs), written by the views, so those hours can be rebuilt whole from the source. */
const deleteHours = async (startMs: number, endMs: number) => {
	const { job_url } = await tinybird(DeleteJob, `/v0/datasources/${target}/delete`, {
		method: "POST",
		body: new URLSearchParams({
			delete_condition: `Hour >= ${chTime(startMs)} AND Hour < ${chTime(endMs)}`,
		}),
	})
	await waitForJob(job_url, `Delete job on ${target}`)
}

const until = parseInstant(
	"--until",
	arg("--until") ?? fail("Missing --until <iso> (when the views went live)"),
)
const untilMs = until.getTime()
const fromMs =
	Math.floor(
		parseInstant(
			"--from",
			arg("--from") ?? new Date(untilMs - sourceDays * DAY_MS).toISOString(),
		).getTime() / DAY_MS,
	) * DAY_MS
if (fromMs >= untilMs) fail("--from must be before --until")
const pauseMs = Number(arg("--pause-seconds") ?? "60") * 1000
if (!Number.isFinite(pauseMs) || pauseMs < 0) fail("--pause-seconds must be a non-negative number")
const execute = process.argv.includes("--execute")

/**
 * The hour `--until` falls in and the one before it are rebuilt last and whole: points stamped in
 * them but ingested after the deploy reached the views, so a populate cut at `--until` would count
 * them twice, and their rows would make the day's chunk look already stored. Every hour before
 * them is backfilled in day-sized chunks, oldest first.
 */
const rebuildEndMs = Math.floor(untilMs / HOUR_MS) * HOUR_MS + HOUR_MS
const boundaryMs = rebuildEndMs - REBUILT_HOURS * HOUR_MS
const chunks = Arr.filter(
	Arr.map(Arr.range(0, Math.ceil((boundaryMs - fromMs) / DAY_MS) - 1), (day) => ({
		startMs: fromMs + day * DAY_MS,
		endMs: Math.min(fromMs + (day + 1) * DAY_MS, boundaryMs),
	})),
	(chunk) => chunk.endMs > chunk.startMs,
)
/** Late points keep arriving after their hour ends; rebuild those hours only once they have. */
const boundaryReadyMs = rebuildEndMs + LATE_POINTS_MS
/** The source no longer holds hours older than its retention: deleting them would lose them for good. */
const sourceHoldsBoundary = Date.now() - boundaryMs < (sourceDays - 1) * DAY_MS

console.log(`Workspace ${host}`)
console.log(
	`${target}: ${chunks.length} day(s) ${new Date(fromMs).toISOString()} → ${new Date(boundaryMs).toISOString()}, then ${new Date(boundaryMs).toISOString()} → ${new Date(rebuildEndMs).toISOString()} rebuilt, ${pauseMs / 1000}s apart (${execute ? "EXECUTE" : "dry run"})\n`,
)
if (execute && Date.now() < boundaryReadyMs)
	fail(
		`The hours around --until are still receiving points: run after ${new Date(boundaryReadyMs).toISOString()}`,
	)
if (!sourceHoldsBoundary)
	fail(
		`${target}'s source keeps ${sourceDays} days: the hours around --until can no longer be rebuilt from it, so nothing is deleted`,
	)

const viewNames = Arr.join(
	Arr.map(views, (view) => view.pipe),
	" and ",
)

for (const chunk of chunks) {
	const label = `${new Date(chunk.startMs).toISOString()} → ${new Date(chunk.endMs).toISOString()}`
	const stored = await storedRows(chunk.startMs, chunk.endMs)
	if (stored > 0) {
		console.log(`${label}  skip (${stored} rows already stored)`)
		continue
	}
	if (!execute) {
		console.log(`${label}  would populate ${viewNames}`)
		continue
	}
	process.stdout.write(`${label}  populating… `)
	for (const view of views) await populate(view, chunk.startMs, chunk.endMs)
	console.log("done")
	await sleep(pauseMs)
}

const boundaryLabel = `${new Date(boundaryMs).toISOString()} → ${new Date(rebuildEndMs).toISOString()}`
if (execute) {
	process.stdout.write(`${boundaryLabel}  rebuilding… `)
	await deleteHours(boundaryMs, rebuildEndMs)
	for (const view of views) await populate(view, boundaryMs, rebuildEndMs)
	console.log("done")
} else console.log(`${boundaryLabel}  would delete and repopulate from ${viewNames}`)

console.log(
	execute ? `\n✓ Backfilled ${target} on ${host}` : "\nDry run, nothing written. Re-run with --execute.",
)

#!/usr/bin/env bun
// Backfills `user_activity_hourly` on a managed Tinybird workspace (deployed with `BACKFILL skip`):
// both views repopulated a day at a time, oldest first, paused between days. Dry run unless
// `--execute`; runbook in docs/warehouse-rollups.md.
import { setTimeout as sleep } from "node:timers/promises"
import { Array as Arr, Schema, String as Str } from "effect"

const TARGET = "user_activity_hourly"
/** The two views and the source time column their populate condition filters on. */
const VIEWS = [
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
] as const

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const POLL_MS = 5_000
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

const SqlCount = Schema.Struct({
	data: Schema.Array(Schema.Struct({ n: Schema.Union([Schema.Number, Schema.String]) })),
})
const PopulateJob = Schema.Struct({ job: Schema.Struct({ id: Schema.String, job_url: Schema.String }) })
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

/** Rows already in the chunk's whole hours; the hour `--until` falls in is shared with the views. */
const storedRows = async (startMs: number, endMs: number): Promise<number> => {
	const sql = `SELECT count() AS n FROM ${TARGET} WHERE Hour >= ${chTime(startMs)} AND Hour < ${chTime(endMs)} FORMAT JSON`
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
const populate = async (view: (typeof VIEWS)[number], startMs: number, endMs: number) => {
	const condition = `${view.column} >= ${chTime(startMs)} AND ${view.column} < ${chTime(endMs)}`
	const { job } = await tinybird(PopulateJob, `/v0/pipes/${view.pipe}/nodes/${view.node}/population`, {
		method: "POST",
		body: new URLSearchParams({ populate_condition: condition, truncate: "false" }),
	})
	await waitForJob(job.job_url, `Populate job ${job.id} on ${view.pipe}`)
}

const until = parseInstant(
	"--until",
	arg("--until") ?? fail("Missing --until <iso> (when the views went live)"),
)
const untilMs = until.getTime()
const fromMs =
	Math.floor(
		parseInstant("--from", arg("--from") ?? new Date(untilMs - 30 * DAY_MS).toISOString()).getTime() /
			DAY_MS,
	) * DAY_MS
if (fromMs >= untilMs) fail("--from must be before --until")
const pauseMs = Number(arg("--pause-seconds") ?? "60") * 1000
if (!Number.isFinite(pauseMs) || pauseMs < 0) fail("--pause-seconds must be a non-negative number")
const execute = process.argv.includes("--execute")

/** Day-sized chunks, oldest first; the last one stops at `--until`. */
const chunks = Arr.map(Arr.range(0, Math.ceil((untilMs - fromMs) / DAY_MS) - 1), (day) => ({
	startMs: fromMs + day * DAY_MS,
	endMs: Math.min(fromMs + (day + 1) * DAY_MS, untilMs),
}))

console.log(`Workspace ${host}`)
console.log(
	`${TARGET}: ${chunks.length} day(s) ${new Date(fromMs).toISOString()} → ${until.toISOString()}, ${pauseMs / 1000}s apart (${execute ? "EXECUTE" : "dry run"})\n`,
)

for (const [index, chunk] of chunks.entries()) {
	const label = `${new Date(chunk.startMs).toISOString()} → ${new Date(chunk.endMs).toISOString()}`
	const stored = await storedRows(chunk.startMs, Math.floor(chunk.endMs / HOUR_MS) * HOUR_MS)
	if (stored > 0) {
		console.log(`${label}  skip (${stored} rows already stored)`)
		continue
	}
	if (!execute) {
		console.log(
			`${label}  would populate ${Arr.join(
				Arr.map(VIEWS, (view) => view.pipe),
				" and ",
			)}`,
		)
		continue
	}
	process.stdout.write(`${label}  populating… `)
	for (const view of VIEWS) await populate(view, chunk.startMs, chunk.endMs)
	console.log("done")
	if (index < chunks.length - 1) await sleep(pauseMs)
}

console.log(
	execute ? `\n✓ Backfilled ${TARGET} on ${host}` : "\nDry run, nothing written. Re-run with --execute.",
)

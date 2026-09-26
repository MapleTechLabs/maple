// Local service-map rollup. Seals completed hours of `service_map_edges_hourly`
// from raw spans, as `ServiceMapRollupService` does in cloud; nothing else
// fills that table, so without it every complete hour drops off the map.

import * as CH from "@maple/query-engine/ch"
import { Clock, Duration, Effect, Schema } from "effect"
import type { Chdb } from "./chdb"
import { decodeJsonEachRow } from "./chdb-rows"

const ORG_ID = "local"
const HOUR_MS = CH.SERVICE_MAP_ROLLUP_HOUR_MS

/** Lets exporters flush spans buffered while the server was down before hours seal. */
export const ROLLUP_INITIAL_DELAY = Duration.seconds(60)
/** An hour seals only this long after it ends, so late export batches land in it first. */
export const ROLLUP_SETTLE_MS = 2 * 60_000
export const ROLLUP_INTERVAL = Duration.minutes(5)
/** Faster cadence while startup catch-up still has hours left. */
export const ROLLUP_CATCH_UP_INTERVAL = Duration.seconds(30)
/** chDB blocks the JS thread, so one tick joins at most this many hours. */
export const MAX_HOURS_PER_TICK = 12
/** Startup catch-up never reaches further back than this. */
export const CATCH_UP_MAX_HOURS = 7 * 24

export class LocalServiceMapRollupError extends Schema.TaggedError<LocalServiceMapRollupError>()(
	"@maple/cli/LocalServiceMapRollupError",
	{ message: Schema.String, cause: Schema.Defect() },
) {}

/** The server's admission gate; `null` means maintenance or shutdown holds it. */
export interface RollupAdmission {
	readonly enter: () => (() => void) | null
}

export interface LocalServiceMapRollupDeps {
	readonly db: Pick<Chdb, "query" | "exec">
	readonly gate: RollupAdmission
	readonly isRetiredDay: (rangeDate: string) => boolean
}

/** Catch-up progress for one server lifetime; hours below the cursor are pending. */
export interface LocalServiceMapRollupState {
	catchUp: { cursorMs: number; floorMs: number } | undefined
}

export interface LocalServiceMapRollupTick {
	readonly hoursRolledUp: number
	readonly catchUpPending: boolean
	readonly admitted: boolean
}

const EDGE_COLUMNS = [
	"OrgId",
	"Hour",
	"SourceService",
	"TargetService",
	"DeploymentEnv",
	"CallCount",
	"ErrorCount",
	"DurationSumMs",
	"MaxDurationMs",
	"SampledSpanCount",
	"UnsampledSpanCount",
	"SampleRateSum",
].join(", ")

const RESOLUTION_COLUMNS = [
	"OrgId",
	"Hour",
	"SourceService",
	"ParentServerAddress",
	"ResolvedTargetService",
	"DeploymentEnv",
].join(", ")

const describe = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

const fail = (message: string) => (cause: unknown) =>
	new LocalServiceMapRollupError({ message: `${message}: ${describe(cause)}`, cause })

/** The compiled SELECT without its trailing `FORMAT`, ready to nest or re-format. */
const selectBody = <A, E>(
	compiled: Effect.Effect<{ readonly sql: string } & A, E>,
	label: string,
): Effect.Effect<string, LocalServiceMapRollupError> =>
	compiled.pipe(
		Effect.mapError(fail(`compile ${label}`)),
		Effect.map((query) => query.sql.replace(/\s+FORMAT\s+\w+\s*$/, "")),
	)

const runQuery = (db: LocalServiceMapRollupDeps["db"], sql: string, label: string) =>
	Effect.try({ try: () => db.query(`${sql}\nFORMAT JSONEachRow`), catch: fail(label) })

const runExec = (db: LocalServiceMapRollupDeps["db"], sql: string, label: string) =>
	Effect.try({ try: () => db.exec(sql), catch: fail(label) })

const decodeHourRows = decodeJsonEachRow(Schema.Struct({ hourTs: CH.CHNumber }))
const decodePresenceRows = decodeJsonEachRow(
	Schema.Struct({ signal: Schema.String, firstSeen: Schema.String }),
)

const decodeRows = <A>(decode: (text: string) => A, text: string, label: string) =>
	Effect.try({ try: () => decode(text), catch: fail(`decode ${label}`) })

const hourFloor = (ms: number): number => Math.floor(ms / HOUR_MS) * HOUR_MS

const utcDate = (hourMs: number): string => new Date(hourMs).toISOString().slice(0, 10)

/** Start of the first hour with traces since `sinceMs`, read from the hourly usage rollup. */
const firstTraceHourMs = (db: LocalServiceMapRollupDeps["db"], sinceMs: number, nowMs: number) =>
	Effect.gen(function* () {
		const sql = yield* selectBody(
			CH.compileUnion(
				CH.signalPresenceQuery(),
				CH.serviceMapRollupWindowParams(ORG_ID, sinceMs, nowMs),
			),
			"signal presence",
		)
		const rows = yield* decodeRows(
			decodePresenceRows,
			yield* runQuery(db, sql, "signal presence"),
			"presence",
		)
		const firstSeen = rows.find((row) => row.signal === "traces")?.firstSeen
		const parsed = firstSeen === undefined ? Number.NaN : Date.parse(`${firstSeen.replace(" ", "T")}Z`)
		return Number.isFinite(parsed) && parsed >= sinceMs ? hourFloor(parsed) : undefined
	})

/** Hour starts (Unix seconds) already sealed in `service_map_edges_hourly`. */
const sealedHours = (db: LocalServiceMapRollupDeps["db"], oldestHourMs: number, currentHourMs: number) =>
	Effect.gen(function* () {
		const sql = yield* selectBody(
			CH.serviceMapEdgesExistingHoursSQL(
				CH.serviceMapRollupWindowParams(ORG_ID, oldestHourMs, currentHourMs),
			),
			"existing hours",
		)
		const text = yield* runQuery(db, sql, "existing hours")
		return CH.serviceMapHourSet(yield* decodeRows(decodeHourRows, text, "existing hours"))
	})

/**
 * Roll up one hour inside the admission gate. Resolutions are written first and
 * the edges (the seal) last, so a failure leaves the hour unsealed and the next
 * tick redoes both; the resolutions table is a ReplacingMergeTree.
 */
const rollupHour = (deps: LocalServiceMapRollupDeps, hourMs: number) =>
	Effect.acquireUseRelease(
		Effect.sync(() => deps.gate.enter()),
		(leave) =>
			leave === null
				? Effect.succeed(false)
				: Effect.gen(function* () {
						const params = CH.serviceMapRollupHourParams(ORG_ID, hourMs)
						const resolutions = yield* selectBody(
							CH.serviceMapResolutionsRollupSQL(params),
							"resolutions",
						)
						const edges = yield* selectBody(CH.serviceMapEdgesRollupSQL(params), "edges")
						yield* runExec(
							deps.db,
							`INSERT INTO service_address_resolutions_hourly (${RESOLUTION_COLUMNS}) SELECT ${RESOLUTION_COLUMNS} FROM (${resolutions})`,
							"insert address resolutions",
						)
						yield* runExec(
							deps.db,
							`INSERT INTO service_map_edges_hourly_ingest (${EDGE_COLUMNS}) SELECT ${EDGE_COLUMNS} FROM (${edges})`,
							"insert service map edges",
						)
						return true
					}),
		(leave) => Effect.sync(() => leave?.()),
	)

/**
 * One tick: every unsealed completed hour of the trailing lookback window, then
 * startup catch-up hours below it, newest first, at most `MAX_HOURS_PER_TICK`.
 * Sealed hours and retired UTC days are skipped, so a rerun is a no-op.
 */
export const runLocalServiceMapRollupTick = (
	deps: LocalServiceMapRollupDeps,
	state: LocalServiceMapRollupState,
	nowMs: number,
): Effect.Effect<LocalServiceMapRollupTick, LocalServiceMapRollupError> =>
	Effect.gen(function* () {
		const currentHourMs = hourFloor(nowMs - ROLLUP_SETTLE_MS)
		const steadyOldest = currentHourMs - CH.SERVICE_MAP_ROLLUP_LOOKBACK_HOURS * HOUR_MS
		if (state.catchUp === undefined) {
			const limit = currentHourMs - CATCH_UP_MAX_HOURS * HOUR_MS
			const first = yield* firstTraceHourMs(deps.db, limit, nowMs)
			state.catchUp = { cursorMs: steadyOldest, floorMs: Math.min(steadyOldest, first ?? steadyOldest) }
		}
		const catchUp = state.catchUp
		const chunkStart = Math.max(catchUp.floorMs, catchUp.cursorMs - MAX_HOURS_PER_TICK * HOUR_MS)
		const oldest = Math.min(steadyOldest, chunkStart)
		const sealed = yield* sealedHours(deps.db, oldest, currentHourMs)
		const missing = CH.serviceMapRollupMissingHours(
			CH.serviceMapRollupCandidateHours(oldest, currentHourMs),
			sealed,
		).filter((hourMs) => !deps.isRetiredDay(utcDate(hourMs)))
		const steady = missing.filter((hourMs) => hourMs >= steadyOldest).reverse()
		const pending = missing
			.filter((hourMs) => hourMs >= chunkStart && hourMs < catchUp.cursorMs)
			.reverse()
		const work = [...steady, ...pending].slice(0, MAX_HOURS_PER_TICK)

		let hoursRolledUp = 0
		let admitted = true
		let cursorMs = catchUp.cursorMs
		for (const hourMs of work) {
			if (!(yield* rollupHour(deps, hourMs))) {
				admitted = false
				break
			}
			hoursRolledUp++
			if (hourMs < catchUp.cursorMs) cursorMs = hourMs
			// Let queued ingest and queries run between hours.
			yield* Effect.sleep(Duration.millis(1))
		}
		// The whole chunk was handled (rolled up, sealed, or retired): move past it.
		if (admitted && work.length === steady.length + pending.length) cursorMs = chunkStart
		state.catchUp = { ...catchUp, cursorMs }
		return { hoursRolledUp, admitted, catchUpPending: cursorMs > catchUp.floorMs }
	})

/** Runs shortly after start, then every `ROLLUP_INTERVAL` (faster while catching up). */
export const localServiceMapRollupLoop = (deps: LocalServiceMapRollupDeps): Effect.Effect<never> =>
	Effect.gen(function* () {
		const state: LocalServiceMapRollupState = { catchUp: undefined }
		yield* Effect.sleep(ROLLUP_INITIAL_DELAY)
		while (true) {
			const tick = yield* runLocalServiceMapRollupTick(
				deps,
				state,
				yield* Clock.currentTimeMillis,
			).pipe(
				Effect.tap((result) =>
					result.hoursRolledUp > 0
						? Effect.logDebug(`service map rollup sealed ${result.hoursRolledUp} hour(s)`)
						: Effect.void,
				),
				Effect.catchTag("@maple/cli/LocalServiceMapRollupError", (error) =>
					Effect.as(Effect.logWarning(`service map rollup failed: ${error.message}`), undefined),
				),
			)
			yield* Effect.sleep(tick?.catchUpPending ? ROLLUP_CATCH_UP_INTERVAL : ROLLUP_INTERVAL)
		}
	})

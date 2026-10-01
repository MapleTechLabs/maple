// Scoped delete for the local store: one service's telemetry (optionally one
// deployment.environment and/or everything before an hour) leaves the raw
// tables and every table derived from them. See docs/local-mode.md.

import { Effect, Option, Schema } from "effect"
import { existsSync } from "node:fs"
import type { Chdb } from "./chdb"
import { decodeJsonEachRow, decodeRowCounts } from "./chdb-rows"
import { durableJson, durableRemove } from "./durable-files"
import { readRealFile } from "./local-token"
import { type LocalSchemaManifest, ttlDaysFromDefinition, viewBody } from "./schema-manifest"
import { dataDirSidecarPath } from "./store-version"

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

type Db = Pick<Chdb, "query" | "exec">

export class ScopedDeleteError extends Schema.TaggedError<ScopedDeleteError>()(
	"@maple/cli/ScopedDeleteError",
	{ message: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {}

/** Where a table's environment lives: a column, or the OTel resource map. */
export type EnvSource = { readonly column: string } | { readonly resourceAttributes: string }

/** `filter` deletes by column (`env: null`: no env, so `--env` recomputes it), `rebuild`
 * recomputes affected hours from surviving source rows, `excluded` never holds local telemetry. */
export type TableDeletePlan =
	| {
			readonly strategy: "filter"
			/** A row matches when any of these columns equals `--service`. */
			readonly service: ReadonlyArray<string>
			readonly env: EnvSource | null
			readonly time: string
	  }
	| { readonly strategy: "rebuild"; readonly time: string; readonly reason: string }
	| { readonly strategy: "excluded"; readonly reason: string }

const RESOURCE_ENV: EnvSource = { resourceAttributes: "ResourceAttributes" }
const DEPLOYMENT_ENV: EnvSource = { column: "DeploymentEnv" }

const raw = (time: string): TableDeletePlan => ({
	strategy: "filter",
	service: ["ServiceName"],
	env: RESOURCE_ENV,
	time,
})
const derived = (time: string, env: EnvSource | null = DEPLOYMENT_ENV): TableDeletePlan => ({
	strategy: "filter",
	service: ["ServiceName"],
	env,
	time,
})
const edges = (target: string): TableDeletePlan => ({
	strategy: "filter",
	service: ["SourceService", target],
	env: DEPLOYMENT_ENV,
	time: "Hour",
})
const NOT_TELEMETRY = "control-plane history, not telemetry; local mode never writes it"
const SESSION_DATA = "browser session data; local OTLP ingest never writes it"

/**
 * Every table in the local schema. `validateDeletePlan` (and its test) fails when
 * the schema gains a table this map does not classify.
 */
/** Delete strategy per table name; keys are checked against the schema at runtime. */
export type TableDeletePlans = Readonly<Record<string, TableDeletePlan>>

export const TABLE_DELETE_PLAN = {
	ai_crawler_requests: derived("Timestamp", null),
	ai_trace_index: derived("Timestamp"),
	alert_checks: { strategy: "excluded", reason: NOT_TELEMETRY },
	attribute_keys_hourly: {
		strategy: "rebuild",
		time: "Hour",
		reason: "org-wide attribute discovery; rows have no service column",
	},
	attribute_values_hourly: {
		strategy: "rebuild",
		time: "Hour",
		reason: "org-wide attribute discovery; rows have no service column",
	},
	audit_log: { strategy: "excluded", reason: NOT_TELEMETRY },
	error_events: derived("Timestamp"),
	error_events_by_time: derived("Timestamp"),
	error_fingerprints_minutely: {
		strategy: "rebuild",
		time: "Minute",
		reason: "ServiceName is an anyLast aggregate, not a key; one row can mix services",
	},
	identity_links: { strategy: "excluded", reason: SESSION_DATA },
	logs: raw("Timestamp"),
	logs_aggregates_hourly: derived("Hour"),
	metric_catalog: derived("Hour", null),
	metrics_exponential_histogram: raw("TimeUnix"),
	metrics_gauge: raw("TimeUnix"),
	metrics_histogram: raw("TimeUnix"),
	metrics_sum: raw("TimeUnix"),
	product_events: derived("Timestamp", null),
	service_address_resolutions_hourly: edges("ResolvedTargetService"),
	service_external_edges_hourly: derived("Hour"),
	service_map_children: derived("Timestamp"),
	service_map_db_edges_hourly: derived("Hour"),
	service_map_db_query_shapes_hourly: derived("Hour"),
	service_map_edges_hourly: edges("TargetService"),
	service_map_edges_hourly_ingest: {
		strategy: "excluded",
		reason: "Null engine: stores no rows; its view writes service_map_edges_hourly",
	},
	service_map_spans: derived("Timestamp"),
	service_operations_hourly: derived("Hour"),
	service_operations_minutely: derived("Minute"),
	service_overview_hourly: derived("Hour"),
	service_overview_minutely: derived("Minute"),
	service_overview_spans: derived("Timestamp"),
	service_platforms_hourly: derived("Hour"),
	service_usage: derived("Hour", null),
	session_events: { strategy: "excluded", reason: SESSION_DATA },
	session_replay_events: { strategy: "excluded", reason: SESSION_DATA },
	session_replays: { strategy: "excluded", reason: SESSION_DATA },
	span_metrics_calls_hourly: derived("Hour", null),
	trace_detail_spans: derived("Timestamp", RESOURCE_ENV),
	trace_facets_hourly: derived("Hour"),
	trace_list_mv: derived("Timestamp"),
	traces: raw("Timestamp"),
	traces_aggregates_hourly: derived("Hour"),
} satisfies TableDeletePlans

const lookup =
	(plans: TableDeletePlans) =>
	(table: string): TableDeletePlan | undefined =>
		plans[table]
/** The plan for any table name, or undefined when the schema has no such table. */
export const tablePlan = lookup(TABLE_DELETE_PLAN)

// ---------------------------------------------------------------------------
// Schema graph.
// ---------------------------------------------------------------------------

interface ViewEdge {
	readonly name: string
	readonly target: string
	readonly sources: ReadonlyArray<string>
	readonly body: string
}

const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/g

const materializedViews = (manifest: LocalSchemaManifest): ReadonlyArray<ViewEdge> => {
	const tables = new Set(manifest.objects.filter((o) => o.kind === "table").map((o) => o.name))
	return manifest.objects
		.filter((o) => o.kind === "materialized_view")
		.map((o) => {
			const body = viewBody(o.definition) ?? ""
			const sources = [...body.matchAll(/\bFROM\s+([A-Za-z_][A-Za-z0-9_]*)/gi)]
				.map((match) => match[1]!)
				.filter((name) => tables.has(name))
			return {
				name: o.name,
				target: o.definition.match(/\bTO\s+([A-Za-z_][A-Za-z0-9_]*)/i)?.[1] ?? "",
				sources: [...new Set(sources)],
				body,
			}
		})
}

const isRecomputable = (plan: TableDeletePlan | undefined): boolean =>
	plan?.strategy === "rebuild" || (plan?.strategy === "filter" && plan.env === null)

/**
 * Everything that must hold for the plan to delete exactly the requested rows
 * from the given schema. Empty means sound; the server refuses otherwise.
 */
export const validateDeletePlan = (
	manifest: LocalSchemaManifest,
	plan: TableDeletePlans = TABLE_DELETE_PLAN,
): ReadonlyArray<string> => {
	const problems: string[] = []
	const tables = new Map(manifest.objects.filter((o) => o.kind === "table").map((o) => [o.name, o]))
	const views = materializedViews(manifest)
	for (const name of tables.keys())
		if (plan[name] === undefined) problems.push(`${name}: no delete plan for this table`)
	for (const name of Object.keys(plan))
		if (!tables.has(name)) problems.push(`${name}: planned but not in the schema`)

	for (const [name, entry] of Object.entries(plan)) {
		const table = tables.get(name)
		if (table === undefined || entry.strategy === "excluded") continue
		const columns = new Set(table.columns.map((c) => c.name))
		const keyColumns = new Set(table.orderBy?.match(IDENTIFIER) ?? [])
		// Only a plain MergeTree row is one event; any other engine merges rows by key.
		const merges = table.engine !== "MergeTree"
		const needColumn = (column: string, role: string) => {
			if (!columns.has(column)) problems.push(`${name}: ${role} column ${column} does not exist`)
			else if (merges && !keyColumns.has(column))
				problems.push(`${name}: ${role} column ${column} is not in the sorting key of ${table.engine}`)
		}
		needColumn(entry.time, "time")
		if (entry.strategy === "filter") {
			for (const column of entry.service) needColumn(column, "service")
			if (entry.env !== null) {
				if ("column" in entry.env) needColumn(entry.env.column, "env")
				else if (merges) problems.push(`${name}: a merging engine cannot filter env from a map`)
				else if (!columns.has(entry.env.resourceAttributes))
					problems.push(`${name}: env map ${entry.env.resourceAttributes} does not exist`)
			}
		}
		if (!isRecomputable(entry)) continue
		if (entry.strategy === "filter" && (entry.service.length !== 1 || entry.service[0] !== "ServiceName"))
			problems.push(`${name}: a recomputed service-scoped table must key on ServiceName alone`)
		const feeding = views.filter(
			(view) => view.target === name && view.sources.some((s) => plan[s]?.strategy !== "excluded"),
		)
		if (feeding.length === 0) problems.push(`${name}: recomputed but no view writes it from telemetry`)
		for (const view of feeding) {
			if (view.sources.length !== 1) {
				problems.push(`${view.name}: recomputing needs exactly one source table`)
				continue
			}
			const source = view.sources[0]!
			const sourcePlan = plan[source]
			if (sourcePlan?.strategy !== "filter" || sourcePlan.env === null)
				problems.push(`${view.name}: source ${source} must be a filter table with an env dimension`)
			if (sourceReferences(view.body, source) !== 1)
				problems.push(`${view.name}: recomputing needs exactly one FROM ${source}`)
		}
		if (views.some((view) => view.sources.includes(name)))
			problems.push(`${name}: recomputed rows would cascade into the views it feeds`)
	}

	// Rows derived from deletable telemetry must never land in an excluded table.
	for (const view of views) {
		if (plan[view.target]?.strategy !== "excluded") continue
		for (const source of view.sources)
			if (plan[source] !== undefined && plan[source]!.strategy !== "excluded")
				problems.push(`${view.name}: writes excluded ${view.target} from ${source}`)
	}
	return problems
}

const fromPattern = (source: string) => new RegExp(`\\bFROM\\s+${source}\\b`, "gi")
const sourceReferences = (body: string, source: string): number =>
	[...body.matchAll(fromPattern(source))].length

// ---------------------------------------------------------------------------
// Request and SQL.
// ---------------------------------------------------------------------------

export const ScopedDeleteRequest = Schema.Struct({
	service: Schema.NonEmptyString.check(Schema.isMaxLength(512)),
	env: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(512))),
	/** Exclusive cutoff, epoch ms; the server floors it to the UTC hour. */
	beforeMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
})
export type ScopedDeleteRequest = typeof ScopedDeleteRequest.Type

/** Bucketed rollups cannot split an hour, so every table uses the same hour cutoff. */
export const floorToHour = (ms: number): number => Math.floor(ms / HOUR_MS) * HOUR_MS

const sqlString = (value: string): string => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`

const envExpression = (env: EnvSource): string =>
	"column" in env
		? env.column
		: `coalesce(nullIf(${env.resourceAttributes}['deployment.environment.name'], ''), ${env.resourceAttributes}['deployment.environment'])`

const hourOf = (column: string) => `toUnixTimestamp(toStartOfHour(toDateTime(${column})))`

/** The rows a request names in a filter table, or null when `--env` cannot apply there. */
const filterPredicate = (
	entry: Extract<TableDeletePlan, { strategy: "filter" }>,
	request: ScopedDeleteRequest,
): string | null => {
	if (request.env !== undefined && entry.env === null) return null
	const service = sqlString(request.service)
	const parts = [`(${entry.service.map((column) => `${column} = ${service}`).join(" OR ")})`]
	if (request.env !== undefined && entry.env !== null)
		parts.push(`${envExpression(entry.env)} = ${sqlString(request.env)}`)
	if (request.beforeMs !== undefined)
		parts.push(`${entry.time} < toDateTime(${Math.floor(request.beforeMs / 1000)})`)
	return parts.join(" AND ")
}

const hourList = (hours: ReadonlyArray<number>) => hours.join(", ")

// ---------------------------------------------------------------------------
// Execution.
// ---------------------------------------------------------------------------

export const ScopedDeleteTableReport = Schema.Struct({
	table: Schema.String,
	strategy: Schema.Literals(["filter", "rebuild", "excluded"]),
	/** Filter: rows deleted. Rebuild: rows in the recomputed hours before recomputing. */
	rows: Schema.Number,
	rebuiltHours: Schema.optionalKey(Schema.Number),
	/** Hours older than a source's retention: left as-is because they cannot be recomputed. */
	skippedHours: Schema.optionalKey(Schema.Number),
	reason: Schema.optionalKey(Schema.String),
})
export type ScopedDeleteTableReport = typeof ScopedDeleteTableReport.Type

export const ScopedDeleteReport = Schema.Struct({
	request: ScopedDeleteRequest,
	dryRun: Schema.Boolean,
	deletedRows: Schema.Number,
	tables: Schema.Array(ScopedDeleteTableReport),
})
export type ScopedDeleteReport = typeof ScopedDeleteReport.Type

interface Rebuild {
	readonly table: string
	readonly time: string
	/** Set when only this service's rows are recomputed (a keyed table under `--env`). */
	readonly serviceColumn: string | null
	readonly views: ReadonlyArray<ViewEdge & { readonly source: string }>
}

interface ResolvedPlan {
	readonly filters: ReadonlyArray<{ readonly table: string; readonly predicate: string }>
	readonly rebuilds: ReadonlyArray<Rebuild>
	readonly excluded: ReadonlyArray<{ readonly table: string; readonly reason: string }>
}

const resolvePlan = (manifest: LocalSchemaManifest, request: ScopedDeleteRequest): ResolvedPlan => {
	const views = materializedViews(manifest)
	const filters: Array<ResolvedPlan["filters"][number]> = []
	const rebuilds: Rebuild[] = []
	const excluded: Array<ResolvedPlan["excluded"][number]> = []
	for (const [table, entry] of Object.entries(TABLE_DELETE_PLAN)) {
		if (entry.strategy === "excluded") {
			excluded.push({ table, reason: entry.reason })
			continue
		}
		const predicate = entry.strategy === "filter" ? filterPredicate(entry, request) : null
		if (predicate !== null) {
			filters.push({ table, predicate })
			continue
		}
		rebuilds.push({
			table,
			time: entry.time,
			serviceColumn: entry.strategy === "filter" ? "ServiceName" : null,
			views: views
				.filter((view) => view.target === table)
				.flatMap((view) => {
					const source = view.sources[0]
					return source !== undefined && tablePlan(source)?.strategy === "filter"
						? [{ ...view, source }]
						: []
				}),
		})
	}
	return { filters, rebuilds, excluded }
}

const run = <A>(label: string, f: () => A) =>
	Effect.try({
		try: f,
		catch: (cause) =>
			new ScopedDeleteError({
				message: `${label}: ${cause instanceof Error ? cause.message : String(cause)}`,
				cause,
			}),
	})

const countRows = (db: Db, table: string, predicate: string) =>
	run(`count ${table}`, () =>
		Number(
			decodeRowCounts(
				db.query(`SELECT toString(count()) AS rowCount FROM ${table} WHERE ${predicate}`),
			)[0]?.rowCount ?? 0,
		),
	)

const decodeHours = decodeJsonEachRow(Schema.Struct({ hour: Schema.String }))
const decodeNames = decodeJsonEachRow(Schema.Struct({ name: Schema.String }))

const distinctHours = (db: Db, table: string, time: string, predicate: string) =>
	run(`hours of ${table}`, () =>
		decodeHours(
			db.query(`SELECT DISTINCT toString(${hourOf(time)}) AS hour FROM ${table} WHERE ${predicate}`),
		).map((row) => Number(row.hour)),
	)

/** Hours (epoch seconds) a rebuild must recompute: the hours its sources lose rows in. */
const affectedHours = (db: Db, rebuild: Rebuild, request: ScopedDeleteRequest) =>
	Effect.gen(function* () {
		const hours = new Set<number>()
		for (const source of new Set(rebuild.views.map((view) => view.source))) {
			const entry = tablePlan(source)
			if (entry?.strategy !== "filter") continue
			const predicate = filterPredicate(entry, request)
			if (predicate === null) continue
			for (const hour of yield* distinctHours(db, source, entry.time, predicate)) hours.add(hour)
		}
		return [...hours].sort((a, b) => a - b)
	})

/**
 * An hour is recomputable only while every source still holds all of it. TTL
 * drops whole days at merge time, so keep a day of margin; the bundled TTL is
 * the shortest a store can have, so this never recomputes from a partial source.
 */
const recomputable = (
	manifest: LocalSchemaManifest,
	rebuild: Rebuild,
	hours: ReadonlyArray<number>,
	nowMs: number,
) => {
	const ttls = rebuild.views.map((view) => {
		const definition = manifest.objects.find((o) => o.name === view.source)?.definition ?? ""
		return ttlDaysFromDefinition(definition)
	})
	const kept: number[] = []
	const skipped: number[] = []
	for (const hour of hours) {
		const covered = ttls.every((days) => days === null || hour * 1000 + days * DAY_MS > nowMs + DAY_MS)
		;(covered ? kept : skipped).push(hour)
	}
	return { kept, skipped }
}

const rebuildTargetPredicate = (rebuild: Rebuild, request: ScopedDeleteRequest, hours: ReadonlyArray<number>) =>
	[
		...(rebuild.serviceColumn === null ? [] : [`${rebuild.serviceColumn} = ${sqlString(request.service)}`]),
		`${hourOf(rebuild.time)} IN (${hourList(hours)})`,
	].join(" AND ")

const applyRebuild = (
	db: Db,
	manifest: LocalSchemaManifest,
	rebuild: Rebuild,
	request: ScopedDeleteRequest,
	hours: ReadonlyArray<number>,
) =>
	Effect.gen(function* () {
		if (hours.length === 0) return
		yield* run(`clear ${rebuild.table}`, () =>
			db.exec(
				`ALTER TABLE ${rebuild.table} DELETE WHERE ${rebuildTargetPredicate(rebuild, request, hours)} SETTINGS mutations_sync = 2`,
			),
		)
		// One UTC day per INSERT keeps each recompute's GROUP BY bounded.
		const days = new Map<number, number[]>()
		for (const hour of hours) {
			const day = Math.floor(hour / 86_400)
			days.set(day, [...(days.get(day) ?? []), hour])
		}
		for (const view of rebuild.views) {
			const sourceColumns = manifest.objects
				.find((o) => o.name === view.source)
				?.columns.map((c) => c.name)
				.join(", ")
			const sourceTime = tablePlan(view.source)
			if (sourceColumns === undefined || sourceTime?.strategy !== "filter")
				return yield* new ScopedDeleteError({ message: `${view.name}: unknown source ${view.source}` })
			// The view's own output columns, so the INSERT matches by name, not position.
			const columns = yield* run(`columns of ${view.name}`, () =>
				decodeNames(
					db.query(
						`SELECT name FROM system.columns WHERE database = currentDatabase() AND table = ${sqlString(view.name)} ORDER BY position`,
					),
				).map((row) => row.name),
			)
			if (columns.length === 0)
				return yield* new ScopedDeleteError({ message: `${view.name}: no columns in system.columns` })
			for (const dayHours of days.values()) {
				const scope = [
					...(rebuild.serviceColumn === null ? [] : [`ServiceName = ${sqlString(request.service)}`]),
					`${hourOf(sourceTime.time)} IN (${hourList(dayHours)})`,
				].join(" AND ")
				const body = view.body.replace(
					fromPattern(view.source),
					`FROM (SELECT ${sourceColumns} FROM ${view.source} WHERE ${scope}) AS ${view.source}`,
				)
				const list = columns.join(", ")
				yield* run(`recompute ${rebuild.table} via ${view.name}`, () =>
					db.exec(`INSERT INTO ${rebuild.table} (${list}) SELECT ${list} FROM (${body})`),
				)
			}
		}
	})

const applyFilters = (db: Db, filters: ResolvedPlan["filters"]) =>
	Effect.forEach(
		filters,
		({ table, predicate }) =>
			Effect.gen(function* () {
				yield* run(`delete from ${table}`, () =>
					db.exec(`ALTER TABLE ${table} DELETE WHERE ${predicate} SETTINGS mutations_sync = 2`),
				)
				const left = yield* countRows(db, table, predicate)
				if (left !== 0)
					return yield* new ScopedDeleteError({ message: `${left} matching row(s) remain in ${table}` })
			}),
		{ discard: true },
	)

// ---------------------------------------------------------------------------
// Journal: written before the first mutation, removed after the last.
// ---------------------------------------------------------------------------

const PendingDelete = Schema.Struct({
	formatVersion: Schema.Literal(1),
	request: ScopedDeleteRequest,
	rebuildHours: Schema.Record(Schema.String, Schema.Array(Schema.Int)),
})
type PendingDelete = typeof PendingDelete.Type

export const pendingDeletePath = (dataDir: string): string =>
	dataDirSidecarPath(dataDir, "maple-pending-delete.json")

const readPending = (dataDir: string) =>
	Effect.gen(function* () {
		const path = pendingDeletePath(dataDir)
		if (!existsSync(path)) return Option.none<PendingDelete>()
		const text = yield* run("read pending delete", () => readRealFile(path, "pending delete journal"))
		return Option.some(
			yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PendingDelete))(text).pipe(
				Effect.mapError(
					(cause) =>
						new ScopedDeleteError({ message: `malformed pending delete journal ${path}`, cause }),
				),
			),
		)
	})

const writeFile = (label: string, f: () => Promise<void>) =>
	Effect.tryPromise({
		try: f,
		catch: (cause) => new ScopedDeleteError({ message: `${label}: ${String(cause)}`, cause }),
	})

const assertPlanSound = (manifest: LocalSchemaManifest) => {
	const problems = validateDeletePlan(manifest)
	return problems.length === 0
		? Effect.void
		: Effect.fail(
				new ScopedDeleteError({ message: `scoped delete plan does not match the schema: ${problems.join("; ")}` }),
			)
}

/** Apply a journaled request: filters are idempotent, rebuilds take their hours from the journal. */
const applyPending = (db: Db, manifest: LocalSchemaManifest, dataDir: string, pending: PendingDelete) =>
	Effect.gen(function* () {
		const plan = resolvePlan(manifest, pending.request)
		yield* applyFilters(db, plan.filters)
		for (const rebuild of plan.rebuilds)
			yield* applyRebuild(db, manifest, rebuild, pending.request, pending.rebuildHours[rebuild.table] ?? [])
		yield* writeFile("remove pending delete journal", () => durableRemove(pendingDeletePath(dataDir)))
	})

/** Finish a delete an earlier failure or crash left journaled. Run before serving. */
export const resumePendingDelete = (db: Db, manifest: LocalSchemaManifest, dataDir: string) =>
	Effect.gen(function* () {
		const pending = yield* readPending(dataDir)
		if (Option.isNone(pending)) return Option.none<ScopedDeleteRequest>()
		yield* assertPlanSound(manifest)
		// A restored checkpoint can bring the rows back; recompute their hours too.
		const rebuildHours: Record<string, number[]> = {}
		for (const rebuild of resolvePlan(manifest, pending.value.request).rebuilds) {
			const current = yield* affectedHours(db, rebuild, pending.value.request)
			const { kept } = recomputable(manifest, rebuild, current, Date.now())
			rebuildHours[rebuild.table] = [
				...new Set([...(pending.value.rebuildHours[rebuild.table] ?? []), ...kept]),
			].sort((a, b) => a - b)
		}
		yield* applyPending(db, manifest, dataDir, { ...pending.value, rebuildHours })
		return Option.some(pending.value.request)
	})

/**
 * Delete what `request` names. The caller holds exclusive access to the store
 * (the server's admission gate), so no ingest or rollup interleaves.
 */
export const runScopedDelete = (
	db: Db,
	manifest: LocalSchemaManifest,
	dataDir: string,
	input: ScopedDeleteRequest,
	options: { readonly dryRun: boolean; readonly nowMs?: number },
): Effect.Effect<ScopedDeleteReport, ScopedDeleteError> =>
	Effect.gen(function* () {
		yield* assertPlanSound(manifest)
		const nowMs = options.nowMs ?? Date.now()
		const request: ScopedDeleteRequest =
			input.beforeMs === undefined ? input : { ...input, beforeMs: floorToHour(input.beforeMs) }
		if (!options.dryRun) yield* resumePendingDelete(db, manifest, dataDir)

		const plan = resolvePlan(manifest, request)
		const tables: ScopedDeleteTableReport[] = []
		for (const { table, predicate } of plan.filters)
			tables.push({ table, strategy: "filter", rows: yield* countRows(db, table, predicate) })
		const rebuildHours: Record<string, number[]> = {}
		for (const rebuild of plan.rebuilds) {
			const hours = yield* affectedHours(db, rebuild, request)
			const { kept, skipped } = recomputable(manifest, rebuild, hours, nowMs)
			rebuildHours[rebuild.table] = kept
			tables.push({
				table: rebuild.table,
				strategy: "rebuild",
				rows:
					kept.length === 0
						? 0
						: yield* countRows(db, rebuild.table, rebuildTargetPredicate(rebuild, request, kept)),
				rebuiltHours: kept.length,
				skippedHours: skipped.length,
			})
		}
		for (const { table, reason } of plan.excluded) tables.push({ table, strategy: "excluded", rows: 0, reason })
		tables.sort((a, b) => a.table.localeCompare(b.table))
		const report: ScopedDeleteReport = {
			request,
			dryRun: options.dryRun,
			deletedRows: tables.reduce((sum, t) => sum + (t.strategy === "filter" ? t.rows : 0), 0),
			tables,
		}
		if (options.dryRun) return report

		const pending: PendingDelete = { formatVersion: 1, request, rebuildHours }
		yield* writeFile("write pending delete journal", () => durableJson(pendingDeletePath(dataDir), pending))
		yield* applyPending(db, manifest, dataDir, pending)
		return report
	})

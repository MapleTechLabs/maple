// Scoped delete for the local store: one service's or one service.namespace's
// telemetry (optionally one deployment.environment and/or everything before an
// hour) leaves the raw tables and every table derived from them. See docs/local-mode.md.

import { Clock, Effect, Option, Schema, Array as Arr, Record as Rec, String as Str } from "effect"
import { existsSync } from "node:fs"
import type { Chdb } from "./chdb"
import { decodeJsonEachRow, decodeRowCounts } from "./chdb-rows"
import { durableJson, durableRemove } from "./durable-files"
import { readRealFile } from "./local-token"
import {
	type LocalSchemaManifest,
	type LocalSchemaObject,
	ttlDaysFromDefinition,
	viewBody,
} from "./schema-manifest"
import { serviceMapRollupInserts } from "./service-map-rollup"
import { dataDirSidecarPath } from "./store-version"

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

type Db = Pick<Chdb, "query" | "exec">

export class ScopedDeleteError extends Schema.TaggedError<ScopedDeleteError>()(
	"@maple/cli/ScopedDeleteError",
	{ message: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {}

/** The request dimensions a table can carry. */
export type Dimension = "service" | "namespace" | "env"
const DIMENSIONS: ReadonlyArray<Dimension> = ["service", "namespace", "env"]

/** Where a dimension lives in a table: a column, or the OTel resource map. */
export type DimensionSource = { readonly column: string } | { readonly resourceAttributes: string }

/** `scoped` tables filter on the dimensions they declare and recompute when asked for one they lack. */
export type TableDeletePlan =
	| {
			readonly strategy: "scoped"
			readonly time: string
			/** Columns naming a service; a row matches when any equals `--service`. */
			readonly service: ReadonlyArray<string> | null
			readonly namespace: DimensionSource | null
			readonly env: DimensionSource | null
			/** Rebuild path when the request names an undeclared dimension. */
			readonly recompute: "views" | "service-map-rollup" | null
	  }
	| { readonly strategy: "excluded"; readonly reason: string }

const RESOURCE: DimensionSource = { resourceAttributes: "ResourceAttributes" }
const DEPLOYMENT_ENV: DimensionSource = { column: "DeploymentEnv" }
const SERVICE_NAMESPACE: DimensionSource = { column: "ServiceNamespace" }

const raw = (time: string): TableDeletePlan => ({
	strategy: "scoped",
	time,
	service: ["ServiceName"],
	namespace: RESOURCE,
	env: RESOURCE,
	recompute: null,
})
const derived = (
	time: string,
	dims: { readonly namespace?: DimensionSource; readonly env?: DimensionSource | null } = {},
): TableDeletePlan => ({
	strategy: "scoped",
	time,
	service: ["ServiceName"],
	namespace: dims.namespace ?? null,
	env: dims.env === undefined ? DEPLOYMENT_ENV : dims.env,
	recompute: "views",
})
/** Rows carry no usable service key (no column, or an aggregate), so they are always recomputed. */
const unkeyed = (time: string): TableDeletePlan => ({
	strategy: "scoped",
	time,
	service: null,
	namespace: null,
	env: null,
	recompute: "views",
})
/** Edges come from both services' spans, so a row matches on either end. */
const edges = (target: string): TableDeletePlan => ({
	strategy: "scoped",
	time: "Hour",
	service: ["SourceService", target],
	namespace: null,
	env: DEPLOYMENT_ENV,
	recompute: "service-map-rollup",
})
const NOT_TELEMETRY = "control-plane history, not telemetry; local mode never writes it"
const SESSION_DATA = "browser session data; local OTLP ingest never writes it"

/** Delete strategy per table name; keys are checked against the schema at runtime. */
export type TableDeletePlans = Readonly<Record<string, TableDeletePlan>>

/** Every table in the local schema; `validateDeletePlan` fails when one is missing. */
export const TABLE_DELETE_PLAN = {
	ai_crawler_requests: derived("Timestamp", { env: null }),
	ai_trace_index: derived("Timestamp"),
	alert_checks: { strategy: "excluded", reason: NOT_TELEMETRY },
	attribute_keys_hourly: unkeyed("Hour"),
	attribute_values_hourly: unkeyed("Hour"),
	audit_log: { strategy: "excluded", reason: NOT_TELEMETRY },
	ci_jobs: unkeyed("Timestamp"),
	ci_runs: unkeyed("Timestamp"),
	error_events: derived("Timestamp"),
	error_events_by_time: derived("Timestamp"),
	error_fingerprints_minutely: unkeyed("Minute"),
	error_fingerprint_lineage: unkeyed("Minute"),
	identity_links: { strategy: "excluded", reason: SESSION_DATA },
	logs: raw("Timestamp"),
	logs_aggregates_hourly: derived("Hour", { namespace: SERVICE_NAMESPACE }),
	metric_catalog: derived("Hour", { env: null }),
	metrics_exponential_histogram: raw("TimeUnix"),
	metrics_gauge: raw("TimeUnix"),
	metrics_histogram: raw("TimeUnix"),
	metrics_sum: raw("TimeUnix"),
	product_events: derived("Timestamp", { env: null }),
	scanner_requests: derived("Timestamp", { env: null }),
	service_address_resolutions_hourly: edges("ResolvedTargetService"),
	service_external_edges_hourly: derived("Hour"),
	service_map_children: derived("Timestamp"),
	service_map_db_edges_hourly: derived("Hour"),
	service_map_db_edges_minutely: derived("Minute"),
	service_map_db_query_shapes_hourly: derived("Hour"),
	service_map_edges_hourly: edges("TargetService"),
	service_map_edges_hourly_ingest: {
		strategy: "excluded",
		reason: "Null engine: stores no rows; its view writes service_map_edges_hourly",
	},
	service_map_spans: derived("Timestamp"),
	service_endpoint_details_hourly: derived("Hour"),
	service_operations_hourly: derived("Hour"),
	service_operations_minutely: derived("Minute"),
	service_overview_hourly: derived("Hour", { namespace: SERVICE_NAMESPACE }),
	service_overview_minutely: derived("Minute", { namespace: SERVICE_NAMESPACE }),
	service_overview_spans: derived("Timestamp", { namespace: SERVICE_NAMESPACE }),
	service_platforms_hourly: derived("Hour"),
	service_runtimes_hourly: derived("Hour"),
	service_usage: derived("Hour", { env: null }),
	session_events: { strategy: "excluded", reason: SESSION_DATA },
	source_usage_hourly: unkeyed("Hour"),
	session_replay_events: { strategy: "excluded", reason: SESSION_DATA },
	session_replays: { strategy: "excluded", reason: SESSION_DATA },
	span_metrics_calls_hourly: derived("Hour", { env: null }),
	trace_facets_hourly: derived("Hour", { namespace: SERVICE_NAMESPACE }),
	trace_index: derived("Bucket", { env: null }),
	trace_list_mv: derived("Timestamp", { namespace: SERVICE_NAMESPACE }),
	traces: raw("Timestamp"),
	traces_aggregates_hourly: derived("Hour"),
} satisfies TableDeletePlans

const lookup =
	(plans: TableDeletePlans) =>
	(table: string): TableDeletePlan | undefined =>
		plans[table]
/** The plan for any table name, or undefined when the schema has no such table. */
export const tablePlan = lookup(TABLE_DELETE_PLAN)

/** The service map rollup recomputes its two tables from raw spans only. */
const ROLLUP_SOURCE = "traces"

type ScopedPlan = Extract<TableDeletePlan, { strategy: "scoped" }>

const declares = (entry: ScopedPlan, dimension: Dimension): boolean => entry[dimension] !== null

// ---------------------------------------------------------------------------
// Request and SQL.
// ---------------------------------------------------------------------------

export const ScopedDeleteRequest = Schema.Struct({
	service: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(512))),
	namespace: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(512))),
	env: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(512))),
	/** Exclusive cutoff, epoch ms; the server floors it to the UTC hour. */
	beforeMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
})
export type ScopedDeleteRequest = typeof ScopedDeleteRequest.Type

/** A delete must name a service or a namespace; env and time only narrow it. */
export const hasSubject = (request: ScopedDeleteRequest): boolean =>
	request.service !== undefined || request.namespace !== undefined

const requestedDimensions = (request: ScopedDeleteRequest): ReadonlyArray<Dimension> =>
	Arr.filter(DIMENSIONS, (dimension) => request[dimension] !== undefined)

/** Bucketed rollups cannot split an hour, so every table uses the same hour cutoff. */
export const floorToHour = (ms: number): number => Math.floor(ms / HOUR_MS) * HOUR_MS

const sqlString = (value: string): string => `'${Str.replace(/[\\']/g, "\\$&")(value)}'`

const sourceExpression = (source: DimensionSource, dimension: Dimension): string => {
	if ("column" in source) return source.column
	const map = source.resourceAttributes
	return dimension === "namespace"
		? `${map}['service.namespace']`
		: `coalesce(nullIf(${map}['deployment.environment.name'], ''), ${map}['deployment.environment'])`
}

/** `dimension = value` on this table; the caller has checked the table declares it. */
const dimensionPredicate = (entry: ScopedPlan, dimension: Dimension, value: string): string => {
	if (dimension === "service")
		return `(${Arr.join(
			Arr.map(entry.service ?? [], (column) => `${column} = ${sqlString(value)}`),
			" OR ",
		)})`
	const source = entry[dimension]
	return source === null ? "0" : `${sourceExpression(source, dimension)} = ${sqlString(value)}`
}

const scopePredicates = (entry: ScopedPlan, request: ScopedDeleteRequest, dims: ReadonlyArray<Dimension>) =>
	Arr.map(dims, (dimension) => dimensionPredicate(entry, dimension, request[dimension] ?? ""))

const hourOf = (column: string) => `toUnixTimestamp(toStartOfHour(toDateTime(${column})))`

/** The rows a request names, or null when the table lacks a requested dimension. */
const filterPredicate = (entry: ScopedPlan, request: ScopedDeleteRequest): string | null => {
	const dims = requestedDimensions(request)
	if (!Arr.every(dims, (dimension) => declares(entry, dimension))) return null
	const parts = scopePredicates(entry, request, dims)
	if (request.beforeMs !== undefined)
		parts.push(`${entry.time} < toDateTime(${Math.floor(request.beforeMs / 1000)})`)
	return Arr.join(parts, " AND ")
}

const hourList = (hours: ReadonlyArray<number>) =>
	Arr.join(
		Arr.map(hours, (hour) => `${hour}`),
		", ",
	)

// ---------------------------------------------------------------------------
// Schema graph and plan resolution.
// ---------------------------------------------------------------------------

interface ViewEdge {
	readonly name: string
	readonly target: string
	readonly sources: ReadonlyArray<string>
	readonly body: string
}

const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/g

const materializedViews = (manifest: LocalSchemaManifest): ReadonlyArray<ViewEdge> => {
	const tables = new Set(
		Arr.map(
			Arr.filter(manifest.objects, (o) => o.kind === "table"),
			(o) => o.name,
		),
	)
	return Arr.map(
		Arr.filter(manifest.objects, (o) => o.kind === "materialized_view"),
		(o) => {
			const body = viewBody(o.definition) ?? ""
			const sources = Arr.filter(
				Arr.map(
					Arr.fromIterable(Str.matchAll(/\bFROM\s+([A-Za-z_][A-Za-z0-9_]*)/gi)(body)),
					(match) => match[1],
				),
				(name) => tables.has(name),
			)
			return {
				name: o.name,
				target:
					Option.getOrUndefined(Str.match(/\bTO\s+([A-Za-z_][A-Za-z0-9_]*)/i)(o.definition))?.[1] ??
					"",
				sources: [...new Set(sources)],
				body,
			}
		},
	)
}

const fromPattern = (source: string) => new RegExp(`\\bFROM\\s+${source}\\b`, "gi")
const sourceReferences = (body: string, source: string): number =>
	Arr.fromIterable(Str.matchAll(fromPattern(source))(body)).length

interface Rebuild {
	readonly table: string
	readonly time: string
	readonly method: "views" | "service-map-rollup"
	/** Requested dimensions this table keys on; its clear and re-insert are limited to them. */
	readonly scope: ReadonlyArray<Dimension>
	readonly views: ReadonlyArray<ViewEdge & { readonly source: string }>
}

interface ResolvedPlan {
	readonly filters: ReadonlyArray<{ readonly table: string; readonly predicate: string }>
	/** Topological: a rebuild never precedes the rebuild of a table it reads. */
	readonly rebuilds: ReadonlyArray<Rebuild>
	readonly excluded: ReadonlyArray<{ readonly table: string; readonly reason: string }>
	/** Tables that can neither filter nor recompute this request. */
	readonly unsupported: ReadonlyArray<string>
}

const resolvePlan = (
	manifest: LocalSchemaManifest,
	request: ScopedDeleteRequest,
	plans: TableDeletePlans = TABLE_DELETE_PLAN,
): ResolvedPlan => {
	const views = materializedViews(manifest)
	const requested = requestedDimensions(request)
	const filters: Array<ResolvedPlan["filters"][number]> = []
	const pending: Rebuild[] = []
	const excluded: Array<ResolvedPlan["excluded"][number]> = []
	const unsupported: string[] = []
	for (const [table, entry] of Rec.toEntries(plans)) {
		if (entry.strategy === "excluded") {
			excluded.push({ table, reason: entry.reason })
			continue
		}
		const predicate = filterPredicate(entry, request)
		if (predicate !== null) {
			filters.push({ table, predicate })
			continue
		}
		if (entry.recompute === null) {
			unsupported.push(table)
			continue
		}
		pending.push({
			table,
			time: entry.time,
			method: entry.recompute,
			// The rollup recomputes whole hours, so its clear is never narrowed.
			scope:
				entry.recompute === "views"
					? Arr.filter(requested, (dimension) => declares(entry, dimension))
					: [],
			views: Arr.flatMap(
				Arr.filter(views, (view) => view.target === table),
				(view: ViewEdge) => {
					const source = view.sources[0]
					return source !== undefined &&
						plans[source] !== undefined &&
						plans[source].strategy !== "excluded"
						? [{ ...view, source }]
						: []
				},
			),
		})
	}
	const rebuilds: Rebuild[] = []
	while (pending.length > 0) {
		const ready = Arr.findFirstIndex(
			pending,
			(rebuild) =>
				!Arr.some(rebuild.views, (view) =>
					Arr.some(pending, (other) => other !== rebuild && other.table === view.source),
				),
		)
		rebuilds.push(
			...pending.splice(
				Option.getOrElse(ready, () => 0),
				1,
			),
		)
	}
	return { filters, rebuilds, excluded, unsupported }
}

/** Every flag combination the CLI can send, for validation. */
const DELETE_SCOPES: ReadonlyArray<ScopedDeleteRequest> = [
	{ service: "s" },
	{ service: "s", env: "e" },
	{ namespace: "n" },
	{ namespace: "n", env: "e" },
	{ service: "s", namespace: "n" },
	{ service: "s", namespace: "n", env: "e" },
]

const scopeFlags = (request: ScopedDeleteRequest) =>
	Arr.join(
		Arr.map(requestedDimensions(request), (dimension) => `--${dimension}`),
		" ",
	)

/**
 * Everything that must hold for the plan to delete exactly the requested rows
 * from the given schema, for every flag combination. Empty means sound.
 */
export const validateDeletePlan = (
	manifest: LocalSchemaManifest,
	plans: TableDeletePlans = TABLE_DELETE_PLAN,
): ReadonlyArray<string> => {
	const problems: string[] = []
	const tables = new Map(
		Arr.map(
			Arr.filter(manifest.objects, (o) => o.kind === "table"),
			(o) => [o.name, o],
		),
	)
	const views = materializedViews(manifest)
	for (const name of tables.keys())
		if (plans[name] === undefined) problems.push(`${name}: no delete plan for this table`)
	for (const name of Rec.keys(plans))
		if (!tables.has(name)) problems.push(`${name}: planned but not in the schema`)

	for (const [name, entry] of Rec.toEntries(plans)) {
		const table = tables.get(name)
		if (table !== undefined && entry.strategy === "scoped")
			problems.push(...columnProblems(name, table, entry))
	}

	for (const request of DELETE_SCOPES) {
		const label = scopeFlags(request)
		const plan = resolvePlan(manifest, request, plans)
		for (const table of plan.unsupported)
			problems.push(`${table}: cannot delete ${label} and has no recompute`)
		const rebuilt = new Map(Arr.map(plan.rebuilds, (rebuild) => [rebuild.table, rebuild]))
		for (const rebuild of plan.rebuilds) {
			if (rebuild.method === "service-map-rollup") continue
			if (rebuild.views.length === 0)
				problems.push(`${rebuild.table}: recomputed for ${label} but no view writes it`)
			const target = plans[rebuild.table]
			if (
				rebuild.scope.includes("service") &&
				target?.strategy === "scoped" &&
				(target.service === null ? undefined : Arr.join(target.service, ",")) !== "ServiceName"
			)
				problems.push(`${rebuild.table}: a service-scoped recompute must key on ServiceName alone`)
			for (const view of rebuild.views) {
				if (view.sources.length !== 1)
					problems.push(`${view.name}: recomputing needs exactly one source table`)
				if (sourceReferences(view.body, view.source) !== 1)
					problems.push(`${view.name}: recomputing needs exactly one FROM ${view.source}`)
				const source = plans[view.source]
				for (const dimension of rebuild.scope)
					if (source?.strategy !== "scoped" || !declares(source, dimension))
						problems.push(
							`${view.name}: source ${view.source} cannot scope ${dimension} for ${label}`,
						)
			}
			// Re-inserting fires the views this table feeds; their own recompute must wipe that.
			for (const view of Arr.filter(views, (candidate) => candidate.sources.includes(rebuild.table))) {
				const downstream = rebuilt.get(view.target)
				if (downstream === undefined)
					problems.push(
						`${view.name}: recomputing ${rebuild.table} for ${label} leaks into ${view.target}`,
					)
				else if (!Arr.every(downstream.scope, (dimension) => rebuild.scope.includes(dimension)))
					problems.push(
						`${view.target}: recompute scope for ${label} is wider than ${rebuild.table}'s`,
					)
			}
		}
	}

	// Rows derived from deletable telemetry must never land in an excluded table.
	for (const view of views) {
		if (plans[view.target]?.strategy !== "excluded") continue
		for (const source of view.sources)
			if (plans[source] !== undefined && plans[source].strategy !== "excluded")
				problems.push(`${view.name}: writes excluded ${view.target} from ${source}`)
	}
	return [...new Set(problems)]
}

const columnProblems = (name: string, table: LocalSchemaObject, entry: ScopedPlan): ReadonlyArray<string> => {
	const problems: string[] = []
	const columns = new Set(Arr.map(table.columns, (c) => c.name))
	const keyColumns = new Set(
		table.orderBy === undefined
			? []
			: Option.getOrElse(Str.match(IDENTIFIER)(table.orderBy), (): ReadonlyArray<string> => []),
	)
	// Only a plain MergeTree row is one event; any other engine merges rows by key.
	const merges = table.engine !== "MergeTree"
	const needColumn = (column: string, role: string) => {
		if (!columns.has(column)) problems.push(`${name}: ${role} column ${column} does not exist`)
		else if (merges && !keyColumns.has(column))
			problems.push(`${name}: ${role} column ${column} is not in the sorting key of ${table.engine}`)
	}
	needColumn(entry.time, "time")
	for (const column of entry.service ?? []) needColumn(column, "service")
	for (const dimension of ["namespace", "env"] as const) {
		const source = entry[dimension]
		if (source === null) continue
		if ("column" in source) needColumn(source.column, dimension)
		else if (merges) problems.push(`${name}: a merging engine cannot filter ${dimension} from a map`)
		else if (!columns.has(source.resourceAttributes))
			problems.push(`${name}: ${dimension} map ${source.resourceAttributes} does not exist`)
	}
	return problems
}

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
		Arr.map(
			decodeHours(
				db.query(
					`SELECT DISTINCT toString(${hourOf(time)}) AS hour FROM ${table} WHERE ${predicate}`,
				),
			),
			(row) => Number(row.hour),
		),
	)

const scopedPlan = (table: string): Effect.Effect<ScopedPlan, ScopedDeleteError> => {
	const entry = tablePlan(table)
	return entry?.strategy === "scoped"
		? Effect.succeed(entry)
		: Effect.fail(new ScopedDeleteError({ message: `${table} has no scoped delete plan` }))
}

/** Hours a rebuild must recompute: where its sources lose rows, or are themselves recomputed. */
const affectedHours = (
	db: Db,
	plan: ResolvedPlan,
	rebuild: Rebuild,
	request: ScopedDeleteRequest,
	upstream: ReadonlyMap<string, ReadonlyArray<number>>,
) =>
	Effect.gen(function* () {
		const sources =
			rebuild.method === "service-map-rollup"
				? [ROLLUP_SOURCE]
				: Arr.map(rebuild.views, (view) => view.source)
		const hours = new Set<number>()
		for (const source of new Set(sources)) {
			const filter = Arr.findFirst(plan.filters, (candidate) => candidate.table === source)
			const found = Option.isNone(filter)
				? (upstream.get(source) ?? [])
				: yield* distinctHours(db, source, (yield* scopedPlan(source)).time, filter.value.predicate)
			for (const hour of found) hours.add(hour)
		}
		if (rebuild.method === "service-map-rollup" && hours.size > 0) {
			// Only sealed hours: an open hour is still the rollup loop's to seal.
			const sealedHours = yield* distinctHours(
				db,
				"service_map_edges_hourly",
				"Hour",
				`${hourOf("Hour")} IN (${hourList([...hours])})`,
			)
			const sealed = new Set(sealedHours)
			for (const hour of hours) if (!sealed.has(hour)) hours.delete(hour)
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
	const sources =
		rebuild.method === "service-map-rollup"
			? [ROLLUP_SOURCE]
			: Arr.map(rebuild.views, (view) => view.source)
	const ttls = Arr.map(sources, (source) =>
		ttlDaysFromDefinition(
			Option.match(
				Arr.findFirst(manifest.objects, (o) => o.name === source),
				{ onNone: () => "", onSome: (o) => o.definition },
			),
		),
	)
	const kept: number[] = []
	const skipped: number[] = []
	for (const hour of hours) {
		const covered = Arr.every(
			ttls,
			(days) => days === null || hour * 1000 + days * DAY_MS > nowMs + DAY_MS,
		)
		;(covered ? kept : skipped).push(hour)
	}
	return { kept, skipped }
}

const rebuildTargetPredicate = (
	entry: ScopedPlan,
	rebuild: Rebuild,
	request: ScopedDeleteRequest,
	hours: ReadonlyArray<number>,
) =>
	Arr.join(
		[
			...scopePredicates(entry, request, rebuild.scope),
			`${hourOf(rebuild.time)} IN (${hourList(hours)})`,
		],
		" AND ",
	)

const clearHours = (db: Db, rebuild: Rebuild, request: ScopedDeleteRequest, hours: ReadonlyArray<number>) =>
	Effect.gen(function* () {
		const entry = yield* scopedPlan(rebuild.table)
		yield* run(`clear ${rebuild.table}`, () =>
			db.exec(
				`ALTER TABLE ${rebuild.table} DELETE WHERE ${rebuildTargetPredicate(entry, rebuild, request, hours)} SETTINGS mutations_sync = 2`,
			),
		)
	})

const recomputeViaViews = (
	db: Db,
	manifest: LocalSchemaManifest,
	rebuild: Rebuild,
	request: ScopedDeleteRequest,
	hours: ReadonlyArray<number>,
) =>
	Effect.gen(function* () {
		if (hours.length === 0) return
		yield* clearHours(db, rebuild, request, hours)
		// One UTC day per INSERT keeps each recompute's GROUP BY bounded.
		const days = new Map<number, number[]>()
		for (const hour of hours) {
			const day = Math.floor(hour / 86_400)
			days.set(day, [...(days.get(day) ?? []), hour])
		}
		for (const view of rebuild.views) {
			const sourceObject = Arr.findFirst(manifest.objects, (o) => o.name === view.source)
			const source = yield* scopedPlan(view.source)
			if (Option.isNone(sourceObject))
				return yield* new ScopedDeleteError({
					message: `${view.name}: unknown source ${view.source}`,
				})
			const sourceColumns = Arr.join(
				Arr.map(sourceObject.value.columns, (c) => c.name),
				", ",
			)
			// The view's own output columns, so the INSERT matches by name, not position.
			const columns = yield* run(`columns of ${view.name}`, () =>
				Arr.map(
					decodeNames(
						db.query(
							`SELECT name FROM system.columns WHERE database = currentDatabase() AND table = ${sqlString(view.name)} ORDER BY position`,
						),
					),
					(row) => row.name,
				),
			)
			if (columns.length === 0)
				return yield* new ScopedDeleteError({ message: `${view.name}: no columns in system.columns` })
			for (const dayHours of days.values()) {
				const scope = Arr.join(
					[
						...scopePredicates(source, request, rebuild.scope),
						`${hourOf(source.time)} IN (${hourList(dayHours)})`,
					],
					" AND ",
				)
				const body = Str.replace(
					fromPattern(view.source),
					`FROM (SELECT ${sourceColumns} FROM ${view.source} WHERE ${scope}) AS ${view.source}`,
				)(view.body)
				const list = Arr.join(columns, ", ")
				yield* run(`recompute ${rebuild.table} via ${view.name}`, () =>
					db.exec(`INSERT INTO ${rebuild.table} (${list}) SELECT ${list} FROM (${body})`),
				)
			}
		}
	})

/** Clear whole hours of the rollup's tables, then seal each hour again from surviving spans. */
const recomputeServiceMap = (
	db: Db,
	rebuilds: ReadonlyArray<Rebuild>,
	request: ScopedDeleteRequest,
	hoursByTable: Readonly<Record<string, ReadonlyArray<number>>>,
) =>
	Effect.gen(function* () {
		const hours = [
			...new Set(Arr.flatMap(rebuilds, (rebuild) => hoursByTable[rebuild.table] ?? [])),
		].sort((a, b) => a - b)
		if (hours.length === 0) return
		for (const rebuild of rebuilds) yield* clearHours(db, rebuild, request, hours)
		for (const hour of hours) {
			const statements = yield* serviceMapRollupInserts(hour * 1000).pipe(
				Effect.mapError(
					(cause) =>
						new ScopedDeleteError({ message: `service map rollup: ${cause.message}`, cause }),
				),
			)
			for (const statement of statements) yield* run("recompute service map", () => db.exec(statement))
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
					return yield* new ScopedDeleteError({
						message: `${left} matching row(s) remain in ${table}`,
					})
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
		const pending = yield* Schema.decodeEffect(Schema.fromJsonString(PendingDelete))(text).pipe(
			Effect.mapError(
				(cause) =>
					new ScopedDeleteError({ message: `malformed pending delete journal ${path}`, cause }),
			),
		)
		return Option.some(pending)
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
				new ScopedDeleteError({
					message: `scoped delete plan does not match the schema: ${Arr.join(problems, "; ")}`,
				}),
			)
}

const assertSubject = (request: ScopedDeleteRequest) =>
	hasSubject(request)
		? Effect.void
		: Effect.fail(new ScopedDeleteError({ message: "a scoped delete needs a service or a namespace" }))

/** Hours per rebuild, in plan order so recomputed sources feed their dependants. */
const planHours = (
	db: Db,
	manifest: LocalSchemaManifest,
	plan: ResolvedPlan,
	request: ScopedDeleteRequest,
	nowMs: number,
) =>
	Effect.gen(function* () {
		const all = new Map<string, ReadonlyArray<number>>()
		const kept: Record<string, number[]> = {}
		const skipped: Record<string, number> = {}
		for (const rebuild of plan.rebuilds) {
			const hours = yield* affectedHours(db, plan, rebuild, request, all)
			all.set(rebuild.table, hours)
			const split = recomputable(manifest, rebuild, hours, nowMs)
			kept[rebuild.table] = split.kept
			skipped[rebuild.table] = split.skipped.length
		}
		return { kept, skipped }
	})

/** Apply a journaled request: filters are idempotent, rebuilds take their hours from the journal. */
const applyPending = (db: Db, manifest: LocalSchemaManifest, dataDir: string, pending: PendingDelete) =>
	Effect.gen(function* () {
		const plan = resolvePlan(manifest, pending.request)
		yield* applyFilters(db, plan.filters)
		// Views in dependency order, so each recompute wipes what its source's re-insert cascaded.
		for (const rebuild of plan.rebuilds)
			if (rebuild.method === "views")
				yield* recomputeViaViews(
					db,
					manifest,
					rebuild,
					pending.request,
					pending.rebuildHours[rebuild.table] ?? [],
				)
		yield* recomputeServiceMap(
			db,
			Arr.filter(plan.rebuilds, (rebuild) => rebuild.method === "service-map-rollup"),
			pending.request,
			pending.rebuildHours,
		)
		yield* writeFile("remove pending delete journal", () => durableRemove(pendingDeletePath(dataDir)))
	})

/** Finish a delete an earlier failure or crash left journaled. Run before serving. */
export const resumePendingDelete = (db: Db, manifest: LocalSchemaManifest, dataDir: string) =>
	Effect.gen(function* () {
		const pending = yield* readPending(dataDir)
		if (Option.isNone(pending)) return Option.none<ScopedDeleteRequest>()
		yield* assertPlanSound(manifest)
		yield* assertSubject(pending.value.request)
		// A restored checkpoint can bring the rows back; recompute their hours too.
		const nowMs = yield* Clock.currentTimeMillis
		const current = yield* planHours(
			db,
			manifest,
			resolvePlan(manifest, pending.value.request),
			pending.value.request,
			nowMs,
		)
		const rebuildHours: Record<string, number[]> = {}
		for (const table of new Set([...Rec.keys(pending.value.rebuildHours), ...Rec.keys(current.kept)]))
			rebuildHours[table] = [
				...new Set([...(pending.value.rebuildHours[table] ?? []), ...(current.kept[table] ?? [])]),
			].sort((a, b) => a - b)
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
		yield* assertSubject(input)
		const nowMs = options.nowMs ?? (yield* Clock.currentTimeMillis)
		const request: ScopedDeleteRequest =
			input.beforeMs === undefined ? input : { ...input, beforeMs: floorToHour(input.beforeMs) }
		if (!options.dryRun) yield* resumePendingDelete(db, manifest, dataDir)

		const plan = resolvePlan(manifest, request)
		if (plan.unsupported.length > 0)
			return yield* new ScopedDeleteError({
				message: `cannot delete from ${Arr.join(plan.unsupported, ", ")} for this request`,
			})
		const tables: ScopedDeleteTableReport[] = []
		for (const { table, predicate } of plan.filters)
			tables.push({ table, strategy: "filter", rows: yield* countRows(db, table, predicate) })
		const hours = yield* planHours(db, manifest, plan, request, nowMs)
		for (const rebuild of plan.rebuilds) {
			const kept = hours.kept[rebuild.table] ?? []
			const entry = yield* scopedPlan(rebuild.table)
			tables.push({
				table: rebuild.table,
				strategy: "rebuild",
				rows:
					kept.length === 0
						? 0
						: yield* countRows(
								db,
								rebuild.table,
								rebuildTargetPredicate(entry, rebuild, request, kept),
							),
				rebuiltHours: kept.length,
				skippedHours: hours.skipped[rebuild.table] ?? 0,
			})
		}
		for (const { table, reason } of plan.excluded)
			tables.push({ table, strategy: "excluded", rows: 0, reason })
		tables.sort((a, b) => Str.localeCompare(b.table)(a.table))
		const report: ScopedDeleteReport = {
			request,
			dryRun: options.dryRun,
			deletedRows: Arr.reduce(tables, 0, (sum, t) => sum + (t.strategy === "filter" ? t.rows : 0)),
			tables,
		}
		if (options.dryRun) return report

		const pending: PendingDelete = { formatVersion: 1, request, rebuildHours: hours.kept }
		yield* writeFile("write pending delete journal", () =>
			durableJson(pendingDeletePath(dataDir), pending),
		)
		yield* applyPending(db, manifest, dataDir, pending)
		return report
	})

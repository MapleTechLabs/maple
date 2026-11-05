import { Option, String as Str, Array as Arr } from "effect"
import { describe, expect, it } from "vitest"
import { type BackfillSpec, isBackfill, renderStatementFull } from "../backfill"
import { migration_0004_service_namespace_projections } from "./0004_service_namespace_projections"
import {
	migration_0008_service_operations_minutely,
	serviceOperationsMinutelyBackfill,
} from "./0008_service_operations_minutely"
import { migration_0009_one_year_service_history } from "./0009_one_year_service_history"
import { migration_0011_session_analytics_columns } from "./0011_session_analytics_columns"
import { migration_0014_web_events, webEventsBackfill } from "./0014_web_events"
import { migration_0015_service_overview_minutely } from "./0015_service_overview_minutely"
import { migration_0017_error_service_version_columns } from "./0017_error_service_version_columns"
import { migration_0026_ai_trace_index_filter_columns } from "./0026_ai_trace_index_filter_columns"
import { migration_0030_error_events_attribute_fallback } from "./0030_error_events_attribute_fallback"
import { migration_0034_trace_facets_hourly, traceFacetsHourlyBackfill } from "./0034_trace_facets_hourly"
import { migration_0037_service_overview_spans_span_kind } from "./0037_service_overview_spans_span_kind"
import { migration_0038_external_edges_legacy_db_system } from "./0038_external_edges_legacy_db_system"
import { migration_0045_ttl_only_drop_parts } from "./0045_ttl_only_drop_parts"
import { latestSnapshotStatements } from "../../generated/clickhouse-schema"
import { migrations } from "./index"

const indexWhere = <A>(xs: ReadonlyArray<A>, predicate: (a: A) => boolean): number =>
	Option.getOrElse(Arr.findFirstIndex(xs, predicate), () => -1)
const firstGroup =
	(regex: RegExp) =>
	(text: string): string | undefined =>
		Option.getOrUndefined(
			Option.flatMap(Str.match(regex)(text), (match) => Option.fromNullishOr(match[1])),
		)

// Full rendered SQL (structural strings + backfills rendered to their full
// INSERT…SELECT, qualified into `default`) — what the non-chunking path runs.
const renderedSql = Arr.join(
	Arr.map(migration_0004_service_namespace_projections.statements, (s) =>
		renderStatementFull(s, "default"),
	),
	"\n\n",
)

describe("ClickHouse migrations", () => {
	it("recreates both error-events MVs with the span-attribute exception fallback", () => {
		const statements: ReadonlyArray<string> = Arr.filter(
			migration_0030_error_events_attribute_fallback.statements,
			(stmt) => !isBackfill(stmt),
		)
		const sql = Arr.join(statements, "\n")

		// An MV's SELECT is frozen at creation, so both views are dropped before
		// they are recreated; error_events_by_time_mv shares the projection
		// byte-for-byte and must never disagree with error_events_mv on a label.
		for (const view of ["error_events_mv", "error_events_by_time_mv"]) {
			const dropAt = indexWhere(statements, (stmt) => stmt === `DROP VIEW IF EXISTS ${view}`)
			const createAt = indexWhere(statements, (stmt) =>
				Str.startsWith(`CREATE MATERIALIZED VIEW IF NOT EXISTS ${view} `)(stmt),
			)
			expect(dropAt).toBeGreaterThanOrEqual(0)
			expect(createAt).toBeGreaterThan(dropAt)
		}

		// Nothing is rewritten: error_events keeps no span attributes to re-derive
		// from, and recomputing FingerprintHash would re-bucket every issue.
		expect(sql).not.toContain("ALTER TABLE error_events")
		expect(Arr.some(migration_0030_error_events_attribute_fallback.statements, isBackfill)).toBe(false)
	})

	it("adds the ServiceVersion columns before recreating the MVs that write them", () => {
		const statements: ReadonlyArray<string> = Arr.filter(
			migration_0017_error_service_version_columns.statements,
			(stmt) => !isBackfill(stmt),
		)
		const sql = Arr.join(statements, "\n")

		// The drifted columns: present in the 0001 snapshot, never ALTERed onto a
		// server provisioned before they were added to the datasource definitions.
		expect(sql).toContain(
			"ALTER TABLE error_events ADD COLUMN IF NOT EXISTS ServiceVersion LowCardinality(String)",
		)
		expect(sql).toContain(
			"ALTER TABLE error_events_by_time ADD COLUMN IF NOT EXISTS ServiceVersion LowCardinality(String)",
		)
		expect(sql).toContain(
			"ALTER TABLE error_fingerprints_minutely ADD COLUMN IF NOT EXISTS ServiceVersions SimpleAggregateFunction(groupUniqArrayArray, Array(String))",
		)

		// An MV's SELECT is frozen at creation, so each view is dropped and
		// recreated from the current snapshot body.
		for (const view of ["error_events_mv", "error_events_by_time_mv", "error_fingerprints_minutely_mv"]) {
			const dropAt = indexWhere(statements, (stmt) => stmt === `DROP VIEW IF EXISTS ${view}`)
			const createAt = indexWhere(statements, (stmt) =>
				Str.startsWith(`CREATE MATERIALIZED VIEW IF NOT EXISTS ${view} `)(stmt),
			)
			expect(dropAt).toBeGreaterThanOrEqual(0)
			expect(createAt).toBeGreaterThan(dropAt)
		}

		// Every ALTER must land before the first view that writes into it — a
		// recreated MV needs somewhere to put the new column.
		const lastAlter = Arr.reduce(statements, -1, (last, stmt, index) =>
			Str.startsWith("ALTER TABLE ")(stmt) ? index : last,
		)
		const firstDrop = indexWhere(statements, (stmt) => Str.startsWith("DROP VIEW ")(stmt))
		expect(lastAlter).toBeLessThan(firstDrop)

		// The recreated bodies must actually populate the columns, or the ALTERs
		// are cosmetic and errorIssuesScan keeps returning empty version arrays.
		// oxlint-disable-next-line test-slop/no-sql-text-pin -- MV must write the ALTERed column
		expect(sql).toContain("AS ServiceVersion")
		expect(sql).toContain("groupUniqArray(ServiceVersion) AS ServiceVersions")

		// Nothing is backfilled: ServiceVersion comes from the source span's
		// resource attributes, which these target tables do not keep.
		expect(Arr.some(migration_0017_error_service_version_columns.statements, isBackfill)).toBe(false)
	})

	it("orders 0015 so the backfill and the MV never both write", () => {
		const kinds = Arr.map(migration_0015_service_overview_minutely.statements, (stmt) =>
			isBackfill(stmt) ? "backfill" : Str.trim(Str.split("\n")(stmt)[0]!),
		)

		const dropIndex = indexWhere(kinds, (kind) => Str.startsWith("DROP VIEW")(kind))
		const truncateIndex = indexWhere(kinds, (kind) => Str.startsWith("TRUNCATE")(kind))
		const backfillIndex = kinds.indexOf("backfill")
		const createMvIndex = indexWhere(kinds, (kind) => Str.startsWith("CREATE MATERIALIZED VIEW")(kind))

		// DROP → TRUNCATE → backfill → CREATE MV. The truncate makes a re-apply
		// converge instead of doubling, and is only safe because the view is
		// detached first.
		expect(dropIndex).toBeGreaterThanOrEqual(0)
		expect(dropIndex).toBeLessThan(truncateIndex)
		expect(truncateIndex).toBeLessThan(backfillIndex)
		expect(backfillIndex).toBeLessThan(createMvIndex)
	})

	it("orders the web_events backfill so it can never overlap the materialized view", () => {
		// The whole double-count hazard is an ordering property, and nothing else
		// checks it. web_events has no dedup, so a backfill running while the view
		// is attached counts every page view in the overlap twice.
		const kinds = Arr.map(migration_0014_web_events.statements, (stmt) =>
			isBackfill(stmt)
				? "backfill"
				: Str.includes("CREATE MATERIALIZED VIEW")(String(stmt))
					? "create-view"
					: Str.includes("DROP VIEW")(String(stmt))
						? "drop-view"
						: Str.includes("TRUNCATE")(String(stmt))
							? "truncate"
							: "create-table",
		)
		expect(kinds).toEqual(["drop-view", "create-table", "truncate", "backfill", "create-view"])

		// Restated as the invariant rather than the sequence, so a future insertion
		// between them still has to preserve it.
		expect(kinds.indexOf("backfill")).toBeLessThan(kinds.indexOf("create-view"))
		expect(kinds.indexOf("drop-view")).toBeLessThan(kinds.indexOf("truncate"))
		expect(kinds.indexOf("truncate")).toBeLessThan(kinds.indexOf("backfill"))
	})

	it("keeps the web_events backfill projection identical to its materialized view", () => {
		// Two divergent copies of this SELECT would show up as a page-view count
		// that steps at the backfill boundary — on a table with no dedup, nothing
		// else would catch it.
		const mvBody = Option.getOrUndefined(
			Arr.findFirst(
				Arr.filter(migration_0014_web_events.statements, (s) => typeof s === "string"),
				(s) => Str.includes("CREATE MATERIALIZED VIEW")(s),
			),
		)
		expect(mvBody).toContain(webEventsBackfill.select)
		expect(webEventsBackfill.where).toBe("Type IN ('navigation', 'custom')")
		expect(webEventsBackfill.from).toBe("session_events")
		expect(webEventsBackfill.tsColumn).toBe("Timestamp")
		// Row-wise: no GROUP BY means no group can straddle a chunk boundary.
		expect(webEventsBackfill.groupBy).toBeUndefined()
	})

	it("keeps the service_operations_minutely backfill aligned with its table and live MV", () => {
		// The rollout runs this backfill by hand; a drifted SELECT or column list steps the series.
		const statements = Arr.map(migration_0008_service_operations_minutely.statements, String)
		const table = Option.getOrElse(
			Arr.findFirst(statements, (s) => Str.includes("CREATE TABLE")(s)),
			() => "",
		)
		const tableColumns = Arr.map(
			Arr.fromIterable(Str.matchAll(/^\s+(\w+) [A-Z]/gm)(table)),
			(match) => match[1],
		)
		expect(serviceOperationsMinutelyBackfill.columns).toEqual(tableColumns)
		const mvBody = Option.getOrUndefined(
			Arr.findFirst(statements, (s) => Str.includes("CREATE MATERIALIZED VIEW")(s)),
		)
		expect(mvBody).toContain(serviceOperationsMinutelyBackfill.select)
	})

	it("adds session analytics columns with defaults so older SDK rows never quarantine", () => {
		const sql = Arr.join(migration_0011_session_analytics_columns.statements, "\n")

		expect(sql).toContain("ADD COLUMN IF NOT EXISTS VisitorId String DEFAULT ''")
		expect(sql).toContain("ADD COLUMN IF NOT EXISTS GroupId String DEFAULT ''")
		expect(sql).toContain("ADD COLUMN IF NOT EXISTS UserTraits Map(String, String) DEFAULT map()")
		expect(sql).toContain("ADD COLUMN IF NOT EXISTS ReferrerHost LowCardinality(String) DEFAULT ''")
		expect(sql).toContain("ADD INDEX IF NOT EXISTS idx_type Type TYPE set(16)")

		// Every session_replays column add must carry a DEFAULT — Tinybird
		// quarantines rows omitting a non-defaulted column, which is exactly what
		// an older SDK sends. Nullable columns default to NULL implicitly.
		const columnAdds = Arr.filter(migration_0011_session_analytics_columns.statements, (s) =>
			Str.includes("ADD COLUMN")(s),
		)
		for (const statement of columnAdds) {
			expect(Str.includes("DEFAULT")(statement) || Str.includes("Nullable(")(statement)).toBe(true)
		}

		// Gates direct ingest: the native INSERT names every column explicitly, so
		// a BYO cluster without them must not be routed direct writes. Read off the
		// typed array — the migration literal itself simply omits the field.
		expect(
			Option.getOrUndefined(Arr.findFirst(migrations, (m) => m.version === 11))?.requiredForIngest,
		).toBeUndefined()
	})

	it("orders 0009 so a re-apply converges instead of doubling the annual rollups", () => {
		// The targets are additive AggregatingMergeTrees retained a year: replaying
		// the backfills after a partial failure (chunk N fails, admin re-runs the
		// apply) would double every sum until TTL. DROP → TRUNCATE → backfill →
		// CREATE MV is the 0015 cutover shape, restated as invariants.
		const kinds = Arr.map(migration_0009_one_year_service_history.statements, (stmt) =>
			// Str.split returns a NonEmptyArray, so the head index is statically safe.
			isBackfill(stmt) ? `backfill:${stmt.target}` : Str.trim(Str.split(stmt, "\n")[0]),
		)
		const at = (needle: string) => {
			const index = indexWhere(kinds, (kind) => Str.startsWith(needle)(kind))
			expect(index, needle).toBeGreaterThanOrEqual(0)
			return index
		}

		// Both live writers are detached before either target is truncated.
		expect(at("DROP VIEW IF EXISTS service_overview_hourly_mv")).toBeLessThan(
			at("TRUNCATE TABLE IF EXISTS service_overview_hourly"),
		)
		expect(at("DROP VIEW IF EXISTS service_operations_hourly_mv")).toBeLessThan(
			at("TRUNCATE TABLE IF EXISTS service_operations_hourly"),
		)
		// Each target is emptied before its backfill, and its view reattaches after.
		expect(at("TRUNCATE TABLE IF EXISTS service_overview_hourly")).toBeLessThan(
			at("backfill:service_overview_hourly"),
		)
		expect(at("backfill:service_overview_hourly")).toBeLessThan(
			at("CREATE MATERIALIZED VIEW IF NOT EXISTS service_overview_hourly_mv"),
		)
		expect(at("TRUNCATE TABLE IF EXISTS service_operations_hourly")).toBeLessThan(
			at("backfill:service_operations_hourly"),
		)
		expect(at("backfill:service_operations_hourly")).toBeLessThan(
			at("CREATE MATERIALIZED VIEW IF NOT EXISTS service_operations_hourly_mv"),
		)
	})

	it("keeps every backfill convergent on re-apply: target emptied or rebuilt first", () => {
		// A migration is recorded only after every statement succeeds, so a failure
		// anywhere replays the WHOLE migration — including backfills that already
		// inserted. Every backfill target must therefore be emptied of the rows the
		// backfill writes earlier in the same migration: truncated, rebuilt from
		// scratch (DROP TABLE IF EXISTS <fresh> + rename swap), or scoped-deleted
		// for a dual-fed target (0021). An additive INSERT…SELECT into a surviving
		// table doubles on the rerun and nothing downstream can detect it.
		// identity_links and trace_index are exempt because a replay is a merge
		// no-op: their only aggregates are SimpleAggregateFunction(min/max) keyed by
		// the full sorting key, so re-inserted rows collapse to the values stored.
		// A backfill that skips every span its target already holds (0047) converges
		// without emptying a target that outlives its source.
		const mergeIdempotentTargets = new Set(["identity_links", "trace_index"])
		const skipsStored = (stmt: BackfillSpec) =>
			stmt.where !== undefined &&
			Str.includes(`(TraceId, SpanId) NOT IN (SELECT TraceId, SpanId FROM ${stmt.target})`)(stmt.where)
		for (const migration of migrations) {
			Arr.forEach(migration.statements, (stmt, index) => {
				if (!isBackfill(stmt) || mergeIdempotentTargets.has(stmt.target) || skipsStored(stmt)) return
				const before = Arr.filter(
					migration.statements.slice(0, index),
					(s): s is string => typeof s === "string",
				)
				const emptied = Arr.some(
					before,
					(s) =>
						Str.startsWith(`TRUNCATE TABLE IF EXISTS ${stmt.target}`)(s) ||
						Str.startsWith(`DROP TABLE IF EXISTS ${stmt.target}`)(s) ||
						Str.startsWith(`DELETE FROM ${stmt.target} `)(s),
				)
				expect(emptied, `m${migration.version} backfill:${stmt.target}`).toBe(true)
			})
		}
	})

	it("renders backfills to positional-safe INSERT … (col, …) SELECT", () => {
		// No bare positional INSERT … SELECT (would silently drift on appended cols).
		expect(renderedSql).not.toMatch(
			/INSERT INTO `default`\.`(service_overview_spans|trace_list_mv|logs_aggregates_hourly__v4)` SELECT/,
		)
		expect(renderedSql).toContain(
			"INSERT INTO `default`.`service_overview_spans` (OrgId, Timestamp, ServiceName,",
		)
	})
})

describe("migration 0026 — ai_trace_index filter columns", () => {
	const statements = migration_0026_ai_trace_index_filter_columns.statements

	it("widens the index with idempotent ALTERs before recreating its view", () => {
		const alters = Arr.filter(statements, (stmt) =>
			Str.startsWith("ALTER TABLE ai_trace_index ADD COLUMN IF NOT EXISTS")(stmt),
		)
		expect(Arr.map(alters, (stmt) => Str.split(" ")(stmt)[8])).toEqual([
			"DeploymentEnv",
			"Model",
			"AgentName",
			"ToolName",
			"SpanId",
			"ParentSpanId",
			"Duration",
			"IsError",
			"IsLlmCall",
			"IsToolCall",
			"Tokens",
			"Cost",
		])
		// The facet dimensions are LowCardinality(String): never free text.
		for (const stmt of alters.slice(0, 4)) expect(stmt).toMatch(/ LowCardinality\(String\)$/)
		// The view's SELECT is frozen at creation, so the body change needs a drop
		// — and the drop must come after the ALTERs and before the CREATE, or the
		// recreated view maps a column its target does not yet have.
		const drop = statements.indexOf("DROP VIEW IF EXISTS ai_trace_index_mv")
		const create = indexWhere(statements, (stmt) => Str.startsWith("CREATE MATERIALIZED VIEW")(stmt))
		expect(drop).toBe(alters.length)
		expect(create).toBe(drop + 1)
		expect(statements).toHaveLength(alters.length + 2)
	})
})

describe("migration 0034: trace_facets_hourly", () => {
	it("backfills with the view detached, then attaches it, in the emitter's DDL", () => {
		const [drop, table, truncate, backfill, view, ...rest] = migration_0034_trace_facets_hourly.statements
		expect(rest).toEqual([])
		expect(drop).toBe("DROP VIEW IF EXISTS trace_facets_hourly_mv")
		expect(truncate).toBe("TRUNCATE TABLE IF EXISTS trace_facets_hourly")
		expect(backfill).toBe(traceFacetsHourlyBackfill)
		// 0045 later moved its TTL onto the partition's day.
		expect(latestSnapshotStatements).toContain(
			Str.replace("TTL Hour + INTERVAL", "TTL toDate(Hour) + INTERVAL")(String(table)),
		)
		expect(latestSnapshotStatements).toContain(view)
	})
})

describe("migration 0037: service_overview_spans records why a row is an entry point", () => {
	it("adds the columns before recreating the view that fills them", () => {
		const [addKind, addRoot, drop, create, ...rest] =
			migration_0037_service_overview_spans_span_kind.statements
		expect(rest).toEqual([])
		expect(addKind).toContain("ADD COLUMN IF NOT EXISTS SpanKind")
		expect(addRoot).toContain("ADD COLUMN IF NOT EXISTS IsRoot")
		expect(drop).toBe("DROP VIEW IF EXISTS service_overview_spans_mv")
		expect(create).toBe(
			Option.getOrUndefined(
				Arr.findFirst(latestSnapshotStatements, (stmt) =>
					Str.includes("service_overview_spans_mv TO")(stmt),
				),
			),
		)
		expect(create).toContain("toUInt8(ParentSpanId = '') AS IsRoot")
	})
})

describe("migration 0038: legacy db.system spans stay off the external edges", () => {
	it("recreates the view excluding on the db.system.name -> db.system coalesce", () => {
		const [drop, create, ...rest] = migration_0038_external_edges_legacy_db_system.statements
		expect(rest).toEqual([])
		expect(drop).toBe("DROP VIEW IF EXISTS service_external_edges_hourly_mv")
		expect(create).toBe(
			Option.getOrUndefined(
				Arr.findFirst(latestSnapshotStatements, (stmt) =>
					Str.includes("service_external_edges_hourly_mv TO")(stmt),
				),
			),
		)
		expect(create).toContain(
			"AND coalesce(nullIf(SpanAttributes['db.system.name'], ''), SpanAttributes['db.system']) = ''",
		)
	})
})

describe("migration 0045: TTL eviction drops whole parts", () => {
	const tables = Arr.flatMap(latestSnapshotStatements, (stmt) => {
		const name = firstGroup(/^CREATE TABLE IF NOT EXISTS (\w+) \(/)(stmt)
		const partition = firstGroup(/\nPARTITION BY (.+)/)(stmt)
		const ttl = firstGroup(/\nTTL (.+)/)(stmt)
		return name === undefined || ttl === undefined ? [] : [{ name, partition, ttl }]
	})
	const datePartitioned = Arr.filter(
		tables,
		(table) => table.partition !== undefined && table.partition !== "tuple()",
	)
	const statements = Arr.flatMap(migrations, (migration) =>
		Arr.filter(migration.statements, (stmt): stmt is string => typeof stmt === "string"),
	)

	it("keys each date-partitioned TTL off the day of its partition column", () => {
		const misaligned = Arr.map(
			Arr.filter(datePartitioned, ({ partition, ttl }) => {
				const column =
					partition === undefined
						? undefined
						: firstGroup(/^to(?:Date|YYYYMM)\((\w+)\)$/)(partition)
				return column === undefined || !Str.startsWith(`toDate(${column}) + INTERVAL `)(ttl)
			}),
			({ name }) => name,
		)
		expect(misaligned).toEqual([])
	})

	it("sets ttl_only_drop_parts on every date-partitioned table, and only on those", () => {
		const withSetting = Arr.flatMap(statements, (stmt) =>
			Arr.fromNullishOr(firstGroup(/^ALTER TABLE (\w+) MODIFY SETTING ttl_only_drop_parts = 1$/)(stmt)),
		)
		expect([...withSetting].sort()).toEqual(Arr.map(datePartitioned, ({ name }) => name).sort())
	})

	it("sets the setting before it moves any TTL", () => {
		const kinds = Arr.map(migration_0045_ttl_only_drop_parts.statements, (stmt) =>
			Str.includes("MODIFY SETTING")(stmt) ? "setting" : "ttl",
		)
		expect(kinds.indexOf("ttl")).toBe(kinds.lastIndexOf("setting") + 1)
	})
})

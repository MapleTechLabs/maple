import { describe, expect, it } from "@effect/vitest"
import { DashboardDocument, IsoDateTimeString, OrgId } from "@maple/domain/http"
import { MAX_LIST_RANGE_SECONDS } from "@maple/query-engine"
import { Effect, Layer, ManagedRuntime, Schema, Array as Arr } from "effect"
import { QueryEngineService } from "@maple/backend/services/warehouse/QueryEngineService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { DashboardWidgetDataService, type WidgetDataRequest } from "./DashboardWidgetDataService"

const asIsoDateTimeString = Schema.decodeUnknownSync(IsoDateTimeString)
const asOrgId = Schema.decodeUnknownSync(OrgId)
const asDashboardDocument = Schema.decodeUnknownSync(DashboardDocument)

const ORG = asOrgId("org_share_widgets")
const NOW = asIsoDateTimeString(new Date("2026-01-01T00:00:00.000Z").toISOString())

const die = () => Effect.die("unexpected call")

/**
 * Records the window every executed query actually ran over, which is how the
 * clamp is asserted: the point is not that the resolver *reports* narrowing but
 * that the SQL it issued was narrowed.
 */
const makeHarness = (
	// Error channel is `unknown`, not `never`: a stub that fails is how the
	// execution-failure mapping is asserted, and pinning this to `never` forces
	// the caller into a cast at exactly the point the test is about.
	execute: (request: {
		startTime: string
		endTime: string
		query: unknown
	}) => Effect.Effect<unknown, unknown>,
) => {
	const windows: Array<{ startTime: string; endTime: string }> = []
	const queries: Array<unknown> = []
	const queryEngine = Layer.succeed(QueryEngineService, {
		execute: (_tenant: unknown, request: { startTime: string; endTime: string; query: unknown }) => {
			windows.push({ startTime: request.startTime, endTime: request.endTime })
			queries.push(request.query)
			return execute(request).pipe(Effect.map((result) => ({ result })))
		},
		evaluate: die,
		evaluateSeries: die,
		cachedDirect: die,
		// oxlint-disable-next-line typescript/no-explicit-any
	} as any)

	const rawSql: Array<string> = []
	const warehouse = Layer.succeed(WarehouseQueryService, {
		rawSqlQuery: (_tenant: unknown, sql: string) => {
			rawSql.push(sql)
			return Effect.succeed([{ value: 1 }])
		},
		// oxlint-disable-next-line typescript/no-explicit-any
	} as any)

	const runtime = ManagedRuntime.make(
		Layer.effect(DashboardWidgetDataService, DashboardWidgetDataService.make).pipe(
			Layer.provide(Layer.mergeAll(queryEngine, warehouse)),
		),
	)
	return { runtime, windows, rawSql, queries }
}

const document = (
	widgets: ReadonlyArray<Record<string, unknown>>,
	variables?: ReadonlyArray<Record<string, unknown>>,
): DashboardDocument =>
	asDashboardDocument({
		id: "dash-share",
		name: "Shared",
		timeRange: { type: "relative", value: "12h" },
		widgets,
		...(variables === undefined ? undefined : { variables }),
		createdAt: NOW,
		updatedAt: NOW,
	})

const widget = (id: string, dataSource: Record<string, unknown>) => ({
	id,
	visualization: "stat",
	dataSource,
	display: {},
	layout: { x: 0, y: 0, w: 3, h: 4 },
})

const WINDOW = { startTime: "2026-01-01 00:00:00", endTime: "2026-01-31 00:00:00" }

describe("DashboardWidgetDataService", () => {
	it("refuses a widget that is not on the document", async () => {
		const { runtime } = makeHarness(() => Effect.succeed({ kind: "list", data: [] }))

		const outcome = await runtime.runPromise(
			DashboardWidgetDataService.use((service) =>
				service.resolve(ORG, document([]), { widgetId: "nope", source: "primary" }, WINDOW, {}),
			).pipe(Effect.flip),
		)

		expect(outcome._tag).toBe("@maple/http/errors/ShareWidgetNotFoundError")
		await runtime.dispose()
	})

	it("serves a static tile as data-less success, not as an unsupported widget", async () => {
		const { runtime, windows } = makeHarness(() => Effect.succeed({ kind: "list", data: [] }))

		const outcome = await runtime.runPromise(
			DashboardWidgetDataService.use((service) =>
				service.resolve(
					ORG,
					document([widget("w-static", { kind: "static" })]),
					{ widgetId: "w-static", source: "primary" },
					WINDOW,
					{},
				),
			),
		)

		expect(outcome.data).toBeNull()
		// A markdown tile must not reach the warehouse at all.
		expect(windows).toHaveLength(0)
		await runtime.dispose()
	})

	it("refuses a route endpoint that has no server-side plan", async () => {
		const { runtime } = makeHarness(() => Effect.succeed({ kind: "list", data: [] }))

		const outcome = await runtime.runPromise(
			DashboardWidgetDataService.use((service) =>
				service.resolve(
					ORG,
					document([widget("w-facets", { kind: "route", endpoint: "traces_facets", params: {} })]),
					{ widgetId: "w-facets", source: "primary" },
					WINDOW,
					{},
				),
			).pipe(Effect.flip),
		)

		// The allowlist is the point: an endpoint nobody deliberately enabled for
		// sharing is refused rather than served through some generic fallback.
		expect(outcome._tag).toBe("@maple/http/errors/ShareUnsupportedWidgetError")
		expect(outcome).toMatchObject({ widgetId: "w-facets", kind: "traces_facets" })
		await runtime.dispose()
	})

	it("reports a query that ran and failed as retryable, not as unsupported", async () => {
		// The distinction is the whole point: "unsupported" draws a permanent muted
		// tile, so a warehouse timeout landing there tells a viewer the chart will
		// never work and offers them no retry.
		const { runtime } = makeHarness(() => Effect.fail("warehouse timeout"))

		const outcome = await runtime.runPromise(
			DashboardWidgetDataService.use((service) =>
				service.resolve(
					ORG,
					document([
						widget("w-chart", {
							kind: "query",
							resultShape: "timeseries",
							queries: [{ id: "q1", name: "A", aggregation: "count", dataSource: "traces" }],
						}),
					]),
					{ widgetId: "w-chart", source: "primary" },
					WINDOW,
					{},
				),
			).pipe(Effect.flip),
		)

		expect(outcome._tag).toBe("@maple/http/errors/ShareWidgetExecutionError")
		expect(outcome).toMatchObject({ widgetId: "w-chart" })
		await runtime.dispose()
	})

	it("keeps a defect inside the per-widget envelope", async () => {
		// A driver throwing on an unexpected row shape is a defect, not a failure,
		// and an escaping defect 500s the whole batch — blanking every other tile
		// on the board, which is exactly what the envelope exists to prevent.
		const { runtime } = makeHarness(() => Effect.die("driver threw"))

		const outcome = await runtime.runPromise(
			DashboardWidgetDataService.use((service) =>
				service.resolve(
					ORG,
					document([
						widget("w-chart", {
							kind: "query",
							resultShape: "timeseries",
							queries: [{ id: "q1", name: "A", aggregation: "count", dataSource: "traces" }],
						}),
					]),
					{ widgetId: "w-chart", source: "primary" },
					WINDOW,
					{},
				),
			).pipe(Effect.flip),
		)

		expect(outcome._tag).toBe("@maple/http/errors/ShareWidgetExecutionError")
		await runtime.dispose()
	})

	it("clamps a list widget's window before issuing the query", async () => {
		const { runtime, windows } = makeHarness(() =>
			Effect.succeed({ kind: "list", data: [], meta: { columns: [] } }),
		)

		const outcome = await runtime.runPromise(
			DashboardWidgetDataService.use((service) =>
				service.resolve(
					ORG,
					document([
						widget("w-list", {
							kind: "query",
							resultShape: "list",
							queries: [{ id: "q1", name: "A", aggregation: "count", dataSource: "traces" }],
						}),
					]),
					{ widgetId: "w-list", source: "primary" },
					// 30 days, well past the raw-row list ceiling.
					WINDOW,
					{},
				),
			),
		)

		expect(outcome.narrowedToSeconds).toBe(MAX_LIST_RANGE_SECONDS)

		// The clamp has to reach the SQL, not just the response envelope — a
		// resolver that reported narrowing while still scanning 30 days would be
		// the exact bug this asserts against.
		expect(windows.length).toBeGreaterThan(0)
		const executed = windows[0]
		const spanSeconds = (Date.parse(`${executed.endTime}Z`) - Date.parse(`${executed.startTime}Z`)) / 1000
		expect(spanSeconds).toBe(MAX_LIST_RANGE_SECONDS)
		expect(executed.endTime).toBe(WINDOW.endTime)

		await runtime.dispose()
	})

	it("leaves a chart widget's window alone", async () => {
		const { runtime, windows } = makeHarness(() =>
			Effect.succeed({
				kind: "timeseries",
				data: [{ bucket: "2026-01-01 00:00:00", series: { A: 1 } }],
			}),
		)

		const outcome = await runtime.runPromise(
			DashboardWidgetDataService.use((service) =>
				service.resolve(
					ORG,
					document([
						widget("w-chart", {
							kind: "query",
							resultShape: "timeseries",
							queries: [{ id: "q1", name: "A", aggregation: "count", dataSource: "traces" }],
						}),
					]),
					{ widgetId: "w-chart", source: "primary" },
					WINDOW,
					{},
				),
			),
		)

		expect(outcome.narrowedToSeconds).toBeUndefined()
		expect(windows[0]).toMatchObject({ startTime: WINDOW.startTime, endTime: WINDOW.endTime })
		await runtime.dispose()
	})
})

describe("DashboardWidgetDataService.resolveBatch", () => {
	const BATCH_WINDOW = { startTime: "2026-01-01 00:00:00", endTime: "2026-01-01 01:00:00" }
	const queryWidget = (id: string, dataSource: string) =>
		widget(id, {
			kind: "query",
			resultShape: "timeseries",
			queries: [{ id: "q1", name: "A", aggregation: "count", dataSource }],
		})
	const timeseries = () =>
		Effect.succeed({ kind: "timeseries", data: [{ bucket: "2026-01-01 00:00:00", series: { A: 1 } }] })

	it("refuses only the widgets whose telemetry the caller cannot read", async () => {
		const { runtime, windows } = makeHarness(timeseries)

		const { results } = await runtime.runPromise(
			DashboardWidgetDataService.use((service) =>
				service.resolveBatch(
					ORG,
					document([queryWidget("w-traces", "traces"), queryWidget("w-logs", "logs")]),
					{
						requests: [
							{ widgetId: "w-traces", source: "primary" },
							{ widgetId: "w-logs", source: "primary" },
						],
						window: BATCH_WINDOW,
						variableValues: {},
						canRead: (family) => family === "traces",
					},
				),
			),
		)

		expect(results[0]).toMatchObject({ widgetId: "w-traces", ok: true })
		expect(results[1]).toEqual({
			widgetId: "w-logs",
			ok: false,
			reason: "unsupported",
			message: 'This widget requires the "logs:read" scope.',
		})
		// The refused widget never reached the warehouse.
		expect(windows).toHaveLength(1)
		await runtime.dispose()
	})

	const routeWidget = (id: string, endpoint: string) => widget(id, { kind: "route", endpoint, params: {} })
	const UNSUPPORTED = {
		ok: false,
		reason: "unsupported",
		message: "This widget type can't be read outside the dashboard yet.",
	}

	it.each([
		["a key without traces:read", (family: string) => family === "logs"],
		["a full key", () => true],
	])("refuses a route with no server plan as unsupported for %s", async (_label, canRead) => {
		const { runtime, windows } = makeHarness(timeseries)

		const { results } = await runtime.runPromise(
			DashboardWidgetDataService.use((service) =>
				service.resolveBatch(ORG, document([routeWidget("w-traces", "list_traces")]), {
					requests: [{ widgetId: "w-traces", source: "primary" }],
					window: BATCH_WINDOW,
					variableValues: {},
					canRead,
				}),
			),
		)

		// No scope can make this widget readable, so a missing scope is not the answer.
		expect(results).toEqual([{ widgetId: "w-traces", ...UNSUPPORTED }])
		expect(windows).toHaveLength(0)
		await runtime.dispose()
	})

	it("refuses a servable traces route for a key without traces:read", async () => {
		const { runtime, windows } = makeHarness(timeseries)

		const { results } = await runtime.runPromise(
			DashboardWidgetDataService.use((service) =>
				service.resolveBatch(ORG, document([routeWidget("w-overview", "service_overview")]), {
					requests: [{ widgetId: "w-overview", source: "primary" }],
					window: BATCH_WINDOW,
					variableValues: {},
					canRead: (family) => family === "logs",
				}),
			),
		)

		expect(results).toEqual([
			{
				widgetId: "w-overview",
				ok: false,
				reason: "unsupported",
				message: 'This widget requires the "traces:read" scope.',
			},
		])
		expect(windows).toHaveLength(0)
		await runtime.dispose()
	})

	const RAW_SQL = "SELECT count() AS value FROM traces WHERE $__orgFilter AND $__timeFilter(Timestamp)"
	const ALL_SCOPES_MESSAGE = 'This widget requires the "traces:read", "metrics:read" scopes.'

	// v1, MCP and imports accept a route-shaped raw SQL source, so it must be gated like the explicit one.
	it.each([
		["route-shaped", { kind: "route", endpoint: "raw_sql_chart", params: { sql: RAW_SQL } }],
		["explicit", { kind: "raw_sql", sql: RAW_SQL }],
	])("refuses %s raw SQL to a logs-only key without running it", async (_label, dataSource) => {
		const { runtime, rawSql } = makeHarness(timeseries)

		const { results } = await runtime.runPromise(
			DashboardWidgetDataService.use((service) =>
				service.resolveBatch(ORG, document([widget("w-sql", dataSource)]), {
					requests: [{ widgetId: "w-sql", source: "primary" }],
					window: BATCH_WINDOW,
					variableValues: {},
					canRead: (family) => family === "logs",
				}),
			),
		)

		expect(results).toEqual([
			{ widgetId: "w-sql", ok: false, reason: "unsupported", message: ALL_SCOPES_MESSAGE },
		])
		expect(rawSql).toHaveLength(0)
		await runtime.dispose()
	})

	it.each([
		["route-shaped", { kind: "route", endpoint: "raw_sql_chart", params: { sql: RAW_SQL } }],
		["explicit", { kind: "raw_sql", sql: RAW_SQL }],
	])("runs %s raw SQL for a full key", async (_label, dataSource) => {
		const { runtime, rawSql } = makeHarness(timeseries)

		const { results } = await runtime.runPromise(
			DashboardWidgetDataService.use((service) =>
				service.resolveBatch(ORG, document([widget("w-sql", dataSource)]), {
					requests: [{ widgetId: "w-sql", source: "primary" }],
					window: BATCH_WINDOW,
					variableValues: {},
					canRead: () => true,
				}),
			),
		)

		expect(results[0]).toMatchObject({ widgetId: "w-sql", ok: true })
		expect(rawSql).toHaveLength(1)
		await runtime.dispose()
	})

	it("refuses an endpoint named after an Object prototype key as unsupported", async () => {
		const { runtime, windows } = makeHarness(timeseries)

		const { results } = await runtime.runPromise(
			DashboardWidgetDataService.use((service) =>
				service.resolveBatch(ORG, document([routeWidget("w-proto", "constructor")]), {
					requests: [{ widgetId: "w-proto", source: "primary" }],
					window: BATCH_WINDOW,
					variableValues: {},
					canRead: () => true,
				}),
			),
		)

		expect(results).toEqual([{ widgetId: "w-proto", ...UNSUPPORTED }])
		expect(windows).toHaveLength(0)
		await runtime.dispose()
	})

	it("keeps a board's pinned filter when a live variable option carries a quote", async () => {
		// The first listed span name is the variable's value: a truncated SQL statement with one quote.
		const { runtime, queries } = makeHarness((request) => {
			const query = request.query as { kind?: string; facet?: string }
			return query.kind === "facets"
				? Effect.succeed({
						kind: "facets",
						data: [{ facetType: query.facet, name: 'SELECT "users', count: 3 }],
					})
				: timeseries()
		})
		const pinned = widget("w-pinned", {
			kind: "query",
			resultShape: "timeseries",
			queries: [
				{
					id: "q1",
					name: "A",
					aggregation: "count",
					dataSource: "traces",
					whereClause: 'span.name = "$span" AND service.name = "frontend"',
				},
			],
		})
		const board = document(
			[pinned],
			[{ name: "span", type: "query", source: { kind: "facet", facet: "span_name" } }],
		)

		const { results } = await runtime.runPromise(
			DashboardWidgetDataService.use((service) =>
				service.resolveBatch(ORG, board, {
					requests: [{ widgetId: "w-pinned", source: "primary" }],
					window: BATCH_WINDOW,
					variableValues: {},
					canRead: () => true,
				}),
			),
		)

		expect(results[0]).toMatchObject({ widgetId: "w-pinned", ok: true })
		const executed = JSON.stringify(
			Arr.filter(queries, (query) => (query as { kind?: string }).kind !== "facets"),
		)
		// The pinned clause survives, and the span clause stays an unresolved reference that matches nothing.
		expect(executed).toContain("frontend")
		expect(executed).toContain("$span")
		expect(executed).not.toContain("users")
		await runtime.dispose()
	})

	it("resolves up to four widgets of a batch at once, keeping request order", async () => {
		let inFlight = 0
		let peak = 0
		const { runtime } = makeHarness(() =>
			Effect.gen(function* () {
				inFlight += 1
				peak = Math.max(peak, inFlight)
				yield* Effect.sleep("20 millis")
				inFlight -= 1
				return { kind: "timeseries", data: [{ bucket: "2026-01-01 00:00:00", series: { A: 1 } }] }
			}),
		)
		const ids = ["w1", "w2", "w3", "w4", "w5", "w6"]

		const { results } = await runtime.runPromise(
			DashboardWidgetDataService.use((service) =>
				service.resolveBatch(ORG, document(Arr.map(ids, (id) => queryWidget(id, "traces"))), {
					requests: Arr.map(ids, (widgetId): WidgetDataRequest => ({
						widgetId,
						source: "primary",
					})),
					window: BATCH_WINDOW,
					variableValues: {},
					canRead: () => true,
				}),
			),
		)

		expect(peak).toBe(4)
		expect(Arr.map(results, (result) => result.widgetId)).toEqual(ids)
		await runtime.dispose()
	})
})

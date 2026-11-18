import { assert, describe, expect, it } from "@effect/vitest"
import { Effect, Option, Array as Arr, Record as Rec, String as Str } from "effect"
import { dataSourcePromql, dataSourceRawSql, dataSourceTransform } from "@maple/widgets/dashboard"
import { convertGrafanaDashboardToPortable, isGrafanaDashboardJson } from "./grafana-dashboard-import"
import {
	legacyRowsDashboard,
	nodeExporterDashboard,
	sharedExportDashboard,
} from "./grafana-dashboard-import.fixtures"

type Converted = Effect.Success<ReturnType<typeof convertGrafanaDashboardToPortable>>
type Widget = Converted["dashboard"]["widgets"][number]

const widgetNamed = (converted: Converted, title: string): Widget => {
	const widget = Arr.findFirst(
		converted.dashboard.widgets,
		(candidate) => candidate.display.title === title,
	)
	assert.isTrue(Option.isSome(widget), `no widget titled ${title}`)
	return Option.getOrThrow(widget)
}

/** Every container's widgets stay inside 12 columns and never overlap. */
const expectValidGrid = (converted: Converted) => {
	const byContainer = Arr.groupBy(converted.dashboard.widgets, (widget) => widget.sectionId ?? "root")
	for (const widgets of Rec.values(byContainer)) {
		for (const [index, a] of widgets.entries()) {
			expect(a.layout.x).toBeGreaterThanOrEqual(0)
			expect(a.layout.x + a.layout.w).toBeLessThanOrEqual(12)
			expect(a.layout.w).toBeGreaterThanOrEqual(a.layout.minW ?? 1)
			for (const b of widgets.slice(index + 1)) {
				const overlap =
					a.layout.x < b.layout.x + b.layout.w &&
					b.layout.x < a.layout.x + a.layout.w &&
					a.layout.y < b.layout.y + b.layout.h &&
					b.layout.y < a.layout.y + a.layout.h
				expect(overlap, `${a.display.title} overlaps ${b.display.title}`).toBe(false)
			}
		}
	}
}

describe("convertGrafanaDashboardToPortable on a Node Exporter style board", () => {
	it.effect("keeps the dashboard's name, tags, range and refresh", () =>
		Effect.gen(function* () {
			const { dashboard } = yield* convertGrafanaDashboardToPortable(nodeExporterDashboard)
			expect(dashboard.name).toBe("Node overview")
			expect(dashboard.description).toBe("Host metrics from node_exporter")
			expect(dashboard.tags).toEqual(["linux", "node", "grafana-import"])
			expect(dashboard.timeRange).toEqual({ type: "relative", value: "24h" })
			expect(dashboard.refreshIntervalSeconds).toBe(60)
		}),
	)

	it.effect("turns rows into sections and keeps panels before the first row on the root canvas", () =>
		Effect.gen(function* () {
			const converted = yield* convertGrafanaDashboardToPortable(nodeExporterDashboard)
			expect(
				Arr.map(converted.dashboard.sections ?? [], ({ title, collapsed }) => ({ title, collapsed })),
			).toEqual([
				{ title: "Quick CPU / Mem / Disk", collapsed: undefined },
				{ title: "Network", collapsed: true },
			])
			const [quick, network] = converted.dashboard.sections ?? []
			const about = widgetNamed(converted, "About")
			expect(about.sectionId).toBeUndefined()
			expect(about.layout).toMatchObject({ x: 0, y: 0, w: 12, h: 3 })
			// Coordinates restart at the top of each section.
			expect(widgetNamed(converted, "CPU busy")).toMatchObject({
				sectionId: quick?.id,
				layout: { x: 0, y: 0, w: 2, h: 2 },
			})
			expect(widgetNamed(converted, "CPU basic")).toMatchObject({
				sectionId: quick?.id,
				layout: { x: 4, y: 0, w: 8, h: 4 },
			})
			expect(widgetNamed(converted, "Traffic")).toMatchObject({
				sectionId: network?.id,
				tabId: network?.tabs[0]?.id,
				layout: { x: 0, y: 0 },
			})
			expect(widgetNamed(converted, "Interfaces").layout).toMatchObject({ x: 6, y: 0, w: 6 })
			expectValidGrid(converted)
		}),
	)

	it.effect("pushes a tile grown to its minimum width below the neighbour it would cover", () =>
		Effect.gen(function* () {
			const converted = yield* convertGrafanaDashboardToPortable(nodeExporterDashboard)
			// Grafana w: 2 is one Maple column; a stat needs two, which the gauge and CPU basic hold.
			expect(widgetNamed(converted, "Uptime").layout).toMatchObject({ x: 3, y: 4, w: 2 })
			expect(widgetNamed(converted, "CPU basic").layout).toMatchObject({ x: 4, y: 0 })
			expectValidGrid(converted)
		}),
	)

	it.effect("stores PromQL verbatim with its legend, step and the panel's display type", () =>
		Effect.gen(function* () {
			const converted = yield* convertGrafanaDashboardToPortable(nodeExporterDashboard)
			const cpu = widgetNamed(converted, "CPU basic")
			expect(cpu.visualization).toBe("chart")
			expect(dataSourcePromql(cpu.dataSource)).toEqual({
				query: 'sum by (mode) (rate(node_cpu_seconds_total{instance="$node",job="$job"}[$__rate_interval]))',
				legendFormat: "{{mode}}",
				minStepSeconds: 30,
				displayType: "line",
			})
			expect(cpu.display).toMatchObject({
				chartId: "query-builder-line",
				stacked: true,
				unit: "percent",
			})
			// `__auto` is Grafana's default legend, so it is left unset.
			const busy = widgetNamed(converted, "CPU busy")
			expect(dataSourcePromql(busy.dataSource)?.legendFormat).toBeUndefined()
			expect(dataSourcePromql(busy.dataSource)?.displayType).toBe("stat")
			expect(dataSourceTransform(busy.dataSource)?.reduceToValue).toEqual({
				field: "value",
				aggregate: "first",
			})
		}),
	)

	it.effect("skips hidden targets and names the queries it could not keep", () =>
		Effect.gen(function* () {
			const converted = yield* convertGrafanaDashboardToPortable(nodeExporterDashboard)
			expect(dataSourcePromql(widgetNamed(converted, "Uptime").dataSource)?.query).toBe(
				"node_time_seconds - node_boot_time_seconds",
			)
			expect(converted.warnings).toContain(
				'Panel "CPU basic" has 2 queries; Maple imported A only. Not imported: B: count(node_cpu_seconds_total)',
			)
		}),
	)

	it.effect("maps units, thresholds, gauge bounds and bar charts", () =>
		Effect.gen(function* () {
			const converted = yield* convertGrafanaDashboardToPortable(nodeExporterDashboard)
			expect(widgetNamed(converted, "CPU busy").display).toMatchObject({
				unit: "percent_100",
				thresholds: [
					{ value: 85, color: "#FF9830" },
					{ value: 95, color: "#F2495C" },
				],
			})
			expect(widgetNamed(converted, "Root FS used").display).toMatchObject({
				unit: "percent",
				gauge: { min: 0, max: 1 },
				thresholds: [{ value: 0.9, color: "#F2495C" }],
			})
			expect(widgetNamed(converted, "Uptime").display.unit).toBe("duration_s")
			const traffic = widgetNamed(converted, "Traffic")
			expect(traffic.display).toMatchObject({ chartId: "query-builder-bar", stacked: false })
			expect(traffic.display.unit).toBeUndefined()
			expect(dataSourcePromql(traffic.dataSource)?.minStepSeconds).toBe(60)
			expect(converted.warnings).toContain(
				'Panel "Traffic" uses the Grafana unit "bps", which Maple has no match for; it shows plain numbers.',
			)
			expect(dataSourcePromql(widgetNamed(converted, "Interfaces").dataSource)?.displayType).toBe(
				"table",
			)
		}),
	)

	it.effect("converts variables and rewrites interval variable references", () =>
		Effect.gen(function* () {
			const converted = yield* convertGrafanaDashboardToPortable(nodeExporterDashboard)
			expect(converted.dashboard.variables).toEqual([
				{
					name: "job",
					type: "query",
					// `job` is the service name, which OTel metrics carry only as `service.name`.
					source: { kind: "facet", facet: "service" },
					defaultValue: "node",
				},
				{
					name: "node",
					label: "Host",
					includeAll: true,
					type: "query",
					source: {
						kind: "metric",
						metricType: "gauge",
						metricNames: ["node_uname_info"],
						scope: "metric",
						attributeKey: "instance",
					},
				},
				{
					name: "mountpoint",
					type: "custom",
					options: [{ value: "/" }, { value: "/home" }, { value: "/var" }],
					defaultValue: "/",
				},
			])
			expect(dataSourcePromql(widgetNamed(converted, "Traffic").dataSource)?.query).toBe(
				"rate(node_network_receive_bytes_total[$__interval])",
			)
			expect(converted.warnings).toEqual(
				expect.arrayContaining([
					'Interval variable "resolution" was not imported; its references now use $__interval in PromQL and $__interval_s (seconds) in ClickHouse SQL.',
					'Variable "node" lists every instance of node_uname_info; the label filters in "node_uname_info{job="$job"}" were not imported.',
				]),
			)
		}),
	)

	it.effect("counts panels, conversions and placeholders", () =>
		Effect.gen(function* () {
			const converted = yield* convertGrafanaDashboardToPortable(nodeExporterDashboard)
			expect(converted.stats).toEqual({ panels: 7, converted: 7, placeholders: 0 })
			expect(widgetNamed(converted, "About").display.markdown?.content).toBe(
				"Fleet **health** at a glance.",
			)
		}),
	)
})

describe("convertGrafanaDashboardToPortable on other inputs", () => {
	it.effect(
		"resolves `${DS_*}` inputs of an export for sharing and keeps unsupported panels as notes",
		() =>
			Effect.gen(function* () {
				const converted = yield* convertGrafanaDashboardToPortable(sharedExportDashboard)
				expect(dataSourcePromql(widgetNamed(converted, "Requests").dataSource)?.query).toBe(
					'sum(rate(http_requests_total{host="${host_name}"}[5m]))',
				)
				expect(widgetNamed(converted, "Requests").display.unit).toBe("requests_per_sec")
				const loki = widgetNamed(converted, "Error logs")
				expect(loki.visualization).toBe("markdown")
				expect(loki.display.markdown?.content).toContain(
					'A: count_over_time({app="api"} |= "error" [5m])',
				)
				expect(widgetNamed(converted, "Recent logs").visualization).toBe("markdown")
				expect(widgetNamed(converted, "Topology").display.markdown?.content).toContain(
					"Panel type: `nodeGraph`",
				)
				expect(converted.stats).toEqual({ panels: 5, converted: 2, placeholders: 3 })
				expect(converted.warnings).toEqual(
					expect.arrayContaining([
						'Variable "host-name" was renamed to "host_name"; queries that use it were rewritten.',
						'Panel "Error logs" queries Loki, which Maple cannot run; it was imported as a placeholder.',
						'Logs panel "Recent logs" was imported as a placeholder.',
						'Panel "Topology" uses the "nodeGraph" panel type, which Maple cannot draw; it was imported as a placeholder.',
						'The time range "now-30s" to "now" has no Maple equivalent; the dashboard shows the last 6h.',
					]),
				)
				expectValidGrid(converted)
			}),
	)

	it.effect("runs a ClickHouse target through the org-scoped raw SQL path", () =>
		Effect.gen(function* () {
			const converted = yield* convertGrafanaDashboardToPortable(sharedExportDashboard)
			const slow = widgetNamed(converted, "Slow spans")
			expect(slow.visualization).toBe("table")
			expect(dataSourceRawSql(slow.dataSource)?.sql).toBe(
				"SELECT SpanName, count() AS value FROM traces WHERE (OrgId = 'x' AND $__timeFilter(Timestamp)) AND $__orgFilter GROUP BY SpanName",
			)
		}),
	)

	it.effect("scopes a ClickHouse query at its top level and keeps a stat's calculation", () =>
		Effect.gen(function* () {
			const ch = { type: "grafana-clickhouse-datasource", uid: "ch" }
			const panel = (
				title: string,
				type: string,
				rawSql: string,
				extra: Record<string, unknown> = {},
			) => ({
				type,
				title,
				datasource: ch,
				gridPos: { x: 0, y: 0, w: 6, h: 4 },
				targets: [{ refId: "A", rawSql }],
				...extra,
			})
			const converted = yield* convertGrafanaDashboardToPortable({
				title: "ClickHouse",
				schemaVersion: 39,
				panels: [
					panel(
						"Nested",
						"table",
						"SELECT n FROM (SELECT count() AS n FROM logs WHERE OrgId = 'x' AND $__timeFilter(Timestamp) LIMIT 5) WHERE n > 0",
					),
					panel(
						"Literal",
						"table",
						"SELECT count() AS value FROM logs WHERE OrgId = 'x' AND Body LIKE '%limit%' AND $__timeFilter(Timestamp)",
					),
					panel(
						"Subquery",
						"table",
						"SELECT count() FROM (SELECT * FROM logs WHERE OrgId = 'x' AND $__timeFilter(Timestamp))",
					),
					panel(
						"Either",
						"table",
						"SELECT count() AS value FROM logs WHERE OrgId = 'legacy' OR ServiceName = 'api' AND $__timeFilter(Timestamp);",
					),
					panel(
						"Commented",
						"table",
						"SELECT count() AS value FROM logs WHERE OrgId = 'x' AND $__timeFilter(Timestamp) -- scoped",
					),
					panel(
						"Grouped",
						"table",
						"SELECT SpanName, count() AS value FROM traces WHERE OrgId = 'x' AND $__timeFilter(Timestamp) -- scoped\nGROUP BY SpanName",
					),
					panel(
						"Except column",
						"table",
						"SELECT * EXCEPT (Body) FROM logs WHERE OrgId = 'x' AND $__timeFilter(Timestamp)",
					),
					panel(
						"Having",
						"table",
						"SELECT count() AS value FROM logs WHERE OrgId = 'x' AND $__timeFilter(Timestamp) HAVING count() > 0",
					),
					panel(
						"Block comment",
						"table",
						"SELECT count() AS value FROM logs WHERE OrgId = 'x' AND $__timeFilter(Timestamp) /* LIMIT */",
					),
					panel(
						"Nested comment",
						"table",
						"SELECT count() AS value FROM logs WHERE OrgId = 'x' AND $__timeFilter(Timestamp) /* outer /* inner */ LIMIT */",
					),
					panel(
						"Union",
						"table",
						"SELECT count() FROM logs WHERE OrgId = 'x' AND $__timeFilter(Timestamp) UNION ALL SELECT count() FROM traces WHERE OrgId = 'x' AND $__timeFilter(Timestamp)",
					),
					panel(
						"Mean",
						"stat",
						"SELECT toStartOfMinute(Timestamp) AS t, count() AS value FROM logs WHERE OrgId = 'x' AND $__timeFilter(Timestamp) GROUP BY t",
						{ options: { reduceOptions: { calcs: ["mean"] } } },
					),
				],
			})
			// A subquery's rows may carry no OrgId, so any subquery read without $__orgFilter is a placeholder.
			expect(dataSourceRawSql(widgetNamed(converted, "Nested").dataSource)).toBeNull()
			expect(dataSourceRawSql(widgetNamed(converted, "Literal").dataSource)?.sql).toBe(
				"SELECT count() AS value FROM logs WHERE (OrgId = 'x' AND Body LIKE '%limit%' AND $__timeFilter(Timestamp)) AND $__orgFilter",
			)
			expect(dataSourceRawSql(widgetNamed(converted, "Subquery").dataSource)).toBeNull()
			// Each SELECT of a UNION needs its own scope, so the importer leaves it to the author.
			expect(dataSourceRawSql(widgetNamed(converted, "Union").dataSource)).toBeNull()
			expect(dataSourceRawSql(widgetNamed(converted, "Nested comment").dataSource)?.sql).toBe(
				"SELECT count() AS value FROM logs WHERE (OrgId = 'x' AND $__timeFilter(Timestamp) /* outer /* inner */ LIMIT */) AND $__orgFilter",
			)
			expect(dataSourceRawSql(widgetNamed(converted, "Having").dataSource)?.sql).toBe(
				"SELECT count() AS value FROM logs WHERE (OrgId = 'x' AND $__timeFilter(Timestamp)) AND $__orgFilter HAVING count() > 0",
			)
			expect(dataSourceRawSql(widgetNamed(converted, "Block comment").dataSource)?.sql).toBe(
				"SELECT count() AS value FROM logs WHERE (OrgId = 'x' AND $__timeFilter(Timestamp) /* LIMIT */) AND $__orgFilter",
			)
			expect(dataSourceRawSql(widgetNamed(converted, "Except column").dataSource)?.sql).toBe(
				"SELECT * EXCEPT (Body) FROM logs WHERE (OrgId = 'x' AND $__timeFilter(Timestamp)) AND $__orgFilter",
			)
			// The OR is grouped, so the org filter binds every branch; the semicolon no longer ends the statement early.
			expect(dataSourceRawSql(widgetNamed(converted, "Either").dataSource)?.sql).toBe(
				"SELECT count() AS value FROM logs WHERE (OrgId = 'legacy' OR ServiceName = 'api' AND $__timeFilter(Timestamp)) AND $__orgFilter",
			)
			// A trailing line comment would swallow the closing parenthesis; it gets its own line.
			expect(dataSourceRawSql(widgetNamed(converted, "Commented").dataSource)?.sql).toBe(
				"SELECT count() AS value FROM logs WHERE (OrgId = 'x' AND $__timeFilter(Timestamp) -- scoped\n) AND $__orgFilter",
			)
			expect(dataSourceRawSql(widgetNamed(converted, "Grouped").dataSource)?.sql).toBe(
				"SELECT SpanName, count() AS value FROM traces WHERE (OrgId = 'x' AND $__timeFilter(Timestamp) -- scoped\n) AND $__orgFilter GROUP BY SpanName",
			)
			expect(converted.warnings).toEqual(
				expect.arrayContaining([
					expect.stringContaining("reads a subquery; add $__orgFilter inside it"),
				]),
			)
			expect(widgetNamed(converted, "Mean").dataSource).toMatchObject({
				transform: { reduceToValue: { field: "value", aggregate: "avg" } },
			})
		}),
	)

	it.effect("maps today so far, and warns where Maple draws a panel differently", () =>
		Effect.gen(function* () {
			const ch = { type: "grafana-clickhouse-datasource", uid: "ch" }
			const converted = yield* convertGrafanaDashboardToPortable({
				title: "Differences",
				schemaVersion: 39,
				time: { from: "now/d", to: "now" },
				panels: [
					{
						type: "timeseries",
						title: "Share",
						datasource: { type: "prometheus", uid: "prom" },
						gridPos: { x: 0, y: 0, w: 12, h: 6 },
						fieldConfig: { defaults: { custom: { stacking: { mode: "percent" } } } },
						targets: [{ refId: "A", expr: "sum by (job) (up)" }],
					},
					{
						type: "stat",
						title: "Default",
						datasource: ch,
						gridPos: { x: 0, y: 6, w: 6, h: 4 },
						targets: [
							{
								refId: "A",
								rawSql: "SELECT count() AS value FROM logs WHERE OrgId = 'x' AND $__timeFilter(Timestamp)",
							},
						],
					},
					{
						type: "stat",
						title: "Spread",
						datasource: ch,
						gridPos: { x: 6, y: 6, w: 6, h: 4 },
						options: { reduceOptions: { calcs: ["range"] } },
						targets: [
							{
								refId: "A",
								rawSql: "SELECT count() AS value FROM logs WHERE OrgId = 'x' AND $__timeFilter(Timestamp)",
							},
						],
					},
					{
						type: "stat",
						title: "Latest",
						datasource: ch,
						gridPos: { x: 12, y: 0, w: 6, h: 4 },
						options: { reduceOptions: { calcs: ["lastNotNull"] } },
						targets: [
							{
								refId: "A",
								rawSql: "SELECT count() AS value FROM logs WHERE OrgId = 'x' AND $__timeFilter(Timestamp)",
							},
						],
					},
				],
			})
			expect(converted.dashboard.timeRange).toEqual({ type: "relative", value: "today" })
			expect(converted.warnings).toEqual(
				expect.arrayContaining([
					expect.stringContaining('Panel "Share" stacked its series as percentages'),
					expect.stringContaining(`Panel "Latest" reads the query's first row`),
					// No calc and an unsupported calc fall back to the first row too, and say so.
					expect.stringContaining(`Panel "Default" reads the query's first row`),
					expect.stringContaining(
						`Panel "Spread" reduces with "range", which Maple does not have; it shows the value of the query's first row`,
					),
					expect.stringContaining(`Panel "Spread" reads the query's first row`),
				]),
			)
		}),
	)

	it.effect("unwraps the API's `{ dashboard, meta }` envelope", () =>
		Effect.gen(function* () {
			const converted = yield* convertGrafanaDashboardToPortable({
				dashboard: nodeExporterDashboard,
				meta: { slug: "node-overview" },
			})
			expect(converted.dashboard.name).toBe("Node overview")
			expect(converted.stats.panels).toBe(7)
		}),
	)

	it.effect("lays out the old `rows` schema by span, with titled rows as sections", () =>
		Effect.gen(function* () {
			const converted = yield* convertGrafanaDashboardToPortable(legacyRowsDashboard)
			expect(
				Arr.map(converted.dashboard.sections ?? [], ({ title, collapsed }) => ({ title, collapsed })),
			).toEqual([{ title: "Details", collapsed: true }])
			expect(widgetNamed(converted, "Up")).toMatchObject({
				visualization: "stat",
				layout: { x: 0, y: 0, w: 4, h: 4 },
			})
			expect(widgetNamed(converted, "Load")).toMatchObject({
				layout: { x: 4, y: 0, w: 8, h: 4 },
				display: { stacked: true, unit: "short" },
			})
			expect(widgetNamed(converted, "Disk IO")).toMatchObject({
				sectionId: converted.dashboard.sections?.[0]?.id,
				layout: { x: 0, y: 0, w: 12, h: 5 },
				display: { chartId: "query-builder-bar" },
			})
			expectValidGrid(converted)
		}),
	)

	it.effect("refuses JSON that is not a Grafana dashboard", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(
				convertGrafanaDashboardToPortable({ kind: "Dashboard", spec: {} }),
			)
			expect(error._tag).toBe("@maple/http/errors/DashboardValidationError")
			const empty = yield* Effect.flip(
				convertGrafanaDashboardToPortable({ panels: [], schemaVersion: 39 }),
			)
			expect(empty.details).toEqual(["The dashboard has no panels to import."])
		}),
	)
})

describe("isGrafanaDashboardJson", () => {
	it("recognises a bare board, the API envelope and the old schema, not Perses or Maple JSON", () => {
		expect(isGrafanaDashboardJson(nodeExporterDashboard)).toBe(true)
		expect(isGrafanaDashboardJson({ dashboard: nodeExporterDashboard, meta: {} })).toBe(true)
		expect(isGrafanaDashboardJson(legacyRowsDashboard)).toBe(true)
		expect(isGrafanaDashboardJson({ kind: "Dashboard", spec: { panels: {} } })).toBe(false)
		expect(isGrafanaDashboardJson({ name: "Maple", widgets: [], timeRange: {} })).toBe(false)
		expect(isGrafanaDashboardJson({ panels: [] })).toBe(false)
	})
})

describe("review regressions", () => {
	const prom = { type: "prometheus", uid: "p" }
	const panel = (extra: Record<string, unknown>) => ({
		id: 1,
		title: "Panel",
		gridPos: { x: 0, y: 0, w: 12, h: 8 },
		datasource: prom,
		targets: [{ refId: "A", expr: "up", datasource: prom }],
		...extra,
	})
	const board = (panels: ReadonlyArray<unknown>, variables: ReadonlyArray<unknown> = []) => ({
		title: "Board",
		schemaVersion: 39,
		panels,
		templating: { list: variables },
	})

	it.effect("keeps Grafana's stat calculation and warns on one Maple lacks", () =>
		Effect.gen(function* () {
			const { dashboard, warnings } = yield* convertGrafanaDashboardToPortable(
				board([
					panel({ type: "stat", options: { reduceOptions: { calcs: ["max"] } } }),
					panel({ id: 2, type: "stat", options: { reduceOptions: { calcs: ["range"] } } }),
				]),
			)
			const transforms = Arr.map(
				dashboard.widgets,
				(w) => dataSourceTransform(w.dataSource)?.reduceToValue?.aggregate,
			)
			expect(transforms).toEqual(["max", "first"])
			expect(Arr.some(warnings, Str.includes('"range"'))).toBe(true)
		}),
	)

	it.effect("imports a PromQL heatmap as a placeholder", () =>
		Effect.gen(function* () {
			const { dashboard, warnings } = yield* convertGrafanaDashboardToPortable(
				board([panel({ type: "heatmap" })]),
			)
			expect(dataSourcePromql(dashboard.widgets[0]?.dataSource)).toBeNull()
			expect(Arr.some(warnings, Str.includes("buckets over time"))).toBe(true)
		}),
	)

	it.effect("never lets one rename capture another variable's references", () =>
		Effect.gen(function* () {
			const query = 'up{a="${host-name}", b="$host_name"}'
			const { dashboard } = yield* convertGrafanaDashboardToPortable(
				board(
					[panel({ type: "timeseries", targets: [{ refId: "A", expr: query, datasource: prom }] })],
					[
						{ name: "host-name", type: "textbox", query: "web-1" },
						{ name: "host_name", type: "textbox", query: "web-2" },
					],
				),
			)
			const names = Arr.map(dashboard.variables ?? [], (v) => v.name)
			expect(names).toEqual(["host_name_2", "host_name"])
			expect(dataSourcePromql(dashboard.widgets[0]?.dataSource)?.query).toBe(
				'up{a="${host_name_2}", b="$host_name"}',
			)
		}),
	)
})

describe("guesses the importer says out loud", () => {
	const board = (panels: ReadonlyArray<unknown>, variables: ReadonlyArray<unknown> = []) => ({
		title: "Board",
		schemaVersion: 39,
		panels,
		templating: { list: variables },
	})

	it.effect("warns when SQL with no datasource type is read as ClickHouse", () =>
		Effect.gen(function* () {
			const { dashboard, warnings } = yield* convertGrafanaDashboardToPortable(
				board([
					{
						id: 1,
						type: "table",
						title: "Rows",
						gridPos: { x: 0, y: 0, w: 12, h: 8 },
						datasource: "some-uid",
						targets: [
							{
								refId: "A",
								rawSql: "SELECT count() AS value FROM logs WHERE $__orgFilter AND $__timeFilter(Timestamp)",
							},
						],
					},
				]),
			)
			expect(dataSourceRawSql(dashboard.widgets[0]?.dataSource)?.sql).toContain("$__orgFilter")
			expect(Arr.some(warnings, Str.includes("were read as ClickHouse"))).toBe(true)
		}),
	)

	it.effect("warns when a job variable's selector is replaced by the service list", () =>
		Effect.gen(function* () {
			const note = { id: 1, type: "text", title: "Note", gridPos: { x: 0, y: 0, w: 12, h: 4 } }
			const { warnings } = yield* convertGrafanaDashboardToPortable(
				board([note], [{ name: "job", type: "query", query: 'label_values(up{env="prod"}, job)' }]),
			)
			expect(Arr.some(warnings, Str.includes('its selector "up{env="prod"}" was not imported'))).toBe(true)
			const bare = yield* convertGrafanaDashboardToPortable(
				board([note], [{ name: "job", type: "query", query: "label_values(job)" }]),
			)
			expect(Arr.some(bare.warnings, Str.includes("lists every service"))).toBe(false)
		}),
	)
})

describe("assumed PromQL", () => {
	it.effect("says once that queries without a datasource type were read as PromQL", () =>
		Effect.gen(function* () {
			const bare = (id: number) => ({
				id,
				type: "timeseries",
				title: `P${id}`,
				gridPos: { x: 0, y: id * 8, w: 12, h: 8 },
				datasource: { uid: "lo0" },
				targets: [{ refId: "A", expr: "up", datasource: { uid: "lo0" } }],
			})
			const { warnings } = yield* convertGrafanaDashboardToPortable({
				title: "Bare",
				schemaVersion: 39,
				panels: [bare(1), bare(2)],
			})
			expect(Arr.filter(warnings, Str.includes("were read as PromQL"))).toHaveLength(1)
		}),
	)
})

describe("ClickHouse org scoping reads code, not comments or literals", () => {
	const ch = { type: "grafana-clickhouse-datasource", uid: "ch" }
	const importSql = (rawSql: string, variables: ReadonlyArray<unknown> = []) =>
		Effect.map(
			convertGrafanaDashboardToPortable({
				title: "ClickHouse",
				schemaVersion: 39,
				panels: [
					{
						type: "table",
						title: "Panel",
						datasource: ch,
						gridPos: { x: 0, y: 0, w: 6, h: 4 },
						targets: [{ refId: "A", rawSql }],
					},
				],
				templating: { list: variables },
			}),
			(converted) => dataSourceRawSql(converted.dashboard.widgets[0]?.dataSource)?.sql ?? null,
		)

	it.effect("does not take $__orgFilter in a comment or a literal as the scope", () =>
		Effect.gen(function* () {
			expect(
				yield* importSql("SELECT count() AS value FROM logs WHERE $__timeFilter(Timestamp) -- add $__orgFilter"),
			).toBeNull()
			expect(
				yield* importSql(
					"SELECT count() AS value FROM logs WHERE Body = '$__orgFilter' AND $__timeFilter(Timestamp)",
				),
			).toBeNull()
			// An OrgId in a comment does not count as the predicate either.
			expect(
				yield* importSql("SELECT count() AS value FROM logs WHERE $__timeFilter(Timestamp) /* OrgId */"),
			).toBeNull()
		}),
	)

	it.effect("needs $__orgFilter in every SELECT of a UNION, not just one", () =>
		Effect.gen(function* () {
			const scoped = "SELECT count() FROM a WHERE $__timeFilter(ts) AND $__orgFilter"
			expect(yield* importSql(`${scoped} UNION ALL SELECT count() FROM b WHERE $__timeFilter(ts)`)).toBeNull()
			expect(yield* importSql(`${scoped} UNION ALL ${scoped}`)).toBe(`${scoped} UNION ALL ${scoped}`)
		}),
	)

	it.effect("finds an EXCEPT or INTERSECT however its SELECT is spaced or commented", () =>
		Effect.gen(function* () {
			const scoped = "SELECT 1 FROM traces WHERE $__orgFilter AND $__timeFilter(Timestamp)"
			const open = "SELECT 1 FROM logs WHERE $__timeFilter(Timestamp)"
			for (const op of ["EXCEPT /*c*/ ", "EXCEPT -- c\n", "EXCEPT(", "EXCEPT ALL(", "INTERSECT DISTINCT /* x */ ("]) {
				const close = Str.endsWith("(")(op) ? ")" : ""
				expect(yield* importSql(`${scoped} ${op}${open}${close}`), op).toBeNull()
			}
			// Column exclusion is not a set operation.
			expect(
				yield* importSql("SELECT * EXCEPT (Body) FROM logs WHERE $__orgFilter AND $__timeFilter(Timestamp)"),
			).not.toBeNull()
		}),
	)

	it.effect("leaves a join scoped only by one OrgId to its author", () =>
		Effect.gen(function* () {
			expect(
				yield* importSql(
					"SELECT x.* FROM traces t JOIN (SELECT * FROM logs) x ON 1 WHERE t.OrgId = 'a' AND $__timeFilter(t.Timestamp)",
				),
			).toBeNull()
			// ARRAY JOIN unrolls the same rows, so the outer filter still covers them.
			expect(
				yield* importSql(
					"SELECT tag FROM logs ARRAY JOIN Tags AS tag WHERE OrgId = 'a' AND $__timeFilter(Timestamp)",
				),
			).toBe("SELECT tag FROM logs ARRAY JOIN Tags AS tag WHERE (OrgId = 'a' AND $__timeFilter(Timestamp)) AND $__orgFilter")
		}),
	)

	it.effect("does not read a column named like a clause as that clause", () =>
		Effect.gen(function* () {
			expect(
				yield* importSql("SELECT format, count() FROM logs WHERE OrgId = 1 AND $__timeFilter(Timestamp)"),
			).toBe("SELECT format, count() FROM logs WHERE (OrgId = 1 AND $__timeFilter(Timestamp)) AND $__orgFilter")
			expect(
				yield* importSql(
					"SELECT count() FROM logs WHERE OrgId = 1 AND limit IN (1, 2) AND $__timeFilter(Timestamp) LIMIT 5",
				),
			).toBe(
				"SELECT count() FROM logs WHERE (OrgId = 1 AND limit IN (1, 2) AND $__timeFilter(Timestamp)) AND $__orgFilter LIMIT 5",
			)
			// Two-word clauses and a clause after a comment or a negated sort key stay clauses.
			expect(
				yield* importSql(
					"SELECT SpanName FROM traces WHERE OrgId = 'a' AND $__timeFilter(Timestamp) ORDER BY -Duration LIMIT 5",
				),
			).toBe(
				"SELECT SpanName FROM traces WHERE (OrgId = 'a' AND $__timeFilter(Timestamp)) AND $__orgFilter ORDER BY -Duration LIMIT 5",
			)
			expect(
				yield* importSql(
					"SELECT OrgId, count() FROM traces WHERE OrgId = 'a' AND $__timeFilter(Timestamp) GROUP BY /* k */ OrgId HAVING count() > 1",
				),
			).toBe(
				"SELECT OrgId, count() FROM traces WHERE (OrgId = 'a' AND $__timeFilter(Timestamp)) AND $__orgFilter GROUP BY /* k */ OrgId HAVING count() > 1",
			)
		}),
	)

	it.effect("rewrites an interval variable to the macro raw SQL expands", () =>
		Effect.gen(function* () {
			const sql = yield* importSql(
				"SELECT toStartOfInterval(Timestamp, INTERVAL $resolution SECOND) AS t, count() AS value FROM logs WHERE $__orgFilter AND $__timeFilter(Timestamp) GROUP BY t",
				[{ name: "resolution", type: "interval", query: "1m,5m" }],
			)
			expect(sql).toBe(
				"SELECT toStartOfInterval(Timestamp, INTERVAL $__interval_s SECOND) AS t, count() AS value FROM logs WHERE $__orgFilter AND $__timeFilter(Timestamp) GROUP BY t",
			)
		}),
	)
})

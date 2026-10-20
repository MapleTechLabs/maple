// The span-volume fixture of `TreemapSpike` and its
// service palette, kept apart from the definition so the lab page can build the legend.

export interface TreemapRow {
	readonly service: string
	readonly operation: string
	readonly spanCount: number
}

export const TREEMAP_ROWS: ReadonlyArray<TreemapRow> = [
	{ service: "api", operation: "GET /v2/traces", spanCount: 184_200 },
	{ service: "api", operation: "POST /v2/query", spanCount: 96_400 },
	{ service: "api", operation: "GET /v2/dashboards", spanCount: 41_800 },
	{ service: "api", operation: "GET /health", spanCount: 22_600 },
	{ service: "api", operation: "POST /v2/alerts", spanCount: 8_150 },
	{ service: "query-engine", operation: "executeSql", spanCount: 142_700 },
	{ service: "query-engine", operation: "compileCH", spanCount: 88_300 },
	{ service: "query-engine", operation: "cache.lookup", spanCount: 61_500 },
	{ service: "query-engine", operation: "decodeRows", spanCount: 30_900 },
	{ service: "ingest", operation: "otlp.traces", spanCount: 268_400 },
	{ service: "ingest", operation: "otlp.logs", spanCount: 74_100 },
	{ service: "ingest", operation: "key.resolve", spanCount: 52_300 },
	{ service: "web", operation: "ssr.render", spanCount: 39_600 },
	{ service: "web", operation: "loader.dashboard", spanCount: 27_200 },
	{ service: "web", operation: "loader.traces", spanCount: 19_450 },
	{ service: "web", operation: "loader.alerts", spanCount: 11_300 },
	{ service: "auth", operation: "token.validate", spanCount: 58_900 },
	{ service: "auth", operation: "org.resolve", spanCount: 24_700 },
	{ service: "auth", operation: "session.refresh", spanCount: 6_050 },
	{ service: "alerting", operation: "rule.evaluate", spanCount: 33_800 },
	{ service: "alerting", operation: "incident.upsert", spanCount: 9_400 },
	{ service: "alerting", operation: "notify.dispatch", spanCount: 4_120 },
	{ service: "alerting", operation: "check.persist", spanCount: 2_980 },
]

export const TILE_TOKENS = ["--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5", "--background"]

/** The services in first-seen order. */
export const TREEMAP_SERVICES: ReadonlyArray<string> = [...new Set(TREEMAP_ROWS.map((row) => row.service))]

/** `serviceColor`'s token: the palette by first-seen service order. */
export const serviceToken = (service: string): string =>
	TILE_TOKENS[Math.max(0, TREEMAP_SERVICES.indexOf(service)) % 5] ?? "--chart-1"

import type {
	SearchConsoleIntegrationStatus,
	SearchConsoleLandingPage,
	SearchConsoleOverview,
	SearchConsolePoint,
	SearchConsoleQueryRow,
} from "@maple/domain/http"
import { Array as Arr, String as Str } from "effect"
import type { SearchMetrics } from "../page/analytics/search-metrics"

type QueryRow = typeof SearchConsoleQueryRow.Type
type Point = typeof SearchConsolePoint.Type

// `/lab/analytics-search`: a young site's Search Console data, the shape that is hardest to read:
// a handful of clicks, a long tail of queries with impressions and none, and a docs subdomain.

export const SEARCH_NOW_MS = Date.UTC(2026, 10, 13, 12)
export const SEARCH_WINDOW = { startTime: "2026-10-14 00:00:00", endTime: "2026-11-13 12:00:00" }

type StatusWire = typeof SearchConsoleIntegrationStatus.Encoded

const metrics = (clicks: number, impressions: number, position: number): SearchMetrics => ({
	clicks,
	impressions,
	ctr: impressions === 0 ? 0 : clicks / impressions,
	position,
})

export const SEARCH_STATUS: StatusWire = {
	configured: true,
	connected: true,
	accountEmail: "owner@acme.dev",
	connectedByUserId: null,
	revoked: false,
	sites: [
		{
			id: "0190f2b3-0000-7000-8000-000000000001",
			siteUrl: "sc-domain:acme.dev",
			permissionLevel: "siteOwner",
			enabled: true,
			watermarkDate: "2026-11-10",
			backfillDate: "2026-07-01",
			lastSyncedAt: SEARCH_NOW_MS,
			lastError: null,
		},
		{
			id: "0190f2b3-0000-7000-8000-000000000002",
			siteUrl: "https://blog.acme.dev/",
			permissionLevel: "siteFullUser",
			enabled: true,
			watermarkDate: "2026-11-10",
			backfillDate: "2026-07-01",
			lastSyncedAt: SEARCH_NOW_MS,
			lastError: null,
		},
	],
}

/** `[query, clicks, impressions, position]`. */
const QUERIES: ReadonlyArray<readonly [string, number, number, number]> = [
	["acme dev", 3, 38, 1.4],
	["acme mcp", 1, 7, 3.2],
	["acme.dev", 1, 93, 1.1],
	["acmedocs", 1, 16, 5.6],
	["agent tracing api key", 0, 1, 37.0],
	["agent tracing cloudflare", 0, 3, 15.3],
	["agent tracing endpoint", 0, 1, 7.0],
	["api tracing", 0, 1, 99.0],
	["apm traces", 0, 2, 25.5],
	["apm tracing", 0, 4, 24.8],
	["apm with service dependency map", 0, 1, 10.0],
	["best data observability tools for startups", 0, 3, 6.3],
	["best lightweight observability platform", 0, 81, 7.2],
	["best lightweight observability platform for small teams", 0, 4, 7.5],
	["best lightweight observability platform self hosted", 0, 3, 9.7],
	["best metrics observability platform", 0, 2, 6.5],
	["best metrics observability platform 2026", 0, 1, 3.0],
	["best opentelemetry backend", 0, 1, 32.0],
	["best opentelemetry backend open source", 0, 1, 9.0],
	["best prometheus-compatible monitoring", 0, 1, 8.0],
	["best prometheus-compatible monitoring service", 0, 5, 8.4],
	["clickhouse observability", 0, 12, 18.9],
	["cloudflare workers tracing", 0, 22, 11.2],
	["effect opentelemetry", 0, 9, 6.1],
	["infrastructure monitoring open source", 0, 31, 28.3],
	["kubernetes pod metrics opentelemetry", 0, 6, 4.5],
	["observability platform", 0, 146, 42.6],
	["opentelemetry collector cloudflare", 0, 14, 9.8],
	["opentelemetry dashboard", 0, 57, 33.1],
	["otel session replay", 0, 8, 2.9],
	["prometheus remote write saas", 0, 5, 12.4],
	["self hosted observability", 0, 19, 21.7],
	["service map opentelemetry", 0, 11, 5.2],
	["trace waterfall viewer", 0, 27, 6.8],
	["uptime monitoring opentelemetry", 0, 4, 3.5],
]

export const SEARCH_QUERIES: ReadonlyArray<QueryRow> = Arr.map(
	QUERIES,
	([query, clicks, impressions, position]) => ({ query, ...metrics(clicks, impressions, position) }),
)

/** `[host, path, clicks, impressions, position, sessions, bounceRate]`. */
const PAGES: ReadonlyArray<readonly [string, string, number, number, number, number, number | null]> = [
	["acme.dev", "/", 7, 257, 5.2, 412, 0.38],
	["acme.dev", "/docs/local-mode", 3, 44, 5.1, 61, 0.44],
	["acme.dev", "/changelog/2026-10-28-service-map-namespaces", 2, 6, 1.5, 9, 0.56],
	["acme.dev", "/docs/instrumentation/cloudflare-workers", 2, 9, 4.3, 14, 0.29],
	["acme.dev", "/features/service-map", 2, 31, 8.6, 38, 0.47],
	["acme.dev", "/guides/prometheus-remote-write", 2, 23, 4.9, 17, 0.35],
	["acme.dev", "/ko/features/uptime-monitoring", 2, 10, 5.4, 3, 0.67],
	["acme.dev", "/pricing", 2, 70, 9.1, 96, 0.31],
	["acme.dev", "/docs", 1, 121, 4.4, 143, 0.27],
	["acme.dev", "/docs/agent-tracing/claude-code", 1, 6, 3.7, 8, 0.5],
	["acme.dev", "/docs/alerting/uptime-monitors", 1, 2, 5.0, 2, null],
	["acme.dev", "/docs/infrastructure/kubernetes", 1, 1, 1.0, 5, 0.4],
	["acme.dev", "/docs/infrastructure/hosts", 1, 18, 24.2, 6, 0.33],
	["acme.dev", "/docs/reference/api", 1, 50, 5.8, 22, 0.41],
	["acme.dev", "/docs/session-replay", 1, 16, 6.3, 11, 0.45],
	["acme.dev", "/features/ai-mcp-integration", 1, 15, 5.9, 19, 0.37],
	["acme.dev", "/features/alerts", 1, 14, 4.2, 12, 0.5],
	["acme.dev", "/ja/features/alerts", 1, 2, 2.5, 1, null],
	["acme.dev", "/ja/features/service-map", 1, 7, 5.3, 2, 1],
	["status.acme.dev", "/", 1, 12, 2.1, 0, null],
	["acme.dev", "/features/dashboards", 0, 88, 14.6, 27, 0.52],
	["acme.dev", "/features/infrastructure", 0, 41, 19.4, 13, 0.46],
	["acme.dev", "/docs/dashboards/widgets", 0, 9, 11.0, 4, 0.25],
	["acme.dev", "/features/session-replay", 0, 24, 12.8, 16, 0.44],
	["status.acme.dev", "/history", 0, 3, 6.7, 0, null],
]

export const SEARCH_LANDING: ReadonlyArray<SearchConsoleLandingPage> = Arr.map(
	PAGES,
	([host, path, clicks, impressions, position, sessions, bounceRate]) => ({
		page: `https://${host}${path}`,
		host,
		path,
		...metrics(clicks, impressions, position),
		sessions,
		bounceRate,
		conversions: null,
	}),
)

/** A seeded wobble, so the lab draws the same month on every load. */
const wobble = (seed: number): number => {
	const x = Math.sin(seed * 12.9898) * 43758.5453
	return x - Math.floor(x)
}

const DAY_MS = 86_400_000
const FIRST_DAY_MS = Date.UTC(2026, 9, 14)

export const SEARCH_TIMESERIES: ReadonlyArray<Point> = Arr.makeBy(28, (index) => {
	const impressions = Math.round(18 + index * 1.4 + wobble(index) * 22)
	const clicks = Math.round(wobble(index + 0.5) * 2.4 + index / 20)
	return {
		date: Str.slice(0, 10)(new Date(FIRST_DAY_MS + index * DAY_MS).toISOString()),
		...metrics(clicks, impressions, 9.4 - index * 0.12 + wobble(index + 0.2) * 2),
	}
})

const totalOf = (pick: (point: Point) => number): number =>
	Arr.reduce(SEARCH_TIMESERIES, 0, (sum, point) => sum + pick(point))

const CLICKS = totalOf((point) => point.clicks)
const IMPRESSIONS = totalOf((point) => point.impressions)

export const SEARCH_OVERVIEW: SearchConsoleOverview = {
	...metrics(CLICKS, IMPRESSIONS, 6.4),
	previous: metrics(Math.round(CLICKS * 0.7), Math.round(IMPRESSIONS * 0.82), 8.1),
}

export const SEARCH_EVENTS = [
	{ name: "signup_completed", events: 41, sessions: 38 },
	{ name: "docs_copied_snippet", events: 212, sessions: 97 },
]

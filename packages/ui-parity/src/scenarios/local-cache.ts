import { formatWarehouseDateTime } from "@maple/query-engine"
import { FROZEN_NOW_MS } from "../fixtures/identity.ts"
import type { AreaModule, Scenario } from "./types.ts"

/**
 * apps/local-ui's saved query cache (`lib/query-cache.ts`): results kept in localStorage under
 * `maple-local:query-cache:<port>`, in the cache codec's tagged JSON. A page opens on the newest
 * saved result for its view, and the stale-data notice says how old it is.
 */

const HOUR_MS = 60 * 60 * 1000
/** Captures load from `http://localhost:4800`, so the cache is the one for port 4800. */
const STORAGE_KEY = "maple-local:query-cache:4800"
const HELD_MS = 60_000
const TRACE_ID = "c0ffee00c0ffee00c0ffee00c0ffee00"

/** `boundsKey(boundsForRange("1h", anchor))`: an hour back, an hour of padding ahead. */
const windowKey = (anchorMs: number) =>
	`${formatWarehouseDateTime(anchorMs - HOUR_MS)}/${formatWarehouseDateTime(anchorMs + HOUR_MS)}`

const utc = (ms: number) => ({ $t: "utc", v: ms })

const traceRow = (index: number, name: string) => ({
	traceId: `${TRACE_ID.slice(0, 30)}0${index}`,
	startTime: utc(FROZEN_NOW_MS - HOUR_MS - index * 60_000),
	durationMs: 120 + index,
	spanCount: 3,
	services: ["storefront", "payment-svc"],
	rootSpanName: name,
	rootSpanKind: "Server",
	rootSpanAttributes: {},
	hasError: index === 2,
})

/** The trace list an hour ago: the window before the one a page opens on now. */
const olderTracesEntry = {
	key: ["local", "traces", { errorsOnly: false, scope: "root" }, windowKey(FROZEN_NOW_MS - HOUR_MS)],
	data: { pages: [[traceRow(1, "GET /cached/one"), traceRow(2, "POST /cached/two")]], pageParams: [{ $t: "undefined" }] },
	updatedAt: FROZEN_NOW_MS - HOUR_MS,
}

const span = (spanId: string, parentSpanId: string, name: string, offsetMs: number, durationMs: number) => ({
	traceId: TRACE_ID,
	spanId,
	parentSpanId,
	spanName: name,
	serviceName: "storefront",
	spanKind: "Server",
	durationMs,
	startTime: new Date(FROZEN_NOW_MS - HOUR_MS + offsetMs).toISOString(),
	statusCode: "Ok",
	statusMessage: "",
	spanAttributes: {},
	resourceAttributes: {},
})

const root = span("1000000000000001", "", "GET /cached/detail", 0, 80)
const child = span("1000000000000002", "1000000000000001", "SELECT cached", 10, 30)

/** A trace opened an hour ago, kept whole (its key has no window). */
const traceEntry = {
	key: ["local", "trace", TRACE_ID],
	data: {
		spans: [root, child],
		rootSpans: [{ ...root, depth: 0, children: [{ ...child, depth: 1, children: [] }] }],
		totalDurationMs: 80,
		services: ["storefront"],
		traceStartTime: root.startTime,
	},
	updatedAt: FROZEN_NOW_MS - HOUR_MS,
}

const olderWindow = windowKey(FROZEN_NOW_MS - HOUR_MS)

const catalogEntry = (serviceName: string, spanCount: number) => ({
	serviceName,
	serviceNamespaces: ["shop"],
	deploymentEnvironments: ["production"],
	spanCount,
	errorCount: 2,
	errorRate: 2 / spanCount,
	p50LatencyMs: 12,
	p95LatencyMs: 48,
	p99LatencyMs: 90,
	logCount: 40,
})

const olderCatalogEntry = {
	key: ["local", "services", "catalog", null, null, olderWindow],
	data: [catalogEntry("cached-api", 400), catalogEntry("cached-worker", 120)],
	updatedAt: FROZEN_NOW_MS - HOUR_MS,
}

const log = (index: number, body: string) => ({
	timestamp: formatWarehouseDateTime(FROZEN_NOW_MS - HOUR_MS - index * 1_000).replace(/$/, ".000000000"),
	severityText: index === 1 ? "ERROR" : "INFO",
	severityNumber: index === 1 ? 17 : 9,
	serviceName: "cached-api",
	body,
	traceId: "",
	spanId: "",
	recordIdentity: String(index),
	logAttributes: {},
	resourceAttributes: {},
})

const olderLogsEntry = {
	key: ["local", "logs", {}, olderWindow],
	data: { pages: [[log(1, "cached: payment declined"), log(2, "cached: order placed")]], pageParams: [{ $t: "undefined" }] },
	updatedAt: FROZEN_NOW_MS - HOUR_MS,
}

const mapEdge = (sourceService: string, targetService: string, callCount: number) => ({
	sourceService,
	targetService,
	callCount,
	estimatedCallCount: callCount,
	errorCount: 2,
	errorRate: 2 / callCount,
	avgDurationMs: 18,
	maxDurationMs: 120,
	hasSampling: false,
	samplingWeight: 1,
})

/** `useLocalServiceMap` an hour ago (1 h range: `durationSeconds` 3600), its Maps in the codec's form. */
const olderServiceMapEntry = {
	key: ["local", "service-map", 3600, olderWindow],
	data: {
		edges: [mapEdge("cached-web", "cached-api", 400), mapEdge("cached-api", "cached-worker", 120)],
		dbEdges: [],
		overviews: [],
		platforms: { $t: "map", v: [["cached-web", "web"]] },
		runtimes: { $t: "map", v: [] },
	},
	updatedAt: FROZEN_NOW_MS - HOUR_MS,
}

const saved = (entries: ReadonlyArray<unknown>) => ({ [STORAGE_KEY]: JSON.stringify({ version: 1, entries }) })

const scenario = (id: string, title: string, hash: string, extra: Partial<Scenario>): Scenario => ({
	id: `local-cache-${id}`,
	title: `Local cache: ${title}`,
	path: `/#${hash}`,
	dataset: "local",
	app: "local",
	viewports: ["desktop"],
	themes: ["light", "dark"],
	area: "local-cache",
	...extra,
})

/** Waits out the two refused probes (1 s apart) that read as "can't reach". */
const untilOffline: Scenario["steps"] = (page) => page.getByText(/^Can’t reach Maple Local\./).waitFor()

export const localCacheArea: AreaModule = {
	area: "local-cache",
	scenarios: [
		// The list opens on the older window while the new one is still loading.
		scenario("traces-loading", "traces open on an older window", "/traces", {
			localStorage: saved([olderTracesEntry]),
			faults: { delays: { "local.query": HELD_MS } },
			settle: "held",
		}),
		// The server is gone, but the saved results keep the views up.
		scenario("traces-offline", "traces with the server gone", "/traces", {
			localStorage: saved([olderTracesEntry]),
			faults: { refusals: ["local."] },
			steps: untilOffline,
		}),
		scenario("services-loading", "services open on an older window", "/services", {
			localStorage: saved([olderCatalogEntry]),
			faults: { delays: { "local.query": HELD_MS } },
			settle: "held",
		}),
		scenario("service-map-loading", "the service map opens on an older window", "/service-map", {
			localStorage: saved([olderServiceMapEntry]),
			faults: { delays: { "local.query": HELD_MS } },
			settle: "held",
		}),
		scenario("service-map-offline", "the service map with the server gone", "/service-map", {
			localStorage: saved([olderServiceMapEntry]),
			faults: { refusals: ["local."] },
			steps: untilOffline,
		}),
		scenario("logs-loading", "logs open on an older window", "/logs", {
			localStorage: saved([olderLogsEntry]),
			faults: { delays: { "local.query": HELD_MS } },
			settle: "held",
		}),
		scenario("trace-detail-loading", "a saved trace while it refetches", `/traces/${TRACE_ID}`, {
			localStorage: saved([traceEntry]),
			faults: { delays: { "local.query": HELD_MS } },
			settle: "held",
		}),
		scenario("trace-detail-offline", "a saved trace with the server gone", `/traces/${TRACE_ID}`, {
			localStorage: saved([traceEntry]),
			faults: { refusals: ["local."] },
			steps: untilOffline,
		}),
	],
}

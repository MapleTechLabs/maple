import { randomBytes } from "node:crypto"
import { Array as Arr, Option } from "effect"
import {
	fmtMetricTs,
	type MetricExponentialHistogramRow,
	type MetricGaugeRow,
	type MetricHistogramRow,
	type MetricSumRow,
} from "@maple/backend/services/warehouse/metric-rows"

const SERVICES = ["demo-api", "demo-frontend", "demo-worker", "demo-db"] as const
type DemoServiceName = (typeof SERVICES)[number]

/** The namespace each demo service reports under, so the namespace switcher and limited roles have something to show. */
const NAMESPACE_OF = {
	"demo-api": "storefront",
	"demo-frontend": "storefront",
	"demo-worker": "platform",
	"demo-db": "platform",
} as const satisfies Record<DemoServiceName, string>

const HTTP_ROUTES: Arr.NonEmptyArray<{ method: string; route: string; service: DemoServiceName }> = [
	{ method: "GET", route: "/api/users", service: "demo-api" },
	{ method: "GET", route: "/api/users/:id", service: "demo-api" },
	{ method: "POST", route: "/api/users", service: "demo-api" },
	{ method: "GET", route: "/api/orders", service: "demo-api" },
	{ method: "POST", route: "/api/orders", service: "demo-api" },
	{ method: "GET", route: "/api/products", service: "demo-api" },
	{ method: "GET", route: "/", service: "demo-frontend" },
	{ method: "GET", route: "/dashboard", service: "demo-frontend" },
	{ method: "GET", route: "/checkout", service: "demo-frontend" },
]

const DB_QUERIES: Arr.NonEmptyReadonlyArray<string> = [
	"SELECT * FROM users WHERE id = $1",
	"SELECT * FROM orders WHERE user_id = $1",
	"INSERT INTO orders (user_id, total) VALUES ($1, $2)",
	"SELECT * FROM products LIMIT 50",
	"UPDATE users SET last_seen = NOW() WHERE id = $1",
]

const WORKER_JOBS: Arr.NonEmptyReadonlyArray<string> = [
	"send_email",
	"process_payment",
	"sync_inventory",
	"generate_report",
	"refresh_cache",
]

// Demo data is written straight to the `traces` / `logs` datasources via
// WarehouseQueryService.ingest (bypassing the billing-enforced ingest gateway),
// so each row must match those datasources' ingestion JSON: the OpenTelemetry
// Collector Tinybird exporter shape (snake_case keys, jsonPath-mapped). See
// packages/domain/src/tinybird/datasources.ts.
//
// Org scoping is derived from `resource_attributes.maple_org_id`, so every row
// MUST carry it. `SampleRate` / `IsEntryPoint` are computed by datasource
// DEFAULT expressions, so they are intentionally omitted here.

type Attrs = Record<string, string>

/** One row in the `traces` datasource (collector Tinybird exporter shape). */
interface TraceRow {
	start_time: string
	trace_id: string
	span_id: string
	parent_span_id: string
	trace_state: string
	span_name: string
	span_kind: string
	service_name: string
	resource_schema_url: string
	resource_attributes: Attrs
	scope_schema_url: string
	scope_name: string
	scope_version: string
	scope_attributes: Attrs
	duration: number
	status_code: string
	status_message: string
	span_attributes: Attrs
	events_timestamp: string[]
	events_name: string[]
	events_attributes: Attrs[]
	links_trace_id: string[]
	links_span_id: string[]
	links_trace_state: string[]
	links_attributes: Attrs[]
}

/** One row in the `logs` datasource (collector Tinybird exporter shape). */
interface LogRow {
	timestamp: string
	trace_id: string
	span_id: string
	flags: number
	severity_text: string
	severity_number: number
	service_name: string
	body: string
	resource_schema_url: string
	resource_attributes: Attrs
	scope_schema_url: string
	scope_name: string
	scope_version: string
	scope_attributes: Attrs
	log_attributes: Attrs
}

interface DemoTraceBatch {
	traceRows: TraceRow[]
	logRows: LogRow[]
}

export interface DemoRows extends DemoTraceBatch {
	metricGaugeRows: MetricGaugeRow[]
	metricSumRows: MetricSumRow[]
	metricHistogramRows: MetricHistogramRow[]
	metricExponentialHistogramRows: MetricExponentialHistogramRow[]
}

const SCOPE_NAME = "@maple/demo-instr"

/** A uniform draw in [0, 1). */
type Rand = () => number

const traceIdHex = () => randomBytes(16).toString("hex")
const spanIdHex = () => randomBytes(8).toString("hex")

function pick<T>(rand: Rand, arr: Arr.NonEmptyReadonlyArray<T>): T {
	return arr[Math.floor(rand() * arr.length)] ?? Arr.headNonEmpty(arr)
}

function gaussian(rand: Rand, mean: number, stddev: number): number {
	// `rand` draws from [0, 1); flipped to (0, 1] so the logarithm never sees zero.
	const u1 = 1 - rand()
	const u2 = rand()
	const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
	return mean + z * stddev
}

function latencyMs(rand: Rand): number {
	const base = Math.max(5, gaussian(rand, 60, 40))
	if (rand() < 0.05) return base + rand() * 800
	return base
}

function dbLatencyMs(rand: Rand): number {
	return Math.max(1, gaussian(rand, 8, 5))
}

const fmtTs = fmtMetricTs

const resourceAttrs = (service: DemoServiceName, orgId: string): Attrs => ({
	maple_org_id: orgId,
	"service.name": service,
	"service.namespace": NAMESPACE_OF[service],
	"service.version": "1.0.0",
	"deployment.environment": "production",
	"telemetry.sdk.name": "maple-demo",
	"telemetry.sdk.language": "nodejs",
	"maple.demo": "true",
})

const makeTraceRow = (
	over: Partial<TraceRow> & {
		start_time: string
		trace_id: string
		span_id: string
		span_name: string
		span_kind: string
		service_name: string
		duration: number
		status_code: string
		resource_attributes: Attrs
		span_attributes: Attrs
	},
): TraceRow => ({
	parent_span_id: "",
	trace_state: "",
	resource_schema_url: "",
	scope_schema_url: "",
	scope_name: SCOPE_NAME,
	scope_version: "",
	scope_attributes: {},
	status_message: "",
	events_timestamp: [],
	events_name: [],
	events_attributes: [],
	links_trace_id: [],
	links_span_id: [],
	links_trace_state: [],
	links_attributes: [],
	...over,
})

const makeLogRow = (
	over: Partial<LogRow> & {
		timestamp: string
		severity_text: string
		severity_number: number
		service_name: string
		body: string
		resource_attributes: Attrs
	},
): LogRow => ({
	trace_id: "",
	span_id: "",
	flags: 0,
	resource_schema_url: "",
	scope_schema_url: "",
	scope_name: SCOPE_NAME,
	scope_version: "",
	scope_attributes: {},
	log_attributes: {},
	...over,
})

function generateHttpTrace(rand: Rand, timestamp: Date, orgId: string): DemoTraceBatch {
	const route = pick(rand, HTTP_ROUTES)
	const traceId = traceIdHex()
	const rootSpanId = spanIdHex()
	const dbSpanId = spanIdHex()

	const isError = rand() < 0.012
	const totalLatency = latencyMs(rand) + (isError ? 100 : 0)
	const dbLatency = Math.min(totalLatency * 0.6, dbLatencyMs(rand))
	const startMs = timestamp.getTime()
	const endMs = startMs + totalLatency
	const dbStartMs = startMs + Math.floor((totalLatency - dbLatency) / 2)

	const httpStatus = isError ? (rand() < 0.5 ? 500 : 503) : rand() < 0.04 ? 404 : 200

	const apiRow = makeTraceRow({
		start_time: fmtTs(startMs),
		trace_id: traceId,
		span_id: rootSpanId,
		span_name: `${route.method} ${route.route}`,
		span_kind: "Server",
		service_name: route.service,
		duration: Math.round(totalLatency * 1_000_000),
		status_code: isError ? "Error" : "Ok",
		status_message: isError ? "Internal server error" : "",
		resource_attributes: resourceAttrs(route.service, orgId),
		span_attributes: {
			"http.request.method": route.method,
			"http.route": route.route,
			"http.response.status_code": String(httpStatus),
			"url.scheme": "https",
			"server.address": "api.demo.maple.dev",
			"client.address": "client",
			"maple.demo": "true",
		},
		...(isError
			? {
					events_timestamp: [fmtTs(endMs)],
					events_name: ["exception"],
					events_attributes: [
						{
							"exception.type": "ConnectionResetError",
							"exception.message": `Unhandled error in ${route.method} ${route.route}: connection reset`,
						},
					],
				}
			: undefined),
	})

	const dbRow = makeTraceRow({
		start_time: fmtTs(dbStartMs),
		trace_id: traceId,
		span_id: dbSpanId,
		parent_span_id: rootSpanId,
		span_name: "pg.query",
		span_kind: "Client",
		service_name: "demo-db",
		duration: Math.round(dbLatency * 1_000_000),
		status_code: "Ok",
		resource_attributes: resourceAttrs("demo-db", orgId),
		span_attributes: {
			"db.system.name": "postgresql",
			"db.query.text": pick(rand, DB_QUERIES),
			"db.namespace": "demo",
			"maple.demo": "true",
		},
	})

	const logRows: LogRow[] = []
	if (isError) {
		logRows.push(
			makeLogRow({
				timestamp: fmtTs(endMs),
				trace_id: traceId,
				span_id: rootSpanId,
				severity_text: "Error",
				severity_number: 17,
				service_name: route.service,
				body: `Unhandled error in ${route.method} ${route.route}: connection reset`,
				resource_attributes: resourceAttrs(route.service, orgId),
				log_attributes: {
					"http.route": route.route,
					"error.type": "ConnectionResetError",
					"maple.demo": "true",
				},
			}),
		)
	}

	return { traceRows: [apiRow, dbRow], logRows }
}

function generateWorkerTrace(rand: Rand, timestamp: Date, orgId: string): DemoTraceBatch {
	const job = pick(rand, WORKER_JOBS)
	const traceId = traceIdHex()
	const spanId = spanIdHex()
	const isError = rand() < 0.008
	const total = Math.max(20, gaussian(rand, 180, 90)) + (isError ? 50 : 0)
	const startMs = timestamp.getTime()
	const endMs = startMs + total

	const row = makeTraceRow({
		start_time: fmtTs(startMs),
		trace_id: traceId,
		span_id: spanId,
		span_name: `worker.${job}`,
		span_kind: "Internal",
		service_name: "demo-worker",
		duration: Math.round(total * 1_000_000),
		status_code: isError ? "Error" : "Ok",
		status_message: isError ? "Job processing failed" : "",
		resource_attributes: resourceAttrs("demo-worker", orgId),
		span_attributes: {
			"messaging.operation": "process",
			"messaging.system": "demo-queue",
			"job.name": job,
			"maple.demo": "true",
		},
		...(isError
			? {
					events_timestamp: [fmtTs(endMs)],
					events_name: ["exception"],
					events_attributes: [
						{
							"exception.type": "JobProcessingError",
							"exception.message": `worker.${job} failed`,
						},
					],
				}
			: undefined),
	})

	return { traceRows: [row], logRows: [] }
}

// Node.js process gauges/counters for demo-api and demo-worker, one point per
// service per minute, so the metric-based dashboard templates (Node.js Runtime,
// Metric Overview) show data against demo orgs.

const METRIC_SERVICES = ["demo-api", "demo-worker"] as const satisfies readonly DemoServiceName[]
const METRIC_INTERVAL_MS = 60_000

const makeMetricBase = (service: DemoServiceName, orgId: string, startMs: number, tsMs: number) => ({
	timestamp: fmtTs(tsMs),
	start_timestamp: fmtTs(startMs),
	metric_description: "",
	metric_attributes: { "maple.demo": "true" } satisfies Attrs,
	service_name: service,
	resource_schema_url: "",
	resource_attributes: resourceAttrs(service, orgId),
	scope_schema_url: "",
	scope_name: SCOPE_NAME,
	scope_version: "",
	scope_attributes: {} as Attrs,
	flags: 0,
	exemplars_trace_id: [] as string[],
	exemplars_span_id: [] as string[],
	exemplars_timestamp: [] as string[],
	exemplars_value: [] as number[],
	exemplars_filtered_attributes: [] as Attrs[],
})

function generateRuntimeMetrics(
	rand: Rand,
	orgId: string,
	startMs: number,
	endMs: number,
	instanceId: string,
): { metricGaugeRows: MetricGaugeRow[]; metricSumRows: MetricSumRow[] } {
	const metricGaugeRows: MetricGaugeRow[] = []
	const metricSumRows: MetricSumRow[] = []

	for (const [serviceIdx, service] of METRIC_SERVICES.entries()) {
		// Cumulative monotonic GC counter, per service.
		let gcCount = 0
		let point = 0
		for (let tsMs = startMs; tsMs <= endMs; tsMs += METRIC_INTERVAL_MS, point++) {
			const base = makeMetricBase(service, orgId, startMs, tsMs)
			// Slow sine around ~120MB with per-service phase offset + jitter.
			const heapUsed = 120e6 + 30e6 * Math.sin(point / 20 + serviceIdx * 1.7) + (rand() - 0.5) * 8e6
			metricGaugeRows.push({
				...base,
				metric_name: "process.runtime.nodejs.memory.heap.used",
				metric_unit: "By",
				value: Math.max(40e6, Math.round(heapUsed)),
			})
			metricGaugeRows.push({
				...base,
				metric_name: "process.runtime.nodejs.handles",
				metric_unit: "{handles}",
				value: Math.max(
					8,
					Math.round(50 + 18 * Math.sin(point / 12 + serviceIdx) + (rand() - 0.5) * 10),
				),
			})
			// Event loop lag gauge in ms — calm ~8ms baseline with occasional
			// spikes so the Node.js Runtime template's "Event Loop Lag (Max)"
			// panel shows visible structure against demo orgs.
			const lagSpikeMs = rand() < 0.06 ? 20 + rand() * 60 : 0
			metricGaugeRows.push({
				...base,
				metric_name: "process.runtime.nodejs.eventloop.lag",
				metric_unit: "ms",
				value: Math.max(
					1,
					Math.round(
						8 + 3 * Math.sin(point / 15 + serviceIdx * 2.3) + (rand() - 0.5) * 4 + lagSpikeMs,
					),
				),
			})
			gcCount += Math.max(0, Math.round(gaussian(rand, 4, 2)))
			metricSumRows.push({
				...base,
				resource_attributes: { ...base.resource_attributes, "service.instance.id": instanceId },
				metric_name: "process.runtime.nodejs.gc.count",
				metric_unit: "{collections}",
				value: gcCount,
				aggregation_temporality: 2, // cumulative
				is_monotonic: true,
			})
		}
	}

	return { metricGaugeRows, metricSumRows }
}

// The OTel HTTP semantic-convention bucket boundaries, in seconds.
const DURATION_BOUNDS_S = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10]

// Request durations as a cumulative histogram per service, the way an SDK exports
// them: running totals since the window began, one sample a minute.
function generateDurationHistograms(
	rand: Rand,
	orgId: string,
	startMs: number,
	endMs: number,
	instanceId: string,
): MetricHistogramRow[] {
	const rows: MetricHistogramRow[] = []
	for (const [serviceIdx, service] of METRIC_SERVICES.entries()) {
		const buckets = Arr.makeBy(DURATION_BOUNDS_S.length + 1, () => 0)
		let count = 0
		let sum = 0
		let min = Number.POSITIVE_INFINITY
		let max = 0
		let point = 0
		for (let tsMs = startMs; tsMs <= endMs; tsMs += METRIC_INTERVAL_MS, point++) {
			// The worker is slower than the API, and both drift over the hour.
			const typicalS = (serviceIdx === 0 ? 0.03 : 0.12) * (1 + 0.4 * Math.sin(point / 25 + serviceIdx))
			const requests = Math.max(0, Math.round(gaussian(rand, 40, 12)))
			for (let i = 0; i < requests; i++) {
				const slow = rand() < 0.03 ? 8 : 1
				const durationS = typicalS * slow * Math.exp(gaussian(rand, 0, 0.7))
				const bucket = Option.getOrElse(
					Arr.findFirstIndex(DURATION_BOUNDS_S, (bound) => durationS <= bound),
					() => DURATION_BOUNDS_S.length,
				)
				buckets[bucket] = (buckets[bucket] ?? 0) + 1
				count += 1
				sum += durationS
				min = Math.min(min, durationS)
				max = Math.max(max, durationS)
			}
			const base = makeMetricBase(service, orgId, startMs, tsMs)
			rows.push({
				...base,
				resource_attributes: { ...base.resource_attributes, "service.instance.id": instanceId },
				metric_name: "http.server.request.duration",
				metric_unit: "s",
				count,
				sum,
				bucket_counts: [...buckets],
				explicit_bounds: DURATION_BOUNDS_S,
				min: count === 0 ? null : min,
				max: count === 0 ? null : max,
				aggregation_temporality: 2, // cumulative
			})
		}
	}
	return rows
}

// A base-2 exponential histogram as an SDK holds it: it starts at this scale and
// halves its resolution whenever the values outgrow its bucket budget.
const EXPONENTIAL_START_SCALE = 3
const EXPONENTIAL_MAX_BUCKETS = 40

/** The bucket a positive value falls in: bucket i covers (base^i, base^(i+1)], base = 2^(2^-scale). */
const exponentialBucketIndex = (value: number, scale: number) => Math.ceil(Math.log2(value) * 2 ** scale) - 1

// Database query durations as a cumulative exponential histogram per service. Slow
// queries turn up halfway through the window: they stretch the value range, so the
// histogram lowers its scale mid-series, the way a long-lived process does.
function generateQueryDurationHistograms(
	rand: Rand,
	orgId: string,
	startMs: number,
	endMs: number,
	instanceId: string,
): MetricExponentialHistogramRow[] {
	const rows: MetricExponentialHistogramRow[] = []
	for (const [serviceIdx, service] of METRIC_SERVICES.entries()) {
		let scale = EXPONENTIAL_START_SCALE
		let buckets = new Map<number, number>()
		let lowest = 0
		let highest = 0
		let count = 0
		let sum = 0
		let min = Number.POSITIVE_INFINITY
		let max = 0
		let point = 0
		for (let tsMs = startMs; tsMs <= endMs; tsMs += METRIC_INTERVAL_MS, point++) {
			const typicalS =
				(serviceIdx === 0 ? 0.004 : 0.015) * (1 + 0.3 * Math.sin(point / 30 + serviceIdx))
			const slowShare = tsMs - startMs > (endMs - startMs) / 2 ? 0.02 : 0
			const queries = Math.max(0, Math.round(gaussian(rand, 60, 15)))
			for (let i = 0; i < queries; i++) {
				const durationS = typicalS * (rand() < slowShare ? 100 : 1) * Math.exp(gaussian(rand, 0, 0.5))
				let index = exponentialBucketIndex(durationS, scale)
				// One scale lower, buckets 2k and 2k + 1 become bucket k.
				while (
					count > 0 &&
					Math.max(highest, index) - Math.min(lowest, index) >= EXPONENTIAL_MAX_BUCKETS
				) {
					const halved = new Map<number, number>()
					for (const [bucket, held] of buckets) {
						halved.set(bucket >> 1, (halved.get(bucket >> 1) ?? 0) + held)
					}
					buckets = halved
					scale -= 1
					lowest >>= 1
					highest >>= 1
					index = exponentialBucketIndex(durationS, scale)
				}
				buckets.set(index, (buckets.get(index) ?? 0) + 1)
				lowest = count === 0 ? index : Math.min(lowest, index)
				highest = count === 0 ? index : Math.max(highest, index)
				count += 1
				sum += durationS
				min = Math.min(min, durationS)
				max = Math.max(max, durationS)
			}
			const base = makeMetricBase(service, orgId, startMs, tsMs)
			rows.push({
				...base,
				resource_attributes: { ...base.resource_attributes, "service.instance.id": instanceId },
				metric_name: "db.client.operation.duration",
				metric_unit: "s",
				count,
				sum,
				scale,
				zero_count: 0,
				positive_offset: lowest,
				positive_bucket_counts:
					count === 0 ? [] : Arr.makeBy(highest - lowest + 1, (i) => buckets.get(lowest + i) ?? 0),
				negative_offset: 0,
				negative_bucket_counts: [],
				min: count === 0 ? null : min,
				max: count === 0 ? null : max,
				aggregation_temporality: 2, // cumulative
			})
		}
	}
	return rows
}

export function generateDemoRows({
	orgId,
	hours,
	ratePerHour,
	random: rand,
}: {
	orgId: string
	hours: number
	ratePerHour: number
	/** Draws from the caller's Effect `Random`. */
	random: Rand
}): DemoRows {
	const now = Date.now()
	const traceRows: TraceRow[] = []
	const logRows: LogRow[] = []

	const totalTraces = hours * ratePerHour
	const startMs = now - hours * 3600 * 1000
	for (let i = 0; i < totalTraces; i++) {
		const offsetMs = Math.floor((i / totalTraces) * hours * 3600 * 1000)
		const ts = new Date(startMs + offsetMs)

		const isWorker = rand() < 0.25
		const result = isWorker ? generateWorkerTrace(rand, ts, orgId) : generateHttpTrace(rand, ts, orgId)

		traceRows.push(...result.traceRows)
		logRows.push(...result.logRows)
	}

	// Each seed is its own instance, so the running totals of a second seed over the same
	// hours are a second series and not interleaved into the first.
	const instanceId = `demo-${Math.floor(rand() * 0xffffffff).toString(16)}`
	const { metricGaugeRows, metricSumRows } = generateRuntimeMetrics(rand, orgId, startMs, now, instanceId)
	const metricHistogramRows = generateDurationHistograms(rand, orgId, startMs, now, instanceId)
	const metricExponentialHistogramRows = generateQueryDurationHistograms(
		rand,
		orgId,
		startMs,
		now,
		instanceId,
	)

	return {
		traceRows,
		logRows,
		metricGaugeRows,
		metricSumRows,
		metricHistogramRows,
		metricExponentialHistogramRows,
	}
}

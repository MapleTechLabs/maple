import { randomBytes } from "node:crypto"

const SERVICES = ["demo-api", "demo-frontend", "demo-worker", "demo-db"] as const
type DemoServiceName = (typeof SERVICES)[number]

const HTTP_ROUTES: Array<{ method: string; route: string; service: DemoServiceName }> = [
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

const DB_QUERIES = [
	"SELECT * FROM users WHERE id = $1",
	"SELECT * FROM orders WHERE user_id = $1",
	"INSERT INTO orders (user_id, total) VALUES ($1, $2)",
	"SELECT * FROM products LIMIT 50",
	"UPDATE users SET last_seen = NOW() WHERE id = $1",
]

const WORKER_JOBS = ["send_email", "process_payment", "sync_inventory", "generate_report", "refresh_cache"]

// Demo "releases": the demo telemetry rotates `deployment.commit_sha` through these
// full 40-hex SHAs across the seeded window, so every demo service's charts show
// deploy markers. DemoService seeds a matching demo repo + vcs_commits so the
// markers' commit hover cards resolve to these (instead of "commit not found").
//
// `from` is the fraction of the window [0, 1) at/after which the release goes live.
// The first (`from: 0`) covers most of the window, so detectReleaseMarkers treats it
// as the dominant/established baseline; the later two surface as deploy markers.
export interface DemoRelease {
	readonly sha: string
	readonly message: string
	readonly authorName: string
	readonly authorEmail: string
	readonly authorLogin: string
	readonly from: number
}

export const DEMO_RELEASES: ReadonlyArray<DemoRelease> = [
	{
		sha: "3f7a9c1e8b2d4a6f0c5e9b8a1d2f3e4c5b6a7d80",
		message:
			"perf(api): cache user lookups on the orders hot path\n\nMemoize the per-request user fetch so /api/orders stops re-querying\nPostgres for every line item.",
		authorName: "Ada Lovelace",
		authorEmail: "ada@demo.maple.dev",
		authorLogin: "ada-demo",
		from: 0,
	},
	{
		sha: "b4e2d1a8c7f60593e2b1a4c6d8f0e9b7a5c3d2e1",
		message: "feat(checkout): add idempotency keys to payment processing",
		authorName: "Grace Hopper",
		authorEmail: "grace@demo.maple.dev",
		authorLogin: "grace-demo",
		from: 0.55,
	},
	{
		sha: "c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9",
		message: "fix(worker): retry inventory sync on transient queue errors",
		authorName: "Alan Turing",
		authorEmail: "alan@demo.maple.dev",
		authorLogin: "alan-demo",
		from: 0.8,
	},
]

/** The demo release live at a given fraction of the seeded window. */
const releaseForFraction = (fraction: number): DemoRelease => {
	let live = DEMO_RELEASES[0]!
	for (const release of DEMO_RELEASES) {
		if (fraction >= release.from) live = release
	}
	return live
}

// ---------------------------------------------------------------------------
// Demo data is written straight to the `traces` / `logs` datasources via
// WarehouseQueryService.ingest (bypassing the billing-enforced ingest gateway),
// so each row must match those datasources' ingestion JSON — the OpenTelemetry
// Collector Tinybird exporter shape (snake_case keys, jsonPath-mapped). See
// packages/domain/src/tinybird/datasources.ts.
//
// Org scoping is derived from `resource_attributes.maple_org_id`, so every row
// MUST carry it. `SampleRate` / `IsEntryPoint` are computed by datasource
// DEFAULT expressions, so they are intentionally omitted here.
// ---------------------------------------------------------------------------

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

export interface DemoRows {
	traceRows: TraceRow[]
	logRows: LogRow[]
}

const SCOPE_NAME = "@maple/demo-instr"

const traceIdHex = () => randomBytes(16).toString("hex")
const spanIdHex = () => randomBytes(8).toString("hex")

function pick<T>(arr: readonly T[]): T {
	return arr[Math.floor(Math.random() * arr.length)]!
}

function gaussian(mean: number, stddev: number): number {
	const u1 = Math.random()
	const u2 = Math.random()
	const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
	return mean + z * stddev
}

function latencyMs(): number {
	const base = Math.max(5, gaussian(60, 40))
	if (Math.random() < 0.05) return base + Math.random() * 800
	return base
}

function dbLatencyMs(): number {
	return Math.max(1, gaussian(8, 5))
}

// ClickHouse DateTime64 wire format: "YYYY-MM-DD HH:MM:SS.mmm" in UTC.
const fmtTs = (epochMs: number) => new Date(epochMs).toISOString().replace("T", " ").replace("Z", "")

const resourceAttrs = (service: DemoServiceName, orgId: string, commitSha: string): Attrs => ({
	maple_org_id: orgId,
	"service.name": service,
	// The short SHA reads as a version; the full SHA is what the MV extracts into
	// `service_overview_spans.CommitSha` (→ deploy markers / commit hover cards).
	"service.version": commitSha.slice(0, 7),
	"deployment.commit_sha": commitSha,
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

function generateHttpTrace(timestamp: Date, orgId: string, commitSha: string): DemoRows {
	const route = pick(HTTP_ROUTES)
	const traceId = traceIdHex()
	const rootSpanId = spanIdHex()
	const dbSpanId = spanIdHex()

	const isError = Math.random() < 0.012
	const totalLatency = latencyMs() + (isError ? 100 : 0)
	const dbLatency = Math.min(totalLatency * 0.6, dbLatencyMs())
	const startMs = timestamp.getTime()
	const endMs = startMs + totalLatency
	const dbStartMs = startMs + Math.floor((totalLatency - dbLatency) / 2)

	const httpStatus = isError ? (Math.random() < 0.5 ? 500 : 503) : Math.random() < 0.04 ? 404 : 200

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
		resource_attributes: resourceAttrs(route.service, orgId, commitSha),
		span_attributes: {
			"http.method": route.method,
			"http.route": route.route,
			"http.status_code": String(httpStatus),
			"http.scheme": "https",
			"http.host": "api.demo.maple.dev",
			"net.peer.name": "client",
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
			: {}),
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
		resource_attributes: resourceAttrs("demo-db", orgId, commitSha),
		span_attributes: {
			"db.system": "postgresql",
			"db.statement": pick(DB_QUERIES),
			"db.name": "demo",
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
				resource_attributes: resourceAttrs(route.service, orgId, commitSha),
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

function generateWorkerTrace(timestamp: Date, orgId: string, commitSha: string): DemoRows {
	const job = pick(WORKER_JOBS)
	const traceId = traceIdHex()
	const spanId = spanIdHex()
	const isError = Math.random() < 0.008
	const total = Math.max(20, gaussian(180, 90)) + (isError ? 50 : 0)
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
		resource_attributes: resourceAttrs("demo-worker", orgId, commitSha),
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
			: {}),
	})

	return { traceRows: [row], logRows: [] }
}

export function generateDemoRows({
	orgId,
	hours,
	ratePerHour,
}: {
	orgId: string
	hours: number
	ratePerHour: number
}): DemoRows {
	const now = Date.now()
	const traceRows: TraceRow[] = []
	const logRows: LogRow[] = []

	const totalTraces = hours * ratePerHour
	for (let i = 0; i < totalTraces; i++) {
		const offsetMs = Math.floor((i / totalTraces) * hours * 3600 * 1000)
		const ts = new Date(now - hours * 3600 * 1000 + offsetMs)

		// All demo services share one deploy timeline so every service's charts show
		// the same markers; the SHA rotates with the trace's position in the window.
		const commitSha = releaseForFraction(i / totalTraces).sha
		const isWorker = Math.random() < 0.25
		const result = isWorker
			? generateWorkerTrace(ts, orgId, commitSha)
			: generateHttpTrace(ts, orgId, commitSha)

		traceRows.push(...result.traceRows)
		logRows.push(...result.logRows)
	}

	return { traceRows, logRows }
}

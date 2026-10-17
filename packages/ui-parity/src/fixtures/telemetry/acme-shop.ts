import { makePrng, type NonEmpty, type Prng } from "../prng.ts"
import { formatMicros, formatSeconds, type TelemetryRows, type WarehouseRow } from "./rows.ts"

/**
 * The Acme Shop scenario from `scripts/seed-demo/` (same services, routes, call graph and incident),
 * generated straight into warehouse rows with a seeded PRNG: no OTLP, no network, same rows every run.
 */

interface ServiceSpec {
	readonly name: string
	readonly language: "nodejs" | "go" | "python"
	readonly version: string
	/** Rolled out `minutesBeforeNow` before the frozen clock; earlier spans carry `version`. */
	readonly deploy?: { readonly version: string; readonly minutesBeforeNow: number }
}

const STOREFRONT: ServiceSpec = {
	name: "storefront",
	language: "nodejs",
	version: "5.8.2",
	deploy: { version: "5.9.0", minutesBeforeNow: 600 },
}
const CHECKOUT: ServiceSpec = { name: "checkout-api", language: "nodejs", version: "4.2.0" }

export const ACME_SERVICES: ReadonlyArray<ServiceSpec> = [
	STOREFRONT,
	CHECKOUT,
	{ name: "cart-svc", language: "go", version: "1.22.1", deploy: { version: "1.23.0", minutesBeforeNow: 330 } },
	{ name: "catalog-api", language: "python", version: "2.14.0", deploy: { version: "2.15.0", minutesBeforeNow: 1140 } },
	{ name: "payment-svc", language: "nodejs", version: "3.4.1", deploy: { version: "3.5.0", minutesBeforeNow: 120 } },
	{ name: "auth-svc", language: "go", version: "2.0.3" },
]

/** The payment-svc 3.5.0 rollout exhausts its pool: payment queries time out until the frozen `now`. */
const INCIDENT_MINUTES = 120
const PODS_PER_SERVICE = 2
const NODES = ["ip-10-0-12-84", "ip-10-0-13-201", "ip-10-0-21-17", "ip-10-0-22-140"] as const
const SLUGS = ["linen-overshirt", "trail-runner-2", "canvas-tote", "merino-beanie", "field-watch"] as const

type SpanKind = "Server" | "Client" | "Internal" | "Producer" | "Consumer"

interface Failure {
	readonly type: string
	readonly message: string
}

/** One span to emit; children run sequentially after `selfMs / 2` of the parent's own work. */
interface Call {
	readonly service: string
	readonly name: string
	readonly kind: SpanKind
	readonly selfMs: number
	readonly attributes: Readonly<Record<string, string>>
	readonly children: ReadonlyArray<Call>
	readonly failure?: Failure
	/** Server spans log their request; `route` and `method` feed the log body and http metric. */
	readonly http?: { readonly method: string; readonly route: string; readonly path: string }
}

interface Context {
	readonly rng: Prng
	/** Inside the payment-svc incident window. */
	readonly incident: boolean
}

const host = (service: string) => `${service}.shop.svc.cluster.local`

const server = (
	service: string,
	method: string,
	route: string,
	path: string,
	selfMs: number,
	children: ReadonlyArray<Call>,
	failure?: Failure,
): Call => ({
	service,
	name: `${method} ${route}`,
	kind: "Server",
	selfMs,
	children,
	http: { method, route, path },
	attributes: {
		"http.request.method": method,
		"http.route": route,
		"url.path": path,
		"url.scheme": "http",
		"server.address": host(service),
		"network.protocol.version": "1.1",
	},
	...(failure === undefined ? undefined : { failure }),
})

/** The caller's client span around a call into another service's server span. */
const hop = (caller: string, callee: Call): Call => ({
	service: caller,
	name: callee.name,
	kind: "Client",
	selfMs: 1,
	children: [callee],
	attributes: {
		"http.request.method": callee.http?.method ?? "GET",
		"url.template": callee.http?.route ?? "",
		"url.full": `http://${host(callee.service)}:8080${callee.http?.path ?? ""}`,
		"server.address": host(callee.service),
		"server.port": "8080",
		"peer.service": callee.service,
	},
})

const queryText = (op: string, table: string): string =>
	op === "SELECT"
		? `SELECT * FROM ${table} WHERE id = $1`
		: op === "INSERT"
			? `INSERT INTO ${table} VALUES ($1, $2, $3)`
			: `UPDATE ${table} SET version = version + 1 WHERE id = $1`

const postgres = (service: string, op: string, table: string, ms: number, failure?: Failure): Call => ({
	service,
	name: `${op} shop.${table}`,
	kind: "Client",
	selfMs: ms,
	children: [],
	attributes: {
		"db.system.name": "postgresql",
		"db.system": "postgresql",
		"db.namespace": "shop",
		"db.operation.name": op,
		"db.collection.name": table,
		"db.query.text": queryText(op, table),
		"server.address": "orders-db.shop.svc.cluster.local",
		"server.port": "5432",
	},
	...(failure === undefined ? undefined : { failure }),
})

const redis = (service: string, op: string, key: string, ms: number): Call => ({
	service,
	name: op,
	kind: "Client",
	selfMs: ms,
	children: [],
	attributes: {
		"db.system.name": "redis",
		"db.system": "redis",
		"db.namespace": "cache",
		"db.operation.name": op,
		"db.query.text": `${op} ${key}`,
		"server.address": "redis.shop.svc.cluster.local",
		"server.port": "6379",
	},
})

const external = (service: string, method: string, hostname: string, path: string, ms: number): Call => ({
	service,
	name: `${method} ${hostname}`,
	kind: "Client",
	selfMs: ms,
	children: [],
	attributes: {
		"http.request.method": method,
		"url.full": `https://${hostname}${path}`,
		"server.address": hostname,
		"server.port": "443",
	},
})

const internal = (service: string, name: string, ms: number): Call => ({
	service,
	name,
	kind: "Internal",
	selfMs: ms,
	children: [],
	attributes: {},
})

const POOL_TIMEOUT: Failure = {
	type: "ConnectionTimeout",
	message: "timed out acquiring a connection from the pool after 5000ms",
}

/** Payment queries: 3-9 ms normally, about 11% pool timeouts (5 s) during the incident. */
const paymentQuery = (ctx: Context, op: string, normalMs: number): Call =>
	ctx.incident && ctx.rng.chance(0.11)
		? postgres("payment-svc", op, "payments", 5000 + ctx.rng.int(0, 40), POOL_TIMEOUT)
		: postgres("payment-svc", op, "payments", ctx.incident ? 540 * ctx.rng.spread(0.4) : normalMs)

const session = (ctx: Context, caller: string): Call =>
	hop(
		caller,
		server("auth-svc", "GET", "/session", "/session", 2, [redis("auth-svc", "GET", `session:${ctx.rng.hex(8)}`, 1)]),
	)

const productId = (ctx: Context) => String(ctx.rng.int(10000, 99999))

const catalogProduct = (ctx: Context): Call => {
	const id = productId(ctx)
	const failure = ctx.rng.chance(0.002) ? { type: "KeyError", message: "'variant_id'" } : undefined
	return server(
		"catalog-api",
		"GET",
		"/products/{id}",
		`/products/${id}`,
		6,
		[
			redis("catalog-api", "GET", `product:${id}`, 1),
			postgres("catalog-api", "SELECT", "products", 4),
			postgres("catalog-api", "SELECT", "variants", 3),
		],
		failure,
	)
}

const home = (ctx: Context): Call =>
	server("storefront", "GET", "/", "/", 14, [
		session(ctx, "storefront"),
		hop(
			"storefront",
			server("catalog-api", "GET", "/products", "/products", 8, [
				redis("catalog-api", "GET", "catalog:featured", 1),
				postgres("catalog-api", "SELECT", "products", 6),
				// The N+1: one variants query per featured product.
				...Array.from({ length: ctx.rng.int(12, 16) }, () => postgres("catalog-api", "SELECT", "variants", 2)),
			]),
		),
	])

const productPage = (ctx: Context): Call => {
	const slug = ctx.rng.pick(SLUGS)
	const failure = ctx.rng.chance(0.004)
		? { type: "TypeError", message: "Cannot read properties of undefined (reading 'price')" }
		: undefined
	return server(
		"storefront",
		"GET",
		"/product/[slug]",
		`/product/${slug}`,
		14,
		[hop("storefront", catalogProduct(ctx)), internal("storefront", "render ProductPage", 9)],
		failure,
	)
}

const cartAdd = (ctx: Context): Call => {
	const cart = productId(ctx)
	return server("storefront", "POST", "/api/cart", "/api/cart", 5, [
		session(ctx, "storefront"),
		hop(
			"storefront",
			server("cart-svc", "POST", "/carts/{id}/items", `/carts/${cart}/items`, 3, [
				redis("cart-svc", "HSET", `cart:${cart}`, 1),
			]),
		),
	])
}

const cartView = (ctx: Context): Call => {
	const cart = productId(ctx)
	return server("storefront", "GET", "/cart", "/cart", 14, [
		session(ctx, "storefront"),
		hop(
			"storefront",
			server("cart-svc", "GET", "/carts/{id}", `/carts/${cart}`, 2, [redis("cart-svc", "HGETALL", `cart:${cart}`, 1)]),
		),
	])
}

const checkout = (ctx: Context): Call => {
	const cart = productId(ctx)
	return server("storefront", "POST", "/api/checkout", "/api/checkout", 5, [
		hop(
			"storefront",
			server("checkout-api", "POST", "/checkout", "/checkout", 4, [
				session(ctx, "checkout-api"),
				hop(
					"checkout-api",
					server("cart-svc", "GET", "/carts/{id}", `/carts/${cart}`, 2, [
						redis("cart-svc", "HGETALL", `cart:${cart}`, 1),
					]),
				),
				hop(
					"checkout-api",
					server("payment-svc", "POST", "/charges", "/charges", 3, [
						paymentQuery(ctx, "INSERT", 9),
						external("payment-svc", "POST", "api.stripe.com", "/v1/payment_intents", 240),
						postgres("payment-svc", "UPDATE", "payments", 4),
					]),
				),
				{ ...internal("checkout-api", "publish orders.created", 2), kind: "Producer" },
			]),
		),
	])
}

const orderView = (ctx: Context): Call => {
	const id = productId(ctx)
	return server("storefront", "GET", "/order/[id]", `/order/ord_${ctx.rng.hex(8)}`, 14, [
		session(ctx, "storefront"),
		hop("storefront", server("payment-svc", "GET", "/charges/{id}", `/charges/${id}`, 2, [paymentQuery(ctx, "SELECT", 3)])),
	])
}

const login = (ctx: Context): Call =>
	server("storefront", "POST", "/api/login", "/api/login", 5, [
		hop(
			"storefront",
			server("auth-svc", "POST", "/login", "/login", 3, [
				postgres("auth-svc", "SELECT", "users", 3),
				internal("auth-svc", "argon2.verify", 38),
				redis("auth-svc", "SET", `session:${ctx.rng.hex(8)}`, 1),
			]),
		),
	])

const ENTRY_POINTS: NonEmpty<readonly [(ctx: Context) => Call, number]> = [
	[home, 24],
	[productPage, 30],
	[cartAdd, 14],
	[cartView, 8],
	[checkout, 14],
	[orderView, 16],
	[login, 6],
]

interface Resource {
	readonly service: ServiceSpec
	readonly attributes: Readonly<Record<string, string>>
}

/** Pods and commit shas are derived from the service and rollout, so they never vary between runs. */
const resourceFor = (service: ServiceSpec, pod: number, deployed: boolean): Resource => {
	const version = deployed && service.deploy !== undefined ? service.deploy.version : service.version
	const sha = Array.from(`${service.name}@${version}`)
		.reduce((acc, char) => (Math.imul(acc, 31) + char.charCodeAt(0)) >>> 0, 7)
		.toString(16)
		.padStart(8, "0")
		.repeat(5)
	return {
		service,
		attributes: {
			"service.name": service.name,
			"service.version": version,
			"service.namespace": "shop",
			"service.instance.id": `${service.name}-${sha.slice(0, 9)}-p${pod}`,
			"deployment.environment.name": "production",
			"deployment.environment": "production",
			"vcs.ref.head.revision": sha,
			"telemetry.sdk.name": "opentelemetry",
			"telemetry.sdk.language": service.language,
			"cloud.provider": "aws",
			"cloud.region": "us-east-1",
			"k8s.cluster.name": "prod-us-east-1",
			"k8s.namespace.name": "shop",
			"k8s.deployment.name": service.name,
			"k8s.pod.name": `${service.name}-${sha.slice(0, 9)}-p${pod}`,
			"k8s.node.name": NODES[(service.name.length + pod) % NODES.length] ?? NODES[0],
		},
	}
}

interface HttpBucket {
	count: number
	sum: number
	min: number
	max: number
	readonly buckets: Array<number>
}

/** `http.server.request.duration` bounds, in seconds, as the seed-demo histogram uses. */
export const HTTP_BOUNDS = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10]

interface Sink {
	readonly orgId: string
	readonly rng: Prng
	readonly resourceAt: (service: string, micros: number) => Resource
	readonly traces: Array<WarehouseRow>
	readonly logs: Array<WarehouseRow>
	/** Keyed `service|route|method|status|5-minute bucket start`. */
	readonly http: Map<string, HttpBucket>
}

interface Emitted {
	readonly endMicros: number
	readonly failure: Failure | undefined
	/** The service whose server span failed, for the caller's `UpstreamError`. */
	readonly failedService: string | undefined
}

const SEVERITY = { DEBUG: 5, INFO: 9, WARN: 13, ERROR: 17 } as const

const pushLog = (
	sink: Sink,
	resource: Resource,
	micros: number,
	severity: keyof typeof SEVERITY,
	body: string,
	attributes: Readonly<Record<string, string>>,
	trace?: { readonly traceId: string; readonly spanId: string },
) =>
	sink.logs.push({
		OrgId: sink.orgId,
		Timestamp: formatMicros(micros),
		TimestampTime: formatSeconds(micros),
		TraceId: trace?.traceId ?? "",
		SpanId: trace?.spanId ?? "",
		TraceFlags: trace === undefined ? 0 : 1,
		SeverityText: severity,
		SeverityNumber: SEVERITY[severity],
		ServiceName: resource.service.name,
		Body: body,
		ResourceSchemaUrl: "",
		ResourceAttributes: resource.attributes,
		ScopeSchemaUrl: "",
		ScopeName: "maple-seed-demo",
		ScopeVersion: "1.0.0",
		ScopeAttributes: {},
		LogAttributes: attributes,
	})

const recordHttp = (sink: Sink, call: Call, startMicros: number, durationMs: number, status: string) => {
	if (call.http === undefined) return
	const bucket = Math.floor(startMicros / 300_000_000) * 300_000_000
	const key = [call.service, call.http.route, call.http.method, status, bucket].join("|")
	const seconds = durationMs / 1000
	const entry = sink.http.get(key) ?? {
		count: 0,
		sum: 0,
		min: seconds,
		max: seconds,
		buckets: Array.from({ length: HTTP_BOUNDS.length + 1 }, () => 0),
	}
	entry.count += 1
	entry.sum += seconds
	entry.min = Math.min(entry.min, seconds)
	entry.max = Math.max(entry.max, seconds)
	const index = HTTP_BOUNDS.findIndex((bound) => seconds <= bound)
	const slot = index === -1 ? HTTP_BOUNDS.length : index
	entry.buckets[slot] = (entry.buckets[slot] ?? 0) + 1
	sink.http.set(key, entry)
}

const emit = (sink: Sink, call: Call, traceId: string, parentSpanId: string, startMicros: number): Emitted => {
	const { rng } = sink
	const spanId = rng.hex(16)
	const half = (call.selfMs * 1000 * rng.spread(0.3)) / 2
	const children = call.children.reduce<{ readonly cursor: number; readonly failed?: Emitted }>(
		(state, child) => {
			const result = emit(sink, child, traceId, spanId, state.cursor + rng.int(50, 400))
			return { cursor: result.endMicros, failed: state.failed ?? (result.failure ? result : undefined) }
		},
		{ cursor: startMicros + half },
	)
	const endMicros = children.cursor + half
	const durationMs = (endMicros - startMicros) / 1000
	const childFailure = children.failed
	const failure: Failure | undefined =
		call.failure ??
		(childFailure === undefined || call.kind === "Client"
			? undefined
			: childFailure.failedService === undefined || childFailure.failedService === call.service
				? childFailure.failure
				: { type: "UpstreamError", message: `${childFailure.failedService} returned 500` })
	const propagated = failure ?? childFailure?.failure
	const isHttp = call.kind === "Server" || call.attributes["peer.service"] !== undefined
	const status = propagated === undefined ? "200" : "500"
	const resource = sink.resourceAt(call.service, startMicros)
	const errorSpan = failure !== undefined
	sink.traces.push({
		OrgId: sink.orgId,
		Timestamp: formatMicros(startMicros),
		TraceId: traceId,
		SpanId: spanId,
		ParentSpanId: parentSpanId,
		TraceState: "",
		SpanName: call.name,
		SpanKind: call.kind,
		ServiceName: call.service,
		ResourceSchemaUrl: "",
		ResourceAttributes: resource.attributes,
		ScopeSchemaUrl: "",
		ScopeName: "maple-seed-demo",
		ScopeVersion: "1.0.0",
		ScopeAttributes: {},
		Duration: Math.round((endMicros - startMicros) * 1000),
		StatusCode: errorSpan ? "Error" : "Unset",
		StatusMessage: failure?.message ?? "",
		SpanAttributes: {
			...call.attributes,
			...(isHttp ? { "http.response.status_code": status } : undefined),
			...(errorSpan ? { "error.type": failure.type } : undefined),
		},
		EventsTimestamp: errorSpan ? [formatMicros(endMicros - 100)] : [],
		EventsName: errorSpan ? ["exception"] : [],
		EventsAttributes: errorSpan
			? [
					{
						"exception.type": failure.type,
						"exception.message": failure.message,
						"exception.stacktrace": `${failure.type}: ${failure.message}\n    at handler (/app/${call.service}/index.js:42:13)`,
					},
				]
			: [],
		LinksTraceId: [],
		LinksSpanId: [],
		LinksTraceState: [],
		LinksAttributes: [],
	})
	if (call.kind === "Server" && call.http !== undefined) {
		recordHttp(sink, call, startMicros, durationMs, status)
		const trace = { traceId, spanId }
		const route = { "http.route": call.http.route }
		const ms = String(Math.round(durationMs))
		if (failure !== undefined && failure.type !== "UpstreamError")
			pushLog(sink, resource, endMicros, "ERROR", `${failure.type}: ${failure.message}`, {
				...route,
				"exception.type": failure.type,
				"exception.message": failure.message,
			}, trace)
		else if (durationMs > 2000)
			pushLog(sink, resource, endMicros, "WARN", `slow request ${call.http.method} ${call.http.path} took ${ms}ms`, {
				...route,
				duration_ms: ms,
			}, trace)
		else if (rng.chance(0.55))
			pushLog(sink, resource, endMicros, "INFO", `${call.http.method} ${call.http.path} ${status} ${ms}ms`, {
				...route,
				"http.response.status_code": status,
				duration_ms: ms,
			}, trace)
	}
	return {
		endMicros,
		failure: propagated,
		failedService: call.kind === "Server" && propagated !== undefined ? call.service : childFailure?.failedService,
	}
}

export interface AcmeShopOptions {
	readonly orgId: string
	/** The dataset's frozen clock; the window ends here. */
	readonly now: Date
	readonly hours: number
	/** Traces per minute at the 19:00 UTC peak. */
	readonly peakTracesPerMinute: number
	readonly seed: number
}

const MINUTE_MICROS = 60_000_000

export const acmeShopTelemetry = (options: AcmeShopOptions): TelemetryRows => {
	const rng = makePrng(options.seed)
	const nowMicros = options.now.getTime() * 1000
	const incidentStart = nowMicros - INCIDENT_MINUTES * MINUTE_MICROS
	const byName = new Map(ACME_SERVICES.map((service) => [service.name, service]))
	const resourceAt = (name: string, micros: number): Resource => {
		const service = byName.get(name) ?? STOREFRONT
		const deployed =
			service.deploy !== undefined && micros >= nowMicros - service.deploy.minutesBeforeNow * MINUTE_MICROS
		return resourceFor(service, rng.int(0, PODS_PER_SERVICE - 1), deployed)
	}
	const sink: Sink = { orgId: options.orgId, rng, resourceAt, traces: [], logs: [], http: new Map() }
	const minutes = options.hours * 60
	Array.from({ length: minutes }, (_, index) => nowMicros - (minutes - index) * MINUTE_MICROS).forEach(
		(minuteStart) => {
			const hour = new Date(minuteStart / 1000).getUTCHours()
			const diurnal = 0.3 + 0.7 * (0.5 + 0.5 * Math.cos((2 * Math.PI * (hour - 19)) / 24))
			const count = Math.round(options.peakTracesPerMinute * diurnal * rng.spread(0.15))
			const ctx: Context = { rng, incident: minuteStart >= incidentStart }
			Array.from({ length: count }).forEach(() => {
				const entry = rng.weighted(ENTRY_POINTS)
				emit(sink, entry(ctx), rng.hex(32), "", minuteStart + rng.int(0, MINUTE_MICROS - 1))
			})
			if (ctx.incident)
				pushLog(sink, resourceAt("payment-svc", minuteStart), minuteStart + 15_000_000, "WARN",
					`pool exhausted: 20/20 connections in use, ${rng.int(24, 48)} waiting`,
					{ "db.client.connection.pool.name": "payments" })
		},
	)
	return {
		traces: sink.traces,
		logs: sink.logs,
		...metricRows(options, rng, sink.http, incidentStart),
	}
}

const FIVE_MINUTES_MICROS = 5 * MINUTE_MICROS
const MEMORY_BASE_MB = { go: 48, python: 160, nodejs: 210 } as const

const metricBase = (orgId: string, resource: Resource, name: string, unit: string, micros: number) => ({
	OrgId: orgId,
	ResourceAttributes: resource.attributes,
	ResourceSchemaUrl: "",
	ScopeName: "maple-seed-demo",
	ScopeVersion: "1.0.0",
	ScopeAttributes: {},
	ScopeSchemaUrl: "",
	ServiceName: resource.service.name,
	MetricName: name,
	MetricDescription: "",
	MetricUnit: unit,
	StartTimeUnix: formatMicros(micros - FIVE_MINUTES_MICROS),
	TimeUnix: formatMicros(micros),
	ExemplarsTraceId: [],
	ExemplarsSpanId: [],
	ExemplarsTimestamp: [],
	ExemplarsValue: [],
	ExemplarsFilteredAttributes: [],
})

/** Per pod every five minutes: CPU and memory gauges, the payments pool, orders created, request durations. */
const metricRows = (options: AcmeShopOptions, rng: Prng, http: ReadonlyMap<string, HttpBucket>, incidentStart: number) => {
	const nowMicros = options.now.getTime() * 1000
	const slots = (options.hours * 60) / 5
	const times = Array.from({ length: slots }, (_, index) => nowMicros - (slots - 1 - index) * FIVE_MINUTES_MICROS)
	const pods = ACME_SERVICES.flatMap((service) =>
		Array.from({ length: PODS_PER_SERVICE }, (_, pod) => ({ service, pod })),
	)
	const deployedAt = (service: ServiceSpec, micros: number) =>
		service.deploy !== undefined && micros >= nowMicros - service.deploy.minutesBeforeNow * MINUTE_MICROS
	const gauge = times.flatMap((micros) =>
		pods.flatMap(({ service, pod }) => {
			const resource = resourceFor(service, pod, deployedAt(service, micros))
			const load = rng.next()
			const point = (name: string, unit: string, value: number, attributes: Record<string, string> = {}) => ({
				...metricBase(options.orgId, resource, name, unit, micros),
				Attributes: attributes,
				Value: value,
				Flags: 0,
			})
			const pool =
				service.name === "payment-svc"
					? [
							point("db.client.connection.count", "{connection}", micros >= incidentStart ? 20 : rng.int(2, 8), {
								"db.client.connection.pool.name": "payments",
								"db.client.connection.state": "used",
							}),
						]
					: []
			return [
				point("process.cpu.utilization", "1", Math.min(0.95, 0.04 + load * 0.3)),
				point("process.memory.usage", "By", (MEMORY_BASE_MB[service.language] + load * 40) * 1024 * 1024),
				...pool,
			]
		}),
	)
	const sum = times.map((micros) => ({
		...metricBase(options.orgId, resourceFor(CHECKOUT, 0, false), "shop.orders.created", "{order}", micros),
		Attributes: {},
		Value: rng.int(4, 30),
		Flags: 0,
		AggregationTemporality: 1,
		IsMonotonic: true,
	}))
	const histogram = [...http.entries()].map(([key, entry]) => {
		const [service, route, method, status, bucket] = key.split("|")
		const spec = ACME_SERVICES.find((candidate) => candidate.name === service) ?? STOREFRONT
		const micros = Number(bucket) + FIVE_MINUTES_MICROS
		return {
			...metricBase(options.orgId, resourceFor(spec, 0, deployedAt(spec, micros)), "http.server.request.duration", "s", micros),
			Attributes: { "http.request.method": method, "http.route": route, "http.response.status_code": status },
			Count: entry.count,
			Sum: entry.sum,
			BucketCounts: entry.buckets,
			ExplicitBounds: HTTP_BOUNDS,
			Flags: 0,
			Min: entry.min,
			Max: entry.max,
			AggregationTemporality: 1,
		}
	})
	return { metrics_gauge: gauge, metrics_sum: sum, metrics_histogram: histogram }
}

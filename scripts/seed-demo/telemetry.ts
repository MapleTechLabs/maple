/**
 * Turns the scenario's call trees into OTLP spans, correlated logs and
 * span-derived metrics, one window at a time so a 24h seed never holds the
 * whole day in memory.
 */
import { Rng } from "./rng"
import {
	DEPLOYS,
	ENTRY_POINTS,
	INCIDENT,
	SERVICES,
	traceRate,
	type Consumer,
	type Ctx,
	type Failure,
	type Op,
	type ServiceDef,
	type ServiceName,
} from "./scenario"
import {
	attr,
	deltaHistogram,
	deltaSum,
	gauge,
	nano,
	Severity,
	SpanKind,
	StatusCode,
	type HistogramPoint,
	type KeyValue,
	type LogRecord,
	type Metric,
	type NumberPoint,
	type SeverityText,
	type Span,
	type SpanEvent,
} from "./otlp"

const MINUTE = 60_000
const CLUSTER = "prod-us-east-1"
const NODES = ["ip-10-0-12-84", "ip-10-0-13-201", "ip-10-0-21-17", "ip-10-0-22-140"] as const
const LATENCY_BOUNDS_S = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10]

export interface WorldOptions {
	readonly anchor: number
	readonly windowMs: number
	readonly incidentBeforeAnchorMs: number
	readonly peakTracesPerMinute: number
	readonly seed: number
}

export interface Resource {
	readonly key: string
	readonly service: ServiceDef
	readonly version: string
	readonly sha: string
	readonly pod: string
	readonly attributes: ReadonlyArray<KeyValue>
}

type NonEmpty<T> = readonly [T, ...T[]]

const nonEmpty = <T>(length: number, make: () => T): NonEmpty<T> => {
	const first = make()
	return [first, ...Array.from({ length: length - 1 }, make)]
}

interface Rollout {
	readonly version: string
	readonly sha: string
	readonly at: number
	readonly pods: NonEmpty<Resource>
}

/** Every service's rollouts over the window, with stable pod names and SHAs. */
export class World {
	readonly start: number
	readonly incidentAt: number
	private readonly rollouts = new Map<ServiceName, NonEmpty<Rollout>>()

	constructor(readonly options: WorldOptions) {
		this.start = options.anchor - options.windowMs
		this.incidentAt = options.anchor - options.incidentBeforeAnchorMs
		// Separate stream from traffic, so changing the traffic never renames a pod.
		const naming = new Rng(options.seed ^ 0x5eed)
		for (const service of SERVICES) {
			const deploys = DEPLOYS.filter((deploy) => deploy.service === service.name)
				.map((deploy) => ({ version: deploy.version, at: options.anchor - deploy.beforeAnchorMs }))
				.sort((a, b) => a.at - b.at)
			const rollout = (version: string, at: number): Rollout => {
				const sha = naming.hex(20)
				const templateHash = naming.hex(5).slice(0, 9)
				const pods = nonEmpty(service.replicas, () =>
					makeResource(
						service,
						version,
						sha,
						`${service.name}-${templateHash}-${podSuffix(naming)}`,
						naming.pick(NODES),
					),
				)
				return { version, sha, at, pods }
			}
			this.rollouts.set(service.name, [
				rollout(service.baseVersion, Number.NEGATIVE_INFINITY),
				...deploys.map(({ version, at }) => rollout(version, at)),
			])
		}
	}

	resource(service: ServiceName, at: number, rng: Rng): Resource {
		// The constructor inserts every ServiceName.
		const rollouts = this.rollouts.get(service)!
		const live = rollouts.filter((rollout) => rollout.at <= at).at(-1) ?? rollouts[0]
		return rng.pick(live.pods)
	}

	allResources(): ReadonlyArray<Resource> {
		return [...this.rollouts.values()].flatMap((rollouts) => rollouts.flatMap((rollout) => rollout.pods))
	}
}

const POD_ALPHABET = "bcdfghjklmnpqrstvwxz2456789"
const podSuffix = (rng: Rng) =>
	Array.from({ length: 5 }, () => POD_ALPHABET[Math.floor(rng.next() * POD_ALPHABET.length)]).join("")

const makeResource = (
	service: ServiceDef,
	version: string,
	sha: string,
	pod: string,
	node: string,
): Resource => ({
	key: pod,
	service,
	version,
	sha,
	pod,
	attributes: [
		attr("service.name", service.name),
		attr("service.version", version),
		attr("service.namespace", "shop"),
		attr("service.instance.id", pod),
		// Dual-emitted like every real Maple producer.
		attr("deployment.environment.name", "production"),
		attr("deployment.environment", "production"),
		attr("vcs.ref.head.revision", sha),
		attr("telemetry.sdk.name", "opentelemetry"),
		attr("telemetry.sdk.language", service.language),
		attr("cloud.provider", "aws"),
		attr("cloud.region", "us-east-1"),
		attr("k8s.cluster.name", CLUSTER),
		attr("k8s.namespace.name", "shop"),
		attr("k8s.deployment.name", service.name),
		attr("k8s.pod.name", pod),
		attr("k8s.node.name", node),
	],
})

// ── output ──────────────────────────────────────────────────────────────────

export interface Grouped<T> {
	readonly resource: Resource
	readonly items: T[]
}

interface RequestAgg {
	readonly resource: Resource
	readonly minute: number
	readonly method: string
	readonly route: string
	readonly status: number
	readonly durationsMs: number[]
}

export interface WindowOutput {
	readonly spans: ReadonlyArray<Grouped<Span>>
	readonly logs: ReadonlyArray<Grouped<LogRecord>>
	readonly metrics: ReadonlyArray<Grouped<Metric>>
	readonly traceCount: number
	readonly errorTraceCount: number
}

class Sink {
	readonly spans = new Map<string, Grouped<Span>>()
	readonly logs = new Map<string, Grouped<LogRecord>>()
	readonly requests = new Map<string, RequestAgg>()
	readonly orders = new Map<string, { resource: Resource; minute: number; count: number }>()

	span(resource: Resource, span: Span) {
		group(this.spans, resource).items.push(span)
	}

	log(resource: Resource, record: LogRecord) {
		group(this.logs, resource).items.push(record)
	}

	request(
		resource: Resource,
		at: number,
		method: string,
		route: string,
		status: number,
		durationMs: number,
	) {
		const minute = Math.floor(at / MINUTE) * MINUTE
		const key = `${resource.key}|${minute}|${method}|${route}|${status}`
		const agg = this.requests.get(key) ?? { resource, minute, method, route, status, durationsMs: [] }
		agg.durationsMs.push(durationMs)
		this.requests.set(key, agg)
	}

	order(resource: Resource, at: number) {
		const minute = Math.floor(at / MINUTE) * MINUTE
		const key = `${resource.key}|${minute}`
		const agg = this.orders.get(key) ?? { resource, minute, count: 0 }
		agg.count += 1
		this.orders.set(key, agg)
	}
}

const group = <T>(map: Map<string, Grouped<T>>, resource: Resource): Grouped<T> => {
	const existing = map.get(resource.key)
	if (existing) return existing
	const created: Grouped<T> = { resource, items: [] }
	map.set(resource.key, created)
	return created
}

// ── trace construction ──────────────────────────────────────────────────────

interface Parent {
	readonly spanId: string
	readonly resource: Resource
}

interface Failed {
	readonly failure: Failure
	readonly service: string
}

interface Result {
	readonly end: number
	readonly failed: Failed | null
}

const exceptionEvent = (at: number, failure: Failure): SpanEvent => ({
	timeUnixNano: nano(at),
	name: "exception",
	attributes: [
		attr("exception.type", failure.type),
		attr("exception.message", failure.message),
		attr("exception.stacktrace", failure.stacktrace),
	],
})

const fillRoute = (route: string, rng: Rng) =>
	route
		.replace("{id}", String(rng.int(10_000, 99_999)))
		.replace("{sku}", `SKU-${rng.int(1000, 9999)}`)
		.replace("[id]", `ord_${rng.hex(4)}`)
		.replace(
			"[slug]",
			rng.pick(["linen-overshirt", "trail-runner-2", "canvas-tote", "merino-beanie", "field-watch"]),
		)

/**
 * What a server or consumer span records when a call beneath it failed: the same
 * exception if it was thrown in this service, otherwise its own UpstreamError
 * naming the callee, the way a real handler wraps a failed downstream call.
 */
const recordedFailure = (service: string, failed: Failed | null): Failure | null => {
	if (failed === null) return null
	if (failed.service === service) return failed.failure
	const message = `${failed.service} returned 500`
	return {
		type: "UpstreamError",
		message,
		stacktrace: [
			`UpstreamError: ${message}`,
			"    at callService (/app/src/lib/upstream.ts:41:13)",
			"    at async handle (/app/src/server/handler.ts:27:20)",
		].join("\n"),
	}
}

const consumerStatus = (
	service: string,
	failed: Failed | null,
	at: number,
): Pick<Span, "events" | "status"> => {
	const recorded = recordedFailure(service, failed)
	return recorded
		? {
				events: [exceptionEvent(at, recorded)],
				status: { code: StatusCode.error, message: recorded.message },
			}
		: { status: { code: StatusCode.unset } }
}

class TraceBuilder {
	private readonly traceId: string
	private readonly ctx: Ctx

	constructor(
		private readonly world: World,
		private readonly sink: Sink,
		private readonly rng: Rng,
		at: number,
	) {
		this.traceId = rng.hex(16)
		this.ctx = { at, incident: at >= world.incidentAt, rng }
	}

	run(entry: Op): Result {
		if (entry.kind !== "server") return { end: this.ctx.at, failed: null }
		const resource = this.world.resource(entry.service, this.ctx.at, this.rng)
		return this.server(entry, resource, undefined, this.ctx.at)
	}

	private op(op: Op, parent: Parent, start: number): Result {
		switch (op.kind) {
			case "server":
				return this.remote(op, parent, start)
			case "db":
				return this.db(op, parent, start)
			case "external":
				return this.external(op, parent, start)
			case "internal":
				return this.internal(op, parent, start)
			case "publish":
				return this.publish(op.topic, op.consumer, parent, start)
		}
	}

	private children(children: ReadonlyArray<Op>, parent: Parent, start: number): Result {
		let cursor = start
		for (const child of children) {
			const result = this.op(child, parent, cursor + this.rng.next() * 0.4)
			cursor = result.end
			if (result.failed) return { end: cursor, failed: result.failed }
		}
		return { end: cursor, failed: null }
	}

	private server(
		op: Extract<Op, { kind: "server" }>,
		resource: Resource,
		parentSpanId: string | undefined,
		start: number,
	): Result {
		const spanId = this.rng.hex(8)
		const self = this.rng.latency(...op.self(this.ctx))
		const inner = this.children(op.children, { spanId, resource }, start + self * 0.4)
		const own = inner.failed ? null : (op.fail?.(this.ctx) ?? null)
		const end = inner.end + self * 0.6
		const failed: Failed | null = own ? { failure: own, service: op.service } : inner.failed
		const recorded = own ?? recordedFailure(op.service, inner.failed)
		const status = failed ? 500 : 200
		const path = fillRoute(op.route, this.rng)

		this.sink.span(resource, {
			traceId: this.traceId,
			spanId,
			parentSpanId,
			name: `${op.method} ${op.route}`,
			kind: SpanKind.server,
			startTimeUnixNano: nano(start),
			endTimeUnixNano: nano(end),
			attributes: [
				attr("http.request.method", op.method),
				attr("http.route", op.route),
				attr("url.path", path),
				attr("url.scheme", "http"),
				attr("http.response.status_code", status),
				attr("server.address", `${op.service}.shop.svc.cluster.local`),
				attr("network.protocol.version", "1.1"),
				...(recorded ? [attr("error.type", recorded.type)] : []),
			],
			events: recorded ? [exceptionEvent(end, recorded)] : undefined,
			status: recorded
				? { code: StatusCode.error, message: recorded.message }
				: { code: StatusCode.unset },
		})
		this.sink.request(resource, start, op.method, op.route, status, end - start)

		const duration = Math.round(end - start)
		const ids = { traceId: this.traceId, spanId }
		// A failure bubbling up inside one service was already logged where it was thrown.
		if (recorded && recorded !== inner.failed?.failure) {
			this.log(resource, end, "ERROR", `${recorded.type}: ${recorded.message}`, ids, [
				attr("http.route", op.route),
				attr("exception.type", recorded.type),
				attr("exception.message", recorded.message),
			])
		} else if (failed) {
			// Logged at the throw site.
		} else if (duration > 2000) {
			this.log(resource, end, "WARN", `slow request ${op.method} ${path} took ${duration}ms`, ids, [
				attr("http.route", op.route),
				attr("duration_ms", duration),
			])
		} else if (this.rng.chance(0.55)) {
			this.log(resource, end, "INFO", `${op.method} ${path} ${status} ${duration}ms`, ids, [
				attr("http.route", op.route),
				attr("http.response.status_code", status),
				attr("duration_ms", duration),
			])
		}
		return { end, failed }
	}

	private remote(op: Extract<Op, { kind: "server" }>, parent: Parent, start: number): Result {
		const spanId = this.rng.hex(8)
		const target = this.world.resource(op.service, start, this.rng)
		const served = this.server(op, target, spanId, start + this.networkHop())
		const end = served.end + this.networkHop()
		const status = served.failed ? 500 : 200
		this.sink.span(parent.resource, {
			traceId: this.traceId,
			spanId,
			parentSpanId: parent.spanId,
			name: `${op.method} ${op.route}`,
			kind: SpanKind.client,
			startTimeUnixNano: nano(start),
			endTimeUnixNano: nano(end),
			attributes: [
				attr("http.request.method", op.method),
				attr("url.template", op.route),
				attr(
					"url.full",
					`http://${op.service}.shop.svc.cluster.local:8080${fillRoute(op.route, this.rng)}`,
				),
				attr("server.address", `${op.service}.shop.svc.cluster.local`),
				attr("server.port", 8080),
				attr("peer.service", op.service),
				attr("http.response.status_code", status),
			],
			// The callee's server span and the caller's own UpstreamError carry the failure;
			// erroring the client span too would add a third, exception-less issue per hop.
			status: { code: StatusCode.unset },
		})
		return { end, failed: served.failed ? { failure: served.failed.failure, service: op.service } : null }
	}

	/** At least 1ms, so a child still fits its parent once the UI truncates timestamps to ms. */
	private networkHop(): number {
		return 1 + this.rng.latency(0.6, 0.4)
	}

	private db(op: Extract<Op, { kind: "db" }>, parent: Parent, start: number): Result {
		const repeat = op.repeat?.(this.ctx) ?? 1
		const isPostgres = op.system === "postgresql"
		let cursor = start
		for (let i = 0; i < repeat; i++) {
			const failure = op.fail?.(this.ctx) ?? null
			const begin = cursor + this.rng.next() * 0.2
			const end = begin + (failure?.durationMs ?? this.rng.latency(...op.latency(this.ctx)))
			const spanId = this.rng.hex(8)
			this.sink.span(parent.resource, {
				traceId: this.traceId,
				spanId,
				parentSpanId: parent.spanId,
				name: isPostgres ? `${op.operation} ${op.namespace}.${op.collection}` : op.operation,
				kind: SpanKind.client,
				startTimeUnixNano: nano(begin),
				endTimeUnixNano: nano(end),
				attributes: [
					attr("db.system.name", op.system),
					attr("db.system", op.system),
					attr("db.namespace", op.namespace),
					attr("db.operation.name", op.operation),
					...(op.collection ? [attr("db.collection.name", op.collection)] : []),
					attr("db.query.text", op.statement),
					attr("db.statement", op.statement),
					attr(
						"server.address",
						isPostgres ? "orders-db.shop.svc.cluster.local" : "redis.shop.svc.cluster.local",
					),
					attr("server.port", isPostgres ? 5432 : 6379),
					...(failure ? [attr("error.type", failure.type)] : []),
				],
				events: failure ? [exceptionEvent(end, failure)] : undefined,
				status: failure
					? { code: StatusCode.error, message: failure.message }
					: { code: StatusCode.unset },
			})
			cursor = end
			if (failure) {
				this.failureLog(parent.resource, end, failure, spanId)
				return { end, failed: { failure, service: parent.resource.service.name } }
			}
		}
		return { end: cursor, failed: null }
	}

	private external(op: Extract<Op, { kind: "external" }>, parent: Parent, start: number): Result {
		const failure = op.fail?.(this.ctx) ?? null
		const end = start + (failure?.durationMs ?? this.rng.latency(...op.latency(this.ctx)))
		const spanId = this.rng.hex(8)
		this.sink.span(parent.resource, {
			traceId: this.traceId,
			spanId,
			parentSpanId: parent.spanId,
			name: `${op.method} ${op.host}`,
			kind: SpanKind.client,
			startTimeUnixNano: nano(start),
			endTimeUnixNano: nano(end),
			attributes: [
				attr("http.request.method", op.method),
				attr("url.full", `https://${op.host}${op.path}`),
				attr("server.address", op.host),
				attr("server.port", 443),
				...(failure ? [attr("error.type", failure.type)] : [attr("http.response.status_code", 200)]),
			],
			events: failure ? [exceptionEvent(end, failure)] : undefined,
			status: failure
				? { code: StatusCode.error, message: failure.message }
				: { code: StatusCode.unset },
		})
		if (failure) {
			this.failureLog(parent.resource, end, failure, spanId)
			return { end, failed: { failure, service: parent.resource.service.name } }
		}
		return { end, failed: null }
	}

	private internal(op: Extract<Op, { kind: "internal" }>, parent: Parent, start: number): Result {
		const spanId = this.rng.hex(8)
		const self = this.rng.latency(...op.self(this.ctx))
		const inner = this.children(op.children, { spanId, resource: parent.resource }, start + self * 0.5)
		const end = inner.end + self * 0.5
		this.sink.span(parent.resource, {
			traceId: this.traceId,
			spanId,
			parentSpanId: parent.spanId,
			name: op.name,
			kind: SpanKind.internal,
			startTimeUnixNano: nano(start),
			endTimeUnixNano: nano(end),
			attributes: [],
			status: inner.failed ? { code: StatusCode.error } : { code: StatusCode.unset },
		})
		return { end, failed: inner.failed }
	}

	/** The producer span ends the caller's work; the consumer runs later and never fails its caller. */
	private publish(topic: string, consumer: Consumer, parent: Parent, start: number): Result {
		const spanId = this.rng.hex(8)
		const end = start + this.rng.latency(1.8, 0.3)
		this.sink.span(parent.resource, {
			traceId: this.traceId,
			spanId,
			parentSpanId: parent.spanId,
			name: `publish ${topic}`,
			kind: SpanKind.producer,
			startTimeUnixNano: nano(start),
			endTimeUnixNano: nano(end),
			attributes: [
				attr("messaging.system", "kafka"),
				attr("messaging.destination.name", topic),
				attr("messaging.operation.type", "send"),
				attr("messaging.operation.name", "publish"),
				attr("server.address", "kafka.shop.svc.cluster.local"),
			],
			status: { code: StatusCode.unset },
		})

		const begin = end + this.rng.latency(60, 0.8)
		const resource = this.world.resource(consumer.service, begin, this.rng)
		const consumerSpanId = this.rng.hex(8)
		const self = this.rng.latency(...consumer.self(this.ctx))
		const inner = this.children(
			consumer.children,
			{ spanId: consumerSpanId, resource },
			begin + self * 0.4,
		)
		const consumed = inner.end + self * 0.6
		const partition = this.rng.int(0, 5)
		this.sink.span(resource, {
			traceId: this.traceId,
			spanId: consumerSpanId,
			parentSpanId: spanId,
			name: `process ${consumer.topic}`,
			kind: SpanKind.consumer,
			startTimeUnixNano: nano(begin),
			endTimeUnixNano: nano(consumed),
			attributes: [
				attr("messaging.system", "kafka"),
				attr("messaging.destination.name", consumer.topic),
				attr("messaging.operation.type", "process"),
				attr("messaging.consumer.group.name", consumer.service),
				attr("messaging.destination.partition.id", String(partition)),
			],
			...consumerStatus(consumer.service, inner.failed, consumed),
		})
		if (!inner.failed) {
			this.sink.order(resource, begin)
			const items = this.rng.int(1, 4)
			this.log(
				resource,
				consumed,
				"INFO",
				`order ord_${this.rng.hex(4)} created: ${items} item${items > 1 ? "s" : ""}, $${this.rng.int(18, 240)}.${this.rng.int(10, 99)}`,
				{ traceId: this.traceId, spanId: consumerSpanId },
				[attr("messaging.destination.partition.id", String(partition))],
			)
		}
		return { end, failed: null }
	}

	private failureLog(resource: Resource, at: number, failure: Failure, spanId: string) {
		const message = failure.logPrefix
			? `${failure.logPrefix} for order ord_${this.rng.hex(4)}: ${failure.message}`
			: `${failure.type}: ${failure.message}`
		this.log(resource, at, "ERROR", message, { traceId: this.traceId, spanId }, [
			attr("exception.type", failure.type),
			attr("exception.message", failure.message),
		])
	}

	private log(
		resource: Resource,
		at: number,
		severity: SeverityText,
		body: string,
		ids: { traceId: string; spanId: string } | null,
		attributes: ReadonlyArray<KeyValue>,
	) {
		this.sink.log(resource, logRecord(at, severity, body, ids, attributes))
	}
}

const logRecord = (
	at: number,
	severity: SeverityText,
	body: string,
	ids: { traceId: string; spanId: string } | null,
	attributes: ReadonlyArray<KeyValue>,
): LogRecord => ({
	timeUnixNano: nano(at),
	observedTimeUnixNano: nano(at + 3),
	severityNumber: Severity[severity],
	severityText: severity,
	body: { stringValue: body },
	attributes,
	traceId: ids?.traceId,
	spanId: ids?.spanId,
})

// ── windows ─────────────────────────────────────────────────────────────────

/** Generate everything that happened in `[from, to)`. Call windows in order: the RNG is shared. */
export const generateWindow = (world: World, rng: Rng, from: number, to: number): WindowOutput => {
	const sink = new Sink()
	let traceCount = 0
	let errorTraceCount = 0

	for (let minute = from; minute < to; minute += MINUTE) {
		const rate = traceRate(minute, world.options.peakTracesPerMinute)
		const count = Math.max(0, Math.round(rate * (0.85 + 0.3 * rng.next())))
		const starts = Array.from({ length: count }, () => minute + rng.next() * MINUTE).sort((a, b) => a - b)
		for (const at of starts) {
			const result = new TraceBuilder(world, sink, rng, at).run(rng.weighted(ENTRY_POINTS))
			traceCount++
			if (result.failed) errorTraceCount++
		}
		backgroundLogs(world, sink, rng, minute)
	}

	return {
		spans: [...sink.spans.values()],
		logs: [...sink.logs.values()],
		metrics: buildMetrics(world, sink, rng, from, to),
		traceCount,
		errorTraceCount,
	}
}

/** Log lines that belong to no request: pool pressure, consumer lag, sync jobs. */
const backgroundLogs = (world: World, sink: Sink, rng: Rng, minute: number) => {
	const at = (offset: number) => minute + offset + rng.next() * 900
	if (minute >= world.incidentAt) {
		for (const offset of [0, 15_000, 30_000, 45_000]) {
			const resource = world.resource(INCIDENT.service, minute, rng)
			const waiting = rng.int(24, 48)
			sink.log(
				resource,
				logRecord(
					at(offset),
					"WARN",
					`pool exhausted: ${INCIDENT.poolSize}/${INCIDENT.poolSize} connections in use, ${waiting} waiting`,
					null,
					[
						attr("db.client.connection.pool.name", "payments"),
						attr("db.client.connection.pending_requests", waiting),
					],
				),
			)
		}
	}
	const worker = world.resource("order-worker", minute, rng)
	const partition = rng.int(0, 5)
	sink.log(
		worker,
		logRecord(at(0), "DEBUG", `consumer lag orders.created[${partition}]: ${rng.int(0, 14)}`, null, [
			attr("messaging.destination.partition.id", String(partition)),
		]),
	)
	if (Math.floor(minute / MINUTE) % 5 === 0) {
		const inventory = world.resource("inventory-svc", minute, rng)
		sink.log(
			inventory,
			logRecord(
				at(20_000),
				"INFO",
				`stock sync complete: ${rng.int(180, 420)} skus updated in ${rng.int(300, 900)}ms`,
				null,
				[],
			),
		)
	}
}

// ── metrics ─────────────────────────────────────────────────────────────────

const histogramPoint = (
	minute: number,
	durationsMs: ReadonlyArray<number>,
	attributes: ReadonlyArray<KeyValue>,
): HistogramPoint => {
	const seconds = durationsMs.map((ms) => ms / 1000)
	const counts = LATENCY_BOUNDS_S.map(() => 0).concat(0)
	for (const value of seconds) {
		const bucket = LATENCY_BOUNDS_S.findIndex((bound) => value <= bound)
		const index = bucket === -1 ? LATENCY_BOUNDS_S.length : bucket
		counts[index] = (counts[index] ?? 0) + 1
	}
	return {
		startTimeUnixNano: nano(minute),
		timeUnixNano: nano(minute + MINUTE),
		attributes,
		count: String(seconds.length),
		sum: seconds.reduce((total, value) => total + value, 0),
		min: Math.min(...seconds),
		max: Math.max(...seconds),
		bucketCounts: counts.map(String),
		explicitBounds: LATENCY_BOUNDS_S,
	}
}

const buildMetrics = (
	world: World,
	sink: Sink,
	rng: Rng,
	from: number,
	to: number,
): ReadonlyArray<Grouped<Metric>> => {
	const byResource = new Map<string, { resource: Resource; metrics: Metric[] }>()
	const add = (resource: Resource, metric: Metric) => {
		const entry = byResource.get(resource.key) ?? { resource, metrics: [] }
		entry.metrics.push(metric)
		byResource.set(resource.key, entry)
	}

	// Request duration, straight from the server spans, so charts and traces agree.
	const histograms = new Map<string, { resource: Resource; points: HistogramPoint[] }>()
	const requestsPerMinute = new Map<string, number>()
	for (const agg of sink.requests.values()) {
		const entry = histograms.get(agg.resource.key) ?? { resource: agg.resource, points: [] }
		entry.points.push(
			histogramPoint(agg.minute, agg.durationsMs, [
				attr("http.request.method", agg.method),
				attr("http.route", agg.route),
				attr("http.response.status_code", agg.status),
			]),
		)
		histograms.set(agg.resource.key, entry)
		const load = `${agg.resource.key}|${agg.minute}`
		requestsPerMinute.set(load, (requestsPerMinute.get(load) ?? 0) + agg.durationsMs.length)
	}
	for (const { resource, points } of histograms.values()) {
		add(resource, deltaHistogram("http.server.request.duration", "s", points))
	}

	// Process gauges for every pod that was live, scaled by the load it served.
	for (const resource of world.allResources()) {
		const cpu: NumberPoint[] = []
		const memory: NumberPoint[] = []
		for (let minute = from; minute < to; minute += MINUTE) {
			const load = requestsPerMinute.get(`${resource.key}|${minute}`)
			if (load === undefined) continue
			const time = nano(minute + MINUTE)
			cpu.push({
				timeUnixNano: time,
				attributes: [],
				asDouble: Math.min(0.95, 0.04 + load * 0.012 + rng.next() * 0.03),
			})
			const baseMb =
				resource.service.language === "go" ? 48 : resource.service.language === "python" ? 160 : 210
			memory.push({
				timeUnixNano: time,
				attributes: [],
				asInt: Math.round((baseMb + load * 0.8 + rng.next() * 12) * 1_048_576),
			})
		}
		if (cpu.length === 0) continue
		add(resource, gauge("process.cpu.utilization", "1", cpu))
		add(resource, gauge("process.memory.usage", "By", memory))
	}

	// The payment pool: a few connections in use until 3.5.0 pins it at the limit.
	for (const resource of world.allResources().filter((r) => r.service.name === INCIDENT.service)) {
		const points: NumberPoint[] = []
		const pending: NumberPoint[] = []
		for (let minute = from; minute < to; minute += MINUTE) {
			const load = requestsPerMinute.get(`${resource.key}|${minute}`)
			if (load === undefined) continue
			const exhausted = resource.version === INCIDENT.version
			const used = exhausted
				? INCIDENT.poolSize
				: Math.min(INCIDENT.poolSize - 4, 2 + Math.round(load * 0.35 + rng.next() * 2))
			const time = nano(minute + MINUTE)
			const pool = attr("db.client.connection.pool.name", "payments")
			points.push({
				timeUnixNano: time,
				attributes: [pool, attr("db.client.connection.state", "used")],
				asInt: used,
			})
			points.push({
				timeUnixNano: time,
				attributes: [pool, attr("db.client.connection.state", "idle")],
				asInt: INCIDENT.poolSize - used,
			})
			pending.push({ timeUnixNano: time, attributes: [pool], asInt: exhausted ? rng.int(24, 48) : 0 })
		}
		if (points.length === 0) continue
		add(resource, gauge("db.client.connection.count", "{connection}", points))
		add(resource, gauge("db.client.connection.pending_requests", "{request}", pending))
	}

	// The business number dashboards put next to error rate.
	const orders = new Map<string, { resource: Resource; points: NumberPoint[] }>()
	for (const agg of sink.orders.values()) {
		const entry = orders.get(agg.resource.key) ?? { resource: agg.resource, points: [] }
		entry.points.push({
			startTimeUnixNano: nano(agg.minute),
			timeUnixNano: nano(agg.minute + MINUTE),
			attributes: [],
			asInt: agg.count,
		})
		orders.set(agg.resource.key, entry)
	}
	for (const { resource, points } of orders.values())
		add(resource, deltaSum("shop.orders.created", "{order}", points))

	return [...byResource.values()].map(({ resource, metrics }) => ({ resource, items: metrics }))
}

// OTLP/JSON export bodies shaped like a small instrumented HTTP service: a
// resource with the usual service attributes and records carrying a handful of
// semconv attributes. Timestamps are "now" so the raw-table TTL keeps every row.

export type Signal = "traces" | "logs" | "metrics"

const hex = (bytes: number): string =>
	Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("hex")

const str = (key: string, value: string) => ({ key, value: { stringValue: value } })
const int = (key: string, value: number) => ({ key, value: { intValue: String(value) } })

const resource = (service: string) => ({
	attributes: [
		str("service.name", service),
		str("service.version", "1.4.2"),
		str("deployment.environment.name", "development"),
		str("telemetry.sdk.language", "nodejs"),
		str("host.name", "bench-host"),
	],
})

const ROUTES = ["/api/users", "/api/orders", "/api/orders/:id", "/health", "/api/search"]

const spans = (count: number, nowNanos: bigint) => {
	const traceId = hex(16)
	const rootId = hex(8)
	return Array.from({ length: count }, (_, i) => {
		const route = ROUTES[i % ROUTES.length]
		const failed = i % 20 === 19
		const start = nowNanos - BigInt(5_000_000 + i * 1_000)
		return {
			traceId,
			spanId: i === 0 ? rootId : hex(8),
			parentSpanId: i === 0 ? "" : rootId,
			name: i === 0 ? `GET ${route}` : `SELECT orders`,
			kind: i === 0 ? 2 : 3,
			startTimeUnixNano: String(start),
			endTimeUnixNano: String(start + BigInt(1_000_000 + (i % 7) * 250_000)),
			attributes:
				i === 0
					? [
							str("http.request.method", "GET"),
							str("http.route", route),
							str("url.path", route),
							int("http.response.status_code", failed ? 500 : 200),
							str("server.address", "localhost"),
						]
					: [
							str("db.system.name", "postgresql"),
							str("db.namespace", "app"),
							str("db.query.text", "SELECT * FROM orders WHERE id = $1"),
							str("server.address", "db.internal"),
						],
			status: failed ? { code: 2, message: "boom" } : { code: 0 },
		}
	})
}

const logRecords = (count: number, nowNanos: bigint) => {
	const traceId = hex(16)
	return Array.from({ length: count }, (_, i) => ({
		timeUnixNano: String(nowNanos - BigInt(i * 1_000)),
		observedTimeUnixNano: String(nowNanos),
		severityNumber: i % 10 === 9 ? 17 : 9,
		severityText: i % 10 === 9 ? "ERROR" : "INFO",
		body: { stringValue: `handled request ${i} for ${ROUTES[i % ROUTES.length]}` },
		attributes: [str("http.route", ROUTES[i % ROUTES.length]), int("attempt", i % 3)],
		traceId,
		spanId: hex(8),
	}))
}

// `count` data points spread over sum, gauge and histogram metrics.
const metrics = (count: number, nowNanos: bigint) => {
	const start = String(nowNanos - 60_000_000_000n)
	const time = String(nowNanos)
	const points = (n: number, make: (i: number) => Record<string, unknown>) =>
		Array.from({ length: n }, (_, i) => ({
			startTimeUnixNano: start,
			timeUnixNano: time,
			attributes: [str("http.route", ROUTES[i % ROUTES.length])],
			...make(i),
		}))
	if (count < 3)
		return [
			{
				name: "process.memory.usage",
				gauge: { dataPoints: points(count, (i) => ({ asDouble: 1e6 + i })) },
			},
		]
	const third = Math.floor(count / 3)
	const rest = count - 2 * third
	return [
		{
			name: "http.server.request.count",
			sum: {
				aggregationTemporality: 2,
				isMonotonic: true,
				dataPoints: points(third, (i) => ({ asInt: String(i) })),
			},
		},
		{
			name: "process.memory.usage",
			gauge: { dataPoints: points(third, (i) => ({ asDouble: 1e6 + i })) },
		},
		{
			name: "http.server.request.duration",
			histogram: {
				aggregationTemporality: 2,
				dataPoints: points(rest, (i) => ({
					count: "4",
					sum: 0.4 + i,
					bucketCounts: ["1", "2", "1", "0"],
					explicitBounds: [0.05, 0.1, 0.5],
				})),
			},
		},
	]
}

/** One OTLP/JSON export body carrying `count` records of `signal`. */
export const exportBody = (signal: Signal, count: number, service = "bench-api"): string => {
	const now = BigInt(Date.now()) * 1_000_000n
	const scope = { name: "maple-bench", version: "1.0.0" }
	switch (signal) {
		case "traces":
			return JSON.stringify({
				resourceSpans: [
					{ resource: resource(service), scopeSpans: [{ scope, spans: spans(count, now) }] },
				],
			})
		case "logs":
			return JSON.stringify({
				resourceLogs: [
					{
						resource: resource(service),
						scopeLogs: [{ scope, logRecords: logRecords(count, now) }],
					},
				],
			})
		case "metrics":
			return JSON.stringify({
				resourceMetrics: [
					{ resource: resource(service), scopeMetrics: [{ scope, metrics: metrics(count, now) }] },
				],
			})
	}
}

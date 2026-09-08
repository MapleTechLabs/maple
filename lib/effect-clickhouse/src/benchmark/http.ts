import { createHash, randomUUID } from "node:crypto"
import { Clock, Config, Effect, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { escapeClickHouseString } from "../sql/index"
import { BenchmarkError, canonicalJson, metricNumber, type RunOutput } from "./model"
import type { BenchmarkTransport, LogMetrics } from "./runner"

export interface HttpConfig {
	readonly url: string
	readonly user?: string
	readonly password?: string
	readonly database?: string
}

export const httpConfigFromEnv = Config.all({
	url: Config.string("CLICKHOUSE_URL"),
	user: Config.string("CLICKHOUSE_USER").pipe(Config.withDefault("default")),
	password: Config.redacted("CLICKHOUSE_PASSWORD").pipe(Config.withDefault(Redacted.make(""))),
	database: Config.string("CLICKHOUSE_DATABASE").pipe(Config.withDefault("default")),
}).pipe(Effect.map((config): HttpConfig => ({ ...config, password: Redacted.value(config.password) })))

export const decodeJson = <A>(text: string, schema: Schema.Decoder<A>) =>
	Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(schema)),
		Effect.mapError((cause) => new BenchmarkError({ message: String(cause) })),
	)
export const decodeJsonLines = (text: string) =>
	Effect.forEach(text.trim() ? text.trim().split("\n") : [], (line) =>
		decodeJson(line, Schema.Record(Schema.String, Schema.Unknown)),
	)

/** Owns one HTTP request, including body consumption and cancellation. */
export const makeHttpClient = (config: HttpConfig) => {
	const endpoint = Effect.try({
		try: () => new URL(config.url),
		catch: () => new BenchmarkError({ message: "CLICKHOUSE_URL must be an HTTP(S) URL." }),
	}).pipe(
		Effect.flatMap((url) =>
			!["http:", "https:"].includes(url.protocol) ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
				? Effect.fail(
						new BenchmarkError({
							message:
								"Use an HTTP(S) endpoint without credentials, query parameters, or fragments; supply credentials separately.",
						}),
					)
				: Effect.succeed(url),
		),
	)
	const run = (sql: string, timeoutMs = 35_000) =>
		Effect.gen(function* () {
			const base = yield* endpoint
			const url = new URL(base)
			const queryId = randomUUID()
			url.searchParams.set("database", config.database ?? "default")
			url.searchParams.set("query_id", queryId)
			url.searchParams.set("wait_end_of_query", "1")
			url.searchParams.set("readonly", "2")
			url.searchParams.set("log_queries", "0")
			return yield* Effect.gen(function* () {
				const http = yield* HttpClient.HttpClient
				const start = performance.now()
				const response = yield* http.execute(
					HttpClientRequest.post(url, {
						headers: {
							Authorization: `Basic ${Buffer.from(`${config.user ?? "default"}:${config.password ?? ""}`).toString("base64")}`,
							"Content-Type": "text/plain; charset=utf-8",
						},
					}).pipe(HttpClientRequest.bodyText(sql)),
				)
				const body = yield* response.text
				return {
					status: response.status,
					body,
					queryId,
					wallMs: performance.now() - start,
					summaryHeader: response.headers["x-clickhouse-summary"] ?? null,
				}
			}).pipe(
				Effect.mapError(
					() =>
						new BenchmarkError({
							queryId,
							message:
								"ClickHouse HTTP request failed. Check connectivity, TLS, and the endpoint.",
						}),
				),
				Effect.timeout(timeoutMs),
				Effect.catchTag("TimeoutError", () =>
					Effect.fail(
						new BenchmarkError({
							queryId,
							message: "ClickHouse request timed out, including response body.",
						}),
					),
				),
				Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
				// This adapter owns the fetch driver; layer construction is outside the measured interval.
				// oxlint-disable-next-line effecttsgo/strict-effect-provide
				Effect.provide(FetchHttpClient.layer),
			)
		})
	const query = (sql: string, timeoutMs?: number) =>
		run(sql, timeoutMs).pipe(
			Effect.flatMap((result) =>
				result.status === 200
					? Effect.succeed(result)
					: Effect.fail(
							new BenchmarkError({
								queryId: result.queryId,
								message: `ClickHouse ${result.status}: ${result.body.slice(0, 1000)}`,
							}),
						),
			),
		)
	const metadata = query(
		"SELECT version() AS version, currentDatabase() AS database FORMAT JSONEachRow",
	).pipe(
		Effect.flatMap((r) =>
			decodeJson(r.body, Schema.Struct({ version: Schema.String, database: Schema.String })),
		),
	)
	const tables = query(
		"SELECT name, engine, sorting_key, primary_key, partition_key, total_rows, total_bytes, create_table_query FROM system.tables WHERE database = currentDatabase() ORDER BY name FORMAT JSONEachRow",
	).pipe(Effect.flatMap((r) => decodeJsonLines(r.body)))
	const target = endpoint.pipe(Effect.map((url) => url.origin + (url.pathname === "/" ? "" : url.pathname)))
	const collectLogs = (queryIds: ReadonlyArray<string>, waitSeconds: number, cluster?: string) =>
		Effect.gen(function* () {
			const entries = new Map<string, LogMetrics>()
			const warnings: string[] = []
			const deadline = (yield* Clock.currentTimeMillis) + waitSeconds * 1000
			if (!queryIds.length) return { entries: [], warnings }
			while (true) {
				const pending = queryIds.filter((id) => !entries.has(id))
				for (let offset = 0; offset < pending.length; offset += 100) {
					const ids = pending
						.slice(offset, offset + 100)
						.map((id) => `'${escapeClickHouseString(id)}'`)
						.join(",")
					const table = cluster
						? `clusterAllReplicas('${escapeClickHouseString(cluster)}', system.query_log)`
						: "system.query_log"
					const result = yield* query(
						`SELECT query_id, memory_usage, query_duration_ms, read_rows, read_bytes, result_rows, ProfileEvents FROM ${table} WHERE event_date >= today() - 1 AND is_initial_query = 1 AND type = 'QueryFinish' AND query_id IN (${ids}) ORDER BY event_time_microseconds DESC LIMIT 1 BY query_id FORMAT JSONEachRow`,
					).pipe(
						Effect.flatMap((r) => decodeJsonLines(r.body)),
						Effect.result,
					)
					if (result._tag === "Failure") {
						warnings.push(
							"system.query_log unavailable; summary metrics retained. Check log permissions and cluster configuration.",
						)
						return { entries: [...entries.values()], warnings }
					}
					for (const row of result.success) {
						if (typeof row.query_id !== "string" || !queryIds.includes(row.query_id)) continue
						const profileEvents: Record<string, number> = {}
						if (typeof row.ProfileEvents === "object" && row.ProfileEvents !== null)
							for (const [key, value] of Object.entries(row.ProfileEvents)) {
								const n = metricNumber(value)
								if (n !== null) profileEvents[key] = n
							}
						entries.set(row.query_id, {
							queryId: row.query_id,
							memoryUsage: metricNumber(row.memory_usage),
							serverElapsedMs: metricNumber(row.query_duration_ms),
							readRows: metricNumber(row.read_rows),
							readBytes: metricNumber(row.read_bytes),
							resultRows: metricNumber(row.result_rows),
							profileEvents,
						})
					}
				}
				const remaining = deadline - (yield* Clock.currentTimeMillis)
				if (entries.size === queryIds.length || remaining <= 0) break
				yield* Effect.sleep(Math.min(1000, remaining))
			}
			return { entries: [...entries.values()], warnings }
		})
	return { run, query, metadata, tables, target, collectLogs }
}

export const makeHttpTransport = (
	client: ReturnType<typeof makeHttpClient>,
	options: {
		readonly timeoutSeconds: number
		readonly logWaitSeconds: number
		readonly cluster?: string
		readonly verifyResults: boolean
		readonly resultOrder: RunOutput["resultOrder"]
	},
): BenchmarkTransport => ({
	execute: (sql, results) =>
		Effect.gen(function* () {
			const response = yield* client.query(sql, options.timeoutSeconds * 1000 + 5000)
			const summary =
				response.summaryHeader === null
					? {}
					: yield* decodeJson(
							response.summaryHeader,
							Schema.Record(Schema.String, Schema.Unknown),
						).pipe(Effect.orElseSucceed(() => ({})))
			let resultHash: string | undefined
			if (results !== "skip" && (results !== undefined || options.verifyResults)) {
				const rows = yield* decodeJsonLines(response.body)
				const canonical = rows.map(canonicalJson)
				if ((results ?? options.resultOrder) === "unordered") canonical.sort()
				resultHash = createHash("sha256").update(canonical.join("\n")).digest("hex")
			}
			return { queryId: response.queryId, wallMs: response.wallMs, summary, resultHash }
		}),
	collectLogs: (ids) => client.collectLogs(ids, options.logWaitSeconds, options.cluster),
})

import { assert, describe, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Redacted, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import {
	make,
	ClickHouseClient,
	ClickHouseConfigError,
	ClickHouseLimitError,
	ClickHouseProtocolError,
	ClickHouseRedirectError,
	ClickHouseServerError,
	ClickHouseTransportError,
} from "./index"

const config = {
	url: "https://warehouse.example/proxy/ch?custom=keep",
	username: "user",
	password: Redacted.make("päss"),
	database: "analytics",
}
const withFetch = <A, E, R>(effect: Effect.Effect<A, E, R>, request: typeof fetch) =>
	effect.pipe(Effect.provide(FetchHttpClient.layer), Effect.provideService(FetchHttpClient.Fetch, request))
const response = (body = '{"n":"42"}\n', status = 200, headers: Record<string, string> = {}) =>
	new Response(body, { status, headers })

describe("HTTP request contract", () => {
	it.effect(
		"POSTs SQL with one format, Basic UTF-8 auth, database, ID and settings through a proxy path",
		() => {
			const requests: Array<{ url: URL; init?: RequestInit }> = []
			const request: typeof fetch = async (input, init) => {
				requests.push({
					url: new URL(String(input)),
					init: { ...init, body: await new Response(init?.body).text() },
				})
				return response()
			}
			return withFetch(
				Effect.gen(function* () {
					const client = yield* make({
						...config,
						settings: { max_threads: 1, max_execution_time: 5 },
					})
					const query = client.query({
						sql: "SELECT 42 AS n -- last comment",
						queryId: "my query",
						settings: { max_threads: 2 },
					})
					assert.strictEqual(requests.length, 0)
					const result = yield* query
					assert.deepStrictEqual(result.data, [{ n: "42" }])
					assert.strictEqual(result.queryId, "my query")
					const { url, init } = requests[0]!
					assert.strictEqual(url.pathname, "/proxy/ch")
					assert.strictEqual(url.searchParams.get("custom"), "keep")
					assert.strictEqual(url.searchParams.get("database"), "analytics")
					assert.strictEqual(url.searchParams.get("query_id"), "my query")
					assert.strictEqual(url.searchParams.get("max_threads"), "2")
					assert.strictEqual(url.searchParams.get("max_execution_time"), "5")
					assert.strictEqual(url.username, "")
					assert.strictEqual(url.searchParams.has("query"), false)
					assert.strictEqual(init?.method, "POST")
					assert.strictEqual(init?.redirect, "manual")
					assert.strictEqual(init?.body, "SELECT 42 AS n -- last comment\nFORMAT JSONEachRow")
					const header = new Headers(init?.headers).get("authorization")!
					assert.strictEqual(
						new TextDecoder().decode(
							Uint8Array.from(atob(header.slice(6)), (c) => c.charCodeAt(0)),
						),
						"user:päss",
					)
				}),
				request,
			)
		},
	)
	it.effect("creates a fresh query ID on every execution of the same Effect", () => {
		const ids: string[] = []
		return withFetch(
			Effect.gen(function* () {
				const client = yield* make(config)
				const query = client.query({ sql: "SELECT 1" })
				const a = yield* query
				const b = yield* query
				assert.notStrictEqual(a.queryId, b.queryId)
				assert.deepStrictEqual(ids, [a.queryId, b.queryId])
			}),
			async (input) => {
				ids.push(new URL(String(input)).searchParams.get("query_id")!)
				return response()
			},
		)
	})
	for (const url of [
		"ftp://warehouse.example",
		"/relative",
		"not a URL",
		"https://u:p@warehouse.example",
		"https://warehouse.example/#secret",
		"https://warehouse.example/?query=SELECT+2",
		"https://warehouse.example/?password=p",
	]) {
		it.effect(`rejects ambiguous or invalid endpoint ${url}`, () =>
			withFetch(
				Effect.gen(function* () {
					assert.instanceOf(yield* Effect.flip(make({ url })), ClickHouseConfigError)
				}),
				async () => {
					assert.fail("must not fetch")
					return response()
				},
			),
		)
	}
	for (const limits of [{ maxBytes: -1 }, { maxRows: 1.5 }, { maxRowBytes: Infinity }, { maxBytes: NaN }]) {
		it.effect(`rejects invalid limits ${JSON.stringify(limits)}`, () =>
			withFetch(
				Effect.gen(function* () {
					const client = yield* make(config)
					assert.instanceOf(
						yield* Effect.flip(client.query({ sql: "SELECT 1", limits })),
						ClickHouseConfigError,
					)
				}),
				async () => {
					assert.fail("must not fetch")
					return response()
				},
			),
		)
	}
	for (const settings of [
		{ query: "DROP TABLE x" },
		{ database: "other" },
		{ max_threads: NaN },
		{ "bad-key": "1" },
	] as Array<Record<string, string | number>>) {
		it.effect(`rejects reserved or malformed settings ${JSON.stringify(settings)}`, () =>
			withFetch(
				Effect.gen(function* () {
					const client = yield* make(config)
					assert.instanceOf(
						yield* Effect.flip(client.query({ sql: "SELECT 1", settings })),
						ClickHouseConfigError,
					)
				}),
				async () => {
					assert.fail("must not fetch")
					return response()
				},
			),
		)
	}
})

describe("response errors and resource ownership", () => {
	for (const status of [301, 302, 303, 307, 308]) {
		it.effect(`rejects redirect ${status} and closes the request`, () => {
			let signal: AbortSignal | null | undefined
			return withFetch(
				Effect.gen(function* () {
					const client = yield* make(config)
					const error = yield* Effect.flip(client.query({ sql: "SELECT 1" }))
					assert.instanceOf(error, ClickHouseRedirectError)
					if (error instanceof ClickHouseRedirectError)
						assert.strictEqual(error.location, "http://internal/")
					assert.isTrue(signal?.aborted)
				}),
				async (_input, init) => {
					signal = init?.signal
					return response("", status, { location: "http://internal/" })
				},
			)
		})
	}
	for (const [status, body, headers, expectedCode, expectedType] of [
		[500, "Code: 60. DB::Exception: missing. (UNKNOWN_TABLE)", {}, "60", "UNKNOWN_TABLE"],
		[401, "Access denied", {}, undefined, undefined],
		[503, "<html>upstream unavailable</html>", {}, undefined, undefined],
		[
			200,
			"Code: 159. DB::Exception: too slow. (TIMEOUT_EXCEEDED)",
			{ "x-clickhouse-exception-code": "159" },
			"159",
			"TIMEOUT_EXCEEDED",
		],
		[200, "gateway refused", { "x-clickhouse-exception-code": "497" }, "497", undefined],
		[
			500,
			"Code: 57. DB::Exception: from host: Code: 57. DB::Exception: nested. (TABLE_ALREADY_EXISTS) (TABLE_ALREADY_EXISTS)",
			{},
			"57",
			"TABLE_ALREADY_EXISTS",
		],
	] as const) {
		it.effect(`preserves HTTP ${status} and server identity ${expectedCode ?? "none"}`, () =>
			withFetch(
				Effect.gen(function* () {
					const client = yield* make(config)
					const error = yield* Effect.flip(client.query({ sql: "SELECT 1", queryId: "sent-id" }))
					assert.instanceOf(error, ClickHouseServerError)
					if (error instanceof ClickHouseServerError) {
						assert.strictEqual(error.status, status)
						assert.strictEqual(error.code, expectedCode)
						assert.strictEqual(error.type, expectedType)
						assert.strictEqual(error.queryId, "server-id")
					}
				}),
				async () => response(body, status, { ...headers, "x-clickhouse-query-id": "server-id" }),
			),
		)
	}
	it.effect("bounds error response bodies and cancels the unread remainder", () => {
		let cancelled = false,
			pulls = 0
		const request: typeof fetch = async () =>
			new Response(
				new ReadableStream({
					pull(controller) {
						pulls++
						controller.enqueue(new Uint8Array(8192).fill(65))
					},
					cancel() {
						cancelled = true
					},
				}),
				{ status: 503 },
			)
		return withFetch(
			Effect.gen(function* () {
				const client = yield* make(config)
				const error = yield* Effect.flip(client.query({ sql: "SELECT 1" }))
				assert.instanceOf(error, ClickHouseServerError)
				assert.isBelow(error.message.length, 17000)
				assert.isTrue(cancelled)
				assert.isAtMost(pulls, 3)
			}),
			request,
		)
	})
	it.effect("maps transport failures without retaining the credential-bearing request", () =>
		withFetch(
			Effect.gen(function* () {
				const client = yield* make(config)
				const error = yield* Effect.flip(client.query({ sql: "SECRET SQL" }))
				assert.instanceOf(error, ClickHouseTransportError)
				assert.notInclude(JSON.stringify(error), "SECRET SQL")
				assert.notInclude(JSON.stringify(error), "päss")
			}),
			async () => {
				throw new Error("connection reset")
			},
		),
	)
	it.effect("rejects partial results when the network fails mid-body", () =>
		withFetch(
			Effect.gen(function* () {
				const client = yield* make(config)
				assert.instanceOf(
					yield* Effect.flip(client.query({ sql: "SELECT 1" })),
					ClickHouseTransportError,
				)
			}),
			async () => {
				let read = false
				return new Response(
					new ReadableStream({
						pull(controller) {
							if (!read) {
								read = true
								controller.enqueue(new TextEncoder().encode('{"n":1}\n'))
							} else controller.error(new Error("connection reset"))
						},
					}),
				)
			},
		),
	)
	for (const [name, data, limits, expected] of [
		["malformed", '{"n":', {}, ClickHouseProtocolError],
		["byte limit", '{"n":1}\n', { maxBytes: 1 }, ClickHouseLimitError],
	] as const) {
		it.effect(`closes the request on ${name}`, () => {
			let signal: AbortSignal | null | undefined
			return withFetch(
				Effect.gen(function* () {
					const client = yield* make(config)
					assert.isTrue(
						(yield* Effect.flip(client.query({ sql: "SELECT 1", limits }))) instanceof expected,
					)
					assert.isTrue(signal?.aborted)
				}),
				async (_input, init) => {
					signal = init?.signal
					return response(data)
				},
			)
		})
	}
	it.effect("early stream termination cancels the body and aborts the request", () => {
		let cancelled = false,
			signal: AbortSignal | null | undefined
		return withFetch(
			Effect.gen(function* () {
				const client = yield* make(config)
				assert.deepStrictEqual(
					yield* Stream.runCollect(client.stream({ sql: "SELECT 1" }).pipe(Stream.take(1))),
					[{ n: 1 }],
				)
				assert.isTrue(cancelled)
				assert.isTrue(signal?.aborted)
			}),
			async (_input, init) => {
				signal = init?.signal
				return new Response(
					new ReadableStream({
						pull(controller) {
							controller.enqueue(new TextEncoder().encode('{"n":1}\n'))
						},
						cancel() {
							cancelled = true
						},
					}),
				)
			},
		)
	})
	it.effect("interrupts a request before headers arrive", () => {
		const started = Deferred.makeUnsafe<AbortSignal>()
		return withFetch(
			Effect.gen(function* () {
				const client = yield* make(config)
				const fiber = yield* Effect.forkChild(client.query({ sql: "SELECT 1" }))
				const signal = yield* Deferred.await(started)
				yield* Fiber.interrupt(fiber)
				assert.isTrue(signal.aborted)
				const exit = yield* Fiber.await(fiber)
				assert.isTrue(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause))
			}),
			(_input, init) =>
				new Promise((_resolve, reject) => {
					const signal = init?.signal!
					signal.addEventListener("abort", () => reject(signal.reason), { once: true })
					Deferred.doneUnsafe(started, Effect.succeed(signal))
				}),
		)
	})
})

it.effect("preserves supplied fetch options while refusing automatic redirects", () => {
	let seen: RequestInit | undefined
	return withFetch(
		Effect.gen(function* () {
			const client = yield* make(config)
			yield* client.query({ sql: "SELECT 1" })
			assert.strictEqual(seen?.redirect, "manual")
			assert.strictEqual(new Headers(seen?.headers).get("x-custom"), "kept")
		}).pipe(
			Effect.provideService(FetchHttpClient.RequestInit, {
				redirect: "follow",
				headers: { "x-custom": "kept" },
			}),
		),
		async (_input, init) => {
			seen = init
			return response()
		},
	)
})
it.effect("reports the server's returned query ID on success", () =>
	withFetch(
		Effect.gen(function* () {
			const client = yield* make(config)
			const result = yield* client.query({ sql: "SELECT 1", queryId: "requested" })
			assert.strictEqual(result.queryId, "returned")
		}),
		async () => response("{}\n", 200, { "x-clickhouse-query-id": "returned" }),
	),
)

describe("absent HTTP response bodies", () => {
	for (const status of [200, 204]) {
		it.effect(`decodes null-body HTTP ${status} as zero rows`, () =>
			withFetch(
				Effect.gen(function* () {
					const client = yield* make(config)
					const result = yield* client.query({ sql: "SELECT 1 WHERE 0" })
					assert.deepStrictEqual(result.data, [])
				}),
				async () => new Response(null, { status }),
			),
		)
	}
	it.effect("keeps an empty HTTP 500 response as a server error", () =>
		withFetch(
			Effect.gen(function* () {
				const client = yield* make(config)
				const error = yield* Effect.flip(client.query({ sql: "SELECT 1" }))
				assert.instanceOf(error, ClickHouseServerError)
				if (error instanceof ClickHouseServerError) {
					assert.strictEqual(error.status, 500)
					assert.match(error.message, /HTTP 500/)
				}
			}),
			async () => new Response(null, { status: 500 }),
		),
	)
})

describe("service layer", () => {
	it.effect("ClickHouseClient.layer builds the client from the ambient HttpClient", () =>
		Effect.gen(function* () {
			const client = yield* ClickHouseClient
			const result = yield* client.query({ sql: "SELECT 1 AS n" })
			assert.deepStrictEqual(result.data, [{ n: 1 }])
		}).pipe(
			Effect.provide(
				ClickHouseClient.layer(config).pipe(
					Layer.provide(FetchHttpClient.layer),
					Layer.provide(Layer.succeed(FetchHttpClient.Fetch, async () => response('{"n":1}\n'))),
				),
			),
		),
	)
	it.effect("ClickHouseClient.layer fails to build on an invalid endpoint", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(
				Effect.provide(
					ClickHouseClient,
					ClickHouseClient.layer({ url: "not a URL" }).pipe(Layer.provide(FetchHttpClient.layer)),
				),
			)
			assert.instanceOf(error, ClickHouseConfigError)
		}),
	)
})

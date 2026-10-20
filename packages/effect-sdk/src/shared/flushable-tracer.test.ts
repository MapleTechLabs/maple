import { assert, describe, it } from "@effect/vitest"
import { Data, Effect, Fiber, Schema } from "effect"
import * as ErrorReporter from "effect/ErrorReporter"
import { HttpApiSchemaError } from "effect/http-api/HttpApiError"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as HttpServerError from "effect/http/HttpServerError"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { makeSpanBuffer, type OtlpSpan } from "./flushable-tracer.js"

// A benign error flagged exactly the way Effect's RouteNotFound is.
class BenignError extends Data.TaggedError("BenignError")<{}> {
	readonly [ErrorReporter.ignore] = true
}
// A real reportable failure (no ignore flag) — e.g. a 400/500.
class ReportableError extends Data.TaggedError("ReportableError")<{}> {}

// An anticipated 4xx business error (e.g. unauthorized / not-found).
class UnauthorizedError extends Data.TaggedError("UnauthorizedError")<{}> {}
class V2InvalidRequestError extends Schema.Error<V2InvalidRequestError>("@maple/http/v2/InvalidRequestError")(
	{ error: Schema.Struct({ type: Schema.Literal("invalid_request_error") }) },
) {}

const runSpan = (buffer: ReturnType<typeof makeSpanBuffer>, effect: Effect.Effect<unknown, unknown>) =>
	effect.pipe(Effect.withSpan("http.server GET"), Effect.provide(buffer.tracerLayer), Effect.exit)

describe("makeSpanBuffer ignored-failure drop", () => {
	it.effect("drops spans whose failure carries [ErrorReporter.ignore]", () =>
		Effect.gen(function* () {
			const buffer = makeSpanBuffer()
			yield* runSpan(buffer, Effect.fail(new BenignError()))
			assert.strictEqual(buffer.size(), 0)
		}),
	)

	it.effect("keeps spans that fail with a reportable error", () =>
		Effect.gen(function* () {
			const buffer = makeSpanBuffer()
			yield* runSpan(buffer, Effect.fail(new ReportableError()))
			assert.strictEqual(buffer.size(), 1)
		}),
	)

	it.effect("keeps successful spans", () =>
		Effect.gen(function* () {
			const buffer = makeSpanBuffer()
			yield* runSpan(buffer, Effect.succeed(undefined))
			assert.strictEqual(buffer.size(), 1)
		}),
	)

	it.effect("keeps a mixed ignored failure and defect", () =>
		Effect.gen(function* () {
			const buffer = makeSpanBuffer()
			yield* runSpan(buffer, Effect.fail(new BenignError()).pipe(Effect.ensuring(Effect.die("boom"))))
			assert.strictEqual(buffer.size(), 1)
		}),
	)

	// Pins the upstream contract: the actual error HttpRouter raises for an
	// unmatched route must stay [ErrorReporter.ignore]-flagged, so the drop holds.
	it.effect("drops the real HttpServerError/RouteNotFound", () =>
		Effect.gen(function* () {
			const buffer = makeSpanBuffer()
			const request = HttpServerRequest.fromWeb(new Request("http://localhost/nope"))
			const error = new HttpServerError.HttpServerError({
				reason: new HttpServerError.RouteNotFound({ request }),
			})
			yield* runSpan(buffer, Effect.fail(error))
			assert.strictEqual(buffer.size(), 0)
		}),
	)
})

describe("makeSpanBuffer anticipated-error classification", () => {
	const tags = new Set(["UnauthorizedError"])

	it.effect("keeps an anticipated failure as an Ok span with no exception event", () =>
		Effect.gen(function* () {
			const buffer = makeSpanBuffer({ anticipatedErrorTags: tags })
			yield* runSpan(buffer, Effect.fail(new UnauthorizedError()))
			const [span] = buffer.drain()
			assert.isDefined(span)
			assert.strictEqual(span!.status.code, 1 /* Ok */)
			assert.strictEqual(
				span!.events.some((event) => event.name === "exception"),
				false,
			)
		}),
	)

	// effect 4.0.1 flags HttpApiSchemaError with [ErrorReporter.ignore]; an
	// anticipated identifier must still export it as Ok instead of dropping it.
	it.effect("exports an ignore-flagged anticipated failure as Ok", () =>
		Effect.gen(function* () {
			const buffer = makeSpanBuffer({ anticipatedErrorIdentifiers: new Set(["HttpApiSchemaError"]) })
			yield* runSpan(
				buffer,
				Schema.decodeUnknownEffect(Schema.String)(1).pipe(
					Effect.mapError((cause) => new HttpApiSchemaError({ kind: "Body", cause })),
				),
			)
			const [span] = buffer.drain()
			assert.isDefined(span)
			assert.strictEqual(span!.status.code, 1 /* Ok */)
		}),
	)

	it.effect("classifies Schema.Error failures by Error.name", () =>
		Effect.gen(function* () {
			const buffer = makeSpanBuffer({
				anticipatedErrorIdentifiers: new Set(["@maple/http/v2/InvalidRequestError"]),
			})
			yield* runSpan(
				buffer,
				Effect.fail(new V2InvalidRequestError({ error: { type: "invalid_request_error" } })),
			)
			const [span] = buffer.drain()
			assert.isDefined(span)
			assert.strictEqual(span!.status.code, 1 /* Ok */)
			assert.strictEqual(
				span!.events.some((event) => event.name === "exception"),
				false,
			)
		}),
	)

	// The shape a decoded HTTP error body actually has on the client: an `{ error }`
	// envelope, not a class. Without the unwrap an API using that convention
	// matches *no* configured identifier at all, and every expected 4xx records
	// `Error` with the stringified envelope as its whole message.
	it.effect("classifies a decoded `{ error: { _tag } }` envelope by the body's tag", () =>
		Effect.gen(function* () {
			const buffer = makeSpanBuffer({
				anticipatedErrorIdentifiers: new Set(["@maple/http/v2/SessionReplayRangeTooLargeError"]),
			})
			yield* runSpan(
				buffer,
				Effect.fail({
					error: {
						_tag: "@maple/http/v2/SessionReplayRangeTooLargeError",
						type: "invalid_request_error",
						code: "range_too_large",
						message: "That part of the recording is too large to load in one request.",
					},
				}),
			)
			const [span] = buffer.drain()
			assert.isDefined(span)
			assert.strictEqual(span!.status.code, 1 /* Ok */)
			assert.strictEqual(
				span!.events.some((event) => event.name === "exception"),
				false,
			)
		}),
	)

	it.effect("leaves an envelope whose tag is not anticipated an Error span", () =>
		Effect.gen(function* () {
			const buffer = makeSpanBuffer({
				anticipatedErrorIdentifiers: new Set(["@maple/http/v2/SessionReplayRangeTooLargeError"]),
			})
			yield* runSpan(buffer, Effect.fail({ error: { _tag: "@maple/http/errors/PersistenceError" } }))
			const [span] = buffer.drain()
			assert.isDefined(span)
			assert.strictEqual(span!.status.code, 2 /* Error */)
		}),
	)

	it.effect("still marks an unclassified failure as an Error span with an exception event", () =>
		Effect.gen(function* () {
			const buffer = makeSpanBuffer({ anticipatedErrorTags: tags })
			yield* runSpan(buffer, Effect.fail(new ReportableError()))
			const [span] = buffer.drain()
			assert.isDefined(span)
			assert.strictEqual(span!.status.code, 2 /* Error */)
			assert.strictEqual(
				span!.events.some((event) => event.name === "exception"),
				true,
			)
		}),
	)

	it.effect("marks Error when an anticipated error is mixed with a defect", () =>
		Effect.gen(function* () {
			const buffer = makeSpanBuffer({ anticipatedErrorTags: tags })
			yield* runSpan(
				buffer,
				Effect.fail(new UnauthorizedError()).pipe(Effect.ensuring(Effect.die("boom"))),
			)
			const [span] = buffer.drain()
			assert.isDefined(span)
			assert.strictEqual(span!.status.code, 2 /* Error */)
		}),
	)

	it.effect("marks Error for an anticipated tag when no tags are configured", () =>
		Effect.gen(function* () {
			const buffer = makeSpanBuffer()
			yield* runSpan(buffer, Effect.fail(new UnauthorizedError()))
			const [span] = buffer.drain()
			assert.isDefined(span)
			assert.strictEqual(span!.status.code, 2 /* Error */)
		}),
	)

	// An interrupt co-occurring with an anticipated failure is NOT an error:
	// interrupts are normal fiber control flow, so the span stays Ok (unlike a
	// defect, which forces Error). Pins the Die-vs-Interrupt asymmetry.
	it.effect("keeps Ok when an anticipated error is mixed with an interrupt", () =>
		Effect.gen(function* () {
			const buffer = makeSpanBuffer({ anticipatedErrorTags: tags })
			yield* runSpan(
				buffer,
				Effect.fail(new UnauthorizedError()).pipe(Effect.ensuring(Effect.interrupt)),
			)
			const [span] = buffer.drain()
			assert.isDefined(span)
			assert.strictEqual(span!.status.code, 1 /* Ok */)
			assert.strictEqual(
				span!.events.some((event) => event.name === "exception"),
				false,
			)
		}),
	)
})

describe("makeSpanBuffer rendered 5xx responses", () => {
	// A server span whose handler answered with a plain response — no failure in
	// the Effect, only the status code the HTTP tracer stamps on the span.
	const respond = (
		buffer: ReturnType<typeof makeSpanBuffer>,
		status: number,
		kind: "server" | "internal",
	) =>
		Effect.annotateCurrentSpan({
			"http.request.method": "GET",
			"url.path": "/api/sync/shape",
			"http.response.status_code": status,
		}).pipe(Effect.withSpan("http.server GET", { kind }), Effect.provide(buffer.tracerLayer))

	it.effect("records a 5xx on a server span as Error with an exception event", () =>
		Effect.gen(function* () {
			const buffer = makeSpanBuffer()
			yield* respond(buffer, 500, "server")
			const [span] = buffer.drain()
			assert.isDefined(span)
			assert.strictEqual(span!.status.code, 2 /* Error */)
			assert.strictEqual(span!.status.message, "HTTP 500 (GET /api/sync/shape)")
			const exception = span!.events.find((event) => event.name === "exception")
			assert.isDefined(exception)
			assert.deepStrictEqual(
				exception!.attributes.find((attribute) => attribute.key === "exception.type")?.value,
				{ stringValue: "HttpServerErrorResponse" },
			)
		}),
	)

	it.effect("treats Effect's own failure for a 5xx response as the rendered 5xx", () =>
		Effect.gen(function* () {
			const buffer = makeSpanBuffer()
			const request = HttpServerRequest.fromWeb(new Request("http://localhost/api/sync/shape"))
			const error = new HttpServerError.HttpServerError({
				reason: new HttpServerError.ResponseError({
					request,
					response: HttpServerResponse.empty({ status: 500 }),
				}),
			})
			yield* Effect.annotateCurrentSpan({
				"http.request.method": "GET",
				"url.path": "/api/sync/shape",
				"http.response.status_code": 500,
			}).pipe(
				Effect.andThen(Effect.fail(error)),
				Effect.withSpan("GET", { kind: "server" }),
				Effect.provide(buffer.tracerLayer),
				Effect.ignore,
			)
			const [span] = buffer.drain()
			assert.strictEqual(span!.status.message, "HTTP 500 (GET /api/sync/shape)")
			const exceptions = span!.events.filter((event) => event.name === "exception")
			assert.strictEqual(exceptions.length, 1)
			assert.deepStrictEqual(
				exceptions[0]!.attributes.find((attribute) => attribute.key === "exception.type")?.value,
				{ stringValue: "HttpServerErrorResponse" },
			)
		}),
	)

	// `@effect/platform-node` builds these when writing the response fails.
	const writeFailures = [
		["a cause", { cause: new Error("socket hang up") }],
		["a description", { description: "Error writing raw response" }],
		["both", { description: "Error writing raw response", cause: new Error("socket hang up") }],
	] as const

	for (const [label, detail] of writeFailures) {
		it.effect(`keeps a failed response write carrying ${label} as its own error`, () =>
			Effect.gen(function* () {
				const buffer = makeSpanBuffer()
				const error = new HttpServerError.HttpServerError({
					reason: new HttpServerError.ResponseError({
						request: HttpServerRequest.fromWeb(new Request("http://localhost/api/sync/shape")),
						response: HttpServerResponse.empty({ status: 500 }),
						...detail,
					}),
				})
				yield* Effect.annotateCurrentSpan({ "http.response.status_code": 500 }).pipe(
					Effect.andThen(Effect.fail(error)),
					Effect.withSpan("GET", { kind: "server" }),
					Effect.provide(buffer.tracerLayer),
					Effect.ignore,
				)
				const [span] = buffer.drain()
				assert.isDefined(span)
				assert.strictEqual(span!.status.code, 2 /* Error */)
				const types = span!.events
					.filter((event) => event.name === "exception")
					.map(
						(event) =>
							event.attributes.find((attribute) => attribute.key === "exception.type")?.value,
					)
				assert.deepStrictEqual(types, [{ stringValue: "HttpServerError" }])
			}),
		)
	}

	it.effect("keeps an exception the handler recorded itself instead of relabelling it", () =>
		Effect.gen(function* () {
			const buffer = makeSpanBuffer()
			// A service that names the failure where it renders the response: the
			// generic type would collapse every such 5xx into one bucket.
			yield* Effect.currentSpan.pipe(
				Effect.flatMap((span) =>
					Effect.sync(() =>
						span.event("exception", 1n, {
							"exception.type": "WarehouseQueryError",
							"exception.message": "Memory limit exceeded",
						}),
					),
				),
				Effect.andThen(
					Effect.annotateCurrentSpan({
						"http.request.method": "GET",
						"url.path": "/api/sync/shape",
						"http.response.status_code": 500,
					}),
				),
				Effect.withSpan("http.server GET", { kind: "server" }),
				Effect.provide(buffer.tracerLayer),
			)
			const [span] = buffer.drain()
			assert.strictEqual(span!.status.code, 2 /* Error */)
			const exceptions = span!.events.filter((event) => event.name === "exception")
			assert.strictEqual(exceptions.length, 1)
			assert.deepStrictEqual(
				exceptions[0]!.attributes.find((attribute) => attribute.key === "exception.type")?.value,
				{ stringValue: "WarehouseQueryError" },
			)
		}),
	)

	it.effect("leaves a 4xx server span Ok", () =>
		Effect.gen(function* () {
			const buffer = makeSpanBuffer()
			yield* respond(buffer, 404, "server")
			const [span] = buffer.drain()
			assert.strictEqual(span?.status.code, 1 /* Ok */)
			assert.strictEqual(span?.events.length, 0)
		}),
	)

	it.effect("ignores the status code on non-server spans", () =>
		Effect.gen(function* () {
			const buffer = makeSpanBuffer()
			yield* respond(buffer, 503, "internal")
			const [span] = buffer.drain()
			assert.strictEqual(span?.status.code, 1 /* Ok */)
		}),
	)
})

describe("makeSpanBuffer raw HTTP client spans", () => {
	// A real Effect HttpClient over a stubbed fetch, so Effect itself ends the client span.
	const request = (
		buffer: ReturnType<typeof makeSpanBuffer>,
		fetch: () => Promise<Response>,
		handle: (
			response: Effect.Effect<HttpClientResponse.HttpClientResponse, unknown, HttpClient.HttpClient>,
		) => Effect.Effect<unknown, unknown, HttpClient.HttpClient> = (response) => response,
	) =>
		handle(HttpClient.get("https://api.test/v1/things")).pipe(
			Effect.withSpan("caller"),
			Effect.provide(FetchHttpClient.layer),
			Effect.provideService(FetchHttpClient.Fetch, fetch),
			Effect.provide(buffer.tracerLayer),
			Effect.exit,
		)
	const clientSpan = (spans: ReadonlyArray<OtlpSpan>) => spans.find((span) => span.kind === 3 /* client */)
	const callerSpan = (spans: ReadonlyArray<OtlpSpan>) => spans.find((span) => span.name === "caller")
	const hasException = (span: OtlpSpan | undefined) =>
		span?.events.some((event) => event.name === "exception")
	const respond = (status: number) => () => Promise.resolve(new Response("{}", { status }))
	const failToFetch = () => Promise.reject(new TypeError("Failed to fetch"))

	it.effect("keeps a 4xx client span Error but leaves the exception to the caller", () =>
		Effect.gen(function* () {
			const buffer = makeSpanBuffer()
			yield* request(buffer, respond(401))
			const spans = buffer.drain()
			assert.strictEqual(clientSpan(spans)?.status.code, 2 /* Error */)
			assert.isFalse(hasException(clientSpan(spans)))
			// The caller read the 401 and moved on: nothing failed.
			assert.strictEqual(callerSpan(spans)?.status.code, 1 /* Ok */)
		}),
	)

	it.effect("still reports a 4xx the caller does not handle, on the caller's span", () =>
		Effect.gen(function* () {
			const buffer = makeSpanBuffer()
			yield* request(buffer, respond(403), (response) =>
				response.pipe(Effect.flatMap(HttpClientResponse.filterStatusOk)),
			)
			const spans = buffer.drain()
			assert.isFalse(hasException(clientSpan(spans)))
			assert.strictEqual(callerSpan(spans)?.status.code, 2 /* Error */)
			assert.isTrue(hasException(callerSpan(spans)))
		}),
	)

	it.effect("lets an anticipated identifier record a 4xx client span as Ok", () =>
		Effect.gen(function* () {
			const buffer = makeSpanBuffer({ anticipatedErrorIdentifiers: new Set(["HttpClientError"]) })
			yield* request(buffer, respond(401))
			assert.strictEqual(clientSpan(buffer.drain())?.status.code, 1 /* Ok */)
		}),
	)

	it.effect("keeps the exception on a 5xx client span", () =>
		Effect.gen(function* () {
			const buffer = makeSpanBuffer()
			yield* request(buffer, respond(503))
			assert.isTrue(hasException(clientSpan(buffer.drain())))
		}),
	)

	it.effect("exports a transport failure as Unset when the connection was lost mid-request", () =>
		Effect.gen(function* () {
			const buffer = makeSpanBuffer({ watchConnection: () => () => "page_unload" })
			yield* request(buffer, failToFetch)
			const span = clientSpan(buffer.drain())
			assert.strictEqual(span?.status.code, 0 /* Unset */)
			assert.isFalse(hasException(span))
			assert.deepStrictEqual(
				span?.attributes.find((attribute) => attribute.key === "maple.connection_lost")?.value,
				{ stringValue: "page_unload" },
			)
		}),
	)

	it.effect("exports a transport failure as Unset when the unload is noted just after it", () =>
		Effect.gen(function* () {
			// The browser rejected the request before the `pagehide` listener noting it ran.
			const reasons: Array<string> = []
			const buffer = makeSpanBuffer({ watchConnection: () => () => reasons[0] })
			yield* request(buffer, failToFetch)
			reasons.push("page_unload")
			const spans = buffer.drain()
			assert.strictEqual(clientSpan(spans)?.status.code, 0 /* Unset */)
			assert.strictEqual(callerSpan(spans)?.status.code, 0 /* Unset */)
			assert.isFalse(hasException(callerSpan(spans)))
		}),
	)

	it.effect("keeps a transport failure an Error while the connection held", () =>
		Effect.gen(function* () {
			const buffer = makeSpanBuffer({ watchConnection: () => () => undefined })
			yield* request(buffer, failToFetch)
			const span = clientSpan(buffer.drain())
			assert.strictEqual(span?.status.code, 2 /* Error */)
			assert.isTrue(hasException(span))
			assert.deepStrictEqual(
				span?.attributes.find((attribute) => attribute.key === "error.type")?.value,
				{ stringValue: "TransportError" },
			)
		}),
	)

	it.effect("names a failed span's error.type after the error it failed with", () =>
		Effect.gen(function* () {
			const buffer = makeSpanBuffer()
			yield* runSpan(buffer, Effect.fail(new ReportableError()))
			const [span] = buffer.drain()
			assert.strictEqual(span?.status.code, 2 /* Error */)
			assert.deepStrictEqual(
				span?.attributes.find((attribute) => attribute.key === "error.type")?.value,
				{ stringValue: "ReportableError" },
			)
		}),
	)
})

describe("makeSpanBuffer restore", () => {
	it.effect("keeps older failed telemetry and discards newest overflow", () =>
		Effect.gen(function* () {
			const buffer = makeSpanBuffer()
			yield* runSpan(buffer, Effect.succeed("old"))
			const [oldest] = buffer.drain()
			yield* Effect.succeed(undefined).pipe(
				Effect.withSpan("newest"),
				Effect.provide(buffer.tracerLayer),
			)
			const [newest] = buffer.drain()
			assert.isDefined(oldest)
			assert.isDefined(newest)

			buffer.restore([oldest!, ...Array.from({ length: 10_000 }, () => newest!)])
			const restored = buffer.drain()
			assert.strictEqual(restored.length, 10_000)
			assert.strictEqual(restored[0]?.name, "http.server GET")
			assert.strictEqual(restored.at(-1)?.name, "newest")
		}),
	)
})

const attributeOf = (span: { attributes: ReadonlyArray<{ key: string; value: unknown }> }, key: string) =>
	span.attributes.find((attribute) => attribute.key === key)?.value

describe("makeSpanBuffer captureException", () => {
	it("records a thrown error as an Error span with an exception event", () => {
		const buffer = makeSpanBuffer()
		buffer.captureException(new TypeError("Cannot read properties of undefined (reading 'spans')"))

		const [span] = buffer.drain()
		assert.isDefined(span)
		assert.strictEqual(span?.name, "exception")
		// StatusCode 2 is Error — `error_events_mv` keys off exactly this.
		assert.strictEqual(span?.status.code, 2)

		const event = span?.events.find((candidate) => candidate.name === "exception")
		assert.isDefined(event)
		const attribute = (key: string) => event?.attributes.find((candidate) => candidate.key === key)?.value
		assert.deepStrictEqual(attribute("exception.type"), { stringValue: "TypeError" })
		assert.deepStrictEqual(attribute("exception.message"), {
			stringValue: "Cannot read properties of undefined (reading 'spans')",
		})
	})

	it("carries caller attributes and a custom span name", () => {
		const buffer = makeSpanBuffer()
		buffer.captureException(new Error("boom"), {
			name: "browser.uncaught_error",
			attributes: { "maple.exception.source": "window.onerror" },
		})

		const [span] = buffer.drain()
		assert.strictEqual(span?.name, "browser.uncaught_error")
		assert.deepStrictEqual(attributeOf(span!, "maple.exception.source"), {
			stringValue: "window.onerror",
		})
	})

	it("is not silenceable through anticipatedErrorIdentifiers", () => {
		// An uncaught throw is never an anticipated 4xx. Recording it as a defect
		// keeps it clear of that filter, so a caller cannot accidentally suppress
		// real crashes by listing a tag.
		const buffer = makeSpanBuffer({ anticipatedErrorIdentifiers: new Set(["Error", "TypeError"]) })
		buffer.captureException(new TypeError("still an error"))

		const [span] = buffer.drain()
		assert.strictEqual(span?.status.code, 2)
		assert.isDefined(span?.events.find((candidate) => candidate.name === "exception"))
	})

	it("stays silent while capture is disabled by consent", () => {
		const buffer = makeSpanBuffer()
		buffer.setDisabled(true)
		buffer.captureException(new Error("boom"))
		assert.strictEqual(buffer.size(), 0)
	})
})

describe("makeSpanBuffer span dropping", () => {
	const poll = (buffer: ReturnType<typeof makeSpanBuffer>) =>
		Effect.void.pipe(
			Effect.withSpan("db.query"),
			Effect.withSpan("queue.claim"),
			Effect.andThen(
				Effect.forkChild(Effect.void.pipe(Effect.withSpan("forked.work"))).pipe(
					Effect.flatMap(Fiber.join),
				),
			),
			Effect.withSpan("queue.poll"),
			Effect.provide(buffer.tracerLayer),
		)

	it.effect("dropSpanNames drops only the matching span", () =>
		Effect.gen(function* () {
			const buffer = makeSpanBuffer({ dropSpanNames: ["queue.poll"] })
			yield* poll(buffer)
			assert.deepStrictEqual(
				buffer
					.drain()
					.map((span) => span.name)
					.sort(),
				["db.query", "forked.work", "queue.claim"],
			)
		}),
	)

	it.effect("dropSpanSubtrees drops the span, its grandchildren, and forked children", () =>
		Effect.gen(function* () {
			const buffer = makeSpanBuffer({ dropSpanSubtrees: ["queue.poll"] })
			yield* poll(buffer)
			yield* Effect.void.pipe(Effect.withSpan("job.process"), Effect.provide(buffer.tracerLayer))
			assert.deepStrictEqual(
				buffer.drain().map((span) => span.name),
				["job.process"],
			)
		}),
	)

	it.effect("dropSpanSubtrees drops errors raised inside the subtree", () =>
		Effect.gen(function* () {
			const buffer = makeSpanBuffer({ dropSpanSubtrees: ["queue.poll"] })
			yield* Effect.fail(new ReportableError()).pipe(
				Effect.withSpan("db.query"),
				Effect.withSpan("queue.poll"),
				Effect.provide(buffer.tracerLayer),
				Effect.exit,
			)
			assert.strictEqual(buffer.size(), 0)
		}),
	)

	it.effect("dropSpan sees the finished span's attributes and exit", () =>
		Effect.gen(function* () {
			const buffer = makeSpanBuffer({
				dropSpan: (span) =>
					span.attributes.get("queue.empty") === true && span.exit._tag === "Success",
			})
			yield* Effect.annotateCurrentSpan("queue.empty", true).pipe(
				Effect.withSpan("queue.poll"),
				Effect.provide(buffer.tracerLayer),
			)
			yield* Effect.annotateCurrentSpan("queue.empty", false).pipe(
				Effect.withSpan("queue.poll"),
				Effect.provide(buffer.tracerLayer),
			)
			const spans = buffer.drain()
			assert.strictEqual(spans.length, 1)
			assert.deepStrictEqual(
				spans[0]!.attributes.find((attribute) => attribute.key === "queue.empty")?.value,
				{ boolValue: false },
			)
		}),
	)
})

describe("makeSpanBuffer anticipated-error predicate and 5xx precedence", () => {
	class SqlError extends Data.TaggedError("SqlError")<{ readonly code: string }> {}

	it.effect("isAnticipatedError marks only the failures it matches", () =>
		Effect.gen(function* () {
			const buffer = makeSpanBuffer({
				isAnticipatedError: (error) => error instanceof SqlError && error.code === "23505",
			})
			yield* runSpan(buffer, Effect.fail(new SqlError({ code: "23505" })))
			yield* runSpan(buffer, Effect.fail(new SqlError({ code: "57014" })))
			assert.deepStrictEqual(
				buffer.drain().map((span) => span.status.code),
				[1 /* Ok */, 2 /* Error */],
			)
		}),
	)

	it.effect("keeps a server span that answered 5xx as Error even when the failure is anticipated", () =>
		Effect.gen(function* () {
			const buffer = makeSpanBuffer({ anticipatedErrorIdentifiers: ["UnauthorizedError"] })
			yield* Effect.annotateCurrentSpan("http.response.status_code", 500).pipe(
				Effect.andThen(Effect.fail(new UnauthorizedError())),
				Effect.withSpan("http.server GET", { kind: "server" }),
				Effect.provide(buffer.tracerLayer),
				Effect.exit,
			)
			const [span] = buffer.drain()
			assert.strictEqual(span!.status.code, 2 /* Error */)
			assert.deepStrictEqual(
				span!.events
					.find((event) => event.name === "exception")
					?.attributes.find((attribute) => attribute.key === "exception.type")?.value,
				{ stringValue: "UnauthorizedError" },
			)
		}),
	)

	it.effect("includeCauseInStack appends the cause chain to the stacktrace", () =>
		Effect.gen(function* () {
			const failure = new Error("outer", { cause: new Error("inner") })
			const stacktrace = (buffer: ReturnType<typeof makeSpanBuffer>) =>
				buffer
					.drain()[0]!
					.events.find((event) => event.name === "exception")
					?.attributes.find((attribute) => attribute.key === "exception.stacktrace")?.value
					.stringValue
			const withCause = makeSpanBuffer({ includeCauseInStack: true })
			const without = makeSpanBuffer()
			yield* runSpan(withCause, Effect.fail(failure))
			yield* runSpan(without, Effect.fail(failure))
			assert.include(stacktrace(withCause), "inner")
			assert.notInclude(stacktrace(without), "inner")
		}),
	)
})

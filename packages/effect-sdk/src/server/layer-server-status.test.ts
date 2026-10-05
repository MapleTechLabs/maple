import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { afterAll, beforeAll, vi } from "vitest"
import { layer } from "./layer.js"

interface ExportedSpan {
	readonly name: string
	readonly status: { readonly code: number; readonly message?: string }
	readonly events: ReadonlyArray<{
		readonly name: string
		readonly attributes: ReadonlyArray<{
			readonly key: string
			readonly value: { readonly stringValue?: string }
		}>
	}>
}

// `Maple.layer` exports through Effect's stock OTLP tracer, which derives status from the Exit
// alone, so a handler that *rendered* a 500 (an HttpApi error with `httpApiStatus: 500`) used
// to reach the warehouse as `Ok`. Stub `fetch` and read back the real OTLP payload.
// One stub for the whole file: `FetchHttpClient` keeps the first `fetch` it resolves.
const traceBodies: Array<string> = []
beforeAll(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input).endsWith("/v1/traces")) traceBodies.push(String(init?.body))
			return new Response("{}", { status: 200 })
		}),
	)
})
afterAll(() => {
	vi.unstubAllGlobals()
})

const exportSpans = async (spans: Effect.Effect<void>): Promise<Array<ExportedSpan>> => {
	traceBodies.length = 0
	const telemetry = layer({ serviceName: "unit-test", endpoint: "http://collector.test" })
	// Closing the scope shuts the exporter down, which flushes the batch.
	await Effect.runPromise(
		Effect.scoped(Layer.build(telemetry).pipe(Effect.flatMap((ctx) => Effect.provide(spans, ctx)))),
	)
	return traceBodies.flatMap((body) =>
		JSON.parse(body).resourceSpans.flatMap((rs: { scopeSpans: Array<{ spans: Array<ExportedSpan> }> }) =>
			rs.scopeSpans.flatMap((ss) => ss.spans),
		),
	)
}

const respond = (
	name: string,
	status: number,
	kind: "server" | "client" = "server",
	handler: Effect.Effect<void> = Effect.void,
) =>
	handler.pipe(
		Effect.tap(() =>
			Effect.annotateCurrentSpan({
				"http.response.status_code": status,
				"http.request.method": "POST",
				"url.path": "/api/todos/1/toggle",
			}),
		),
		Effect.withSpan(name, { kind }),
	)

const recordException = Effect.currentSpan.pipe(
	Effect.tap((span) =>
		Effect.sync(() =>
			span.event("exception", 1n, {
				"exception.type": "ToggleFailedError",
				"exception.message": "toggle failed",
				"exception.stacktrace": "ToggleFailedError: toggle failed\n    at toggle (todo.ts:1:1)",
			}),
		),
	),
	Effect.orDie,
	Effect.asVoid,
)

const STATUS_OK = 1
const STATUS_ERROR = 2

describe("Maple.layer server span status", () => {
	it("marks a rendered 5xx server span as Error with an exception event", async () => {
		const [span] = await exportSpans(respond("POST /api/todos/:id/toggle", 500))

		expect(span?.status.code).toBe(STATUS_ERROR)
		expect(span?.status.message).toBe("HTTP 500 (POST /api/todos/1/toggle)")
		expect(span?.events.map((event) => event.name)).toEqual(["exception"])
	})

	it("does not add a synthetic exception when the handler recorded one", async () => {
		const [span] = await exportSpans(
			respond("POST /api/todos/:id/toggle", 500, "server", recordException),
		)

		expect(span?.status.code).toBe(STATUS_ERROR)
		const exceptions = span?.events.filter((event) => event.name === "exception") ?? []
		expect(exceptions).toHaveLength(1)
		expect(
			exceptions[0]?.attributes.find((attr) => attr.key === "exception.type")?.value.stringValue,
		).toBe("ToggleFailedError")
	})

	it("keeps 4xx server spans and 5xx client spans Ok", async () => {
		const spans = await exportSpans(
			Effect.all([respond("rejected", 400), respond("upstream", 503, "client")], { discard: true }),
		)

		expect(spans.map((span) => [span.name, span.status.code])).toEqual([
			["rejected", STATUS_OK],
			["upstream", STATUS_OK],
		])
	})

	it("still exports an exception recorded on a non-5xx server span", async () => {
		const [span] = await exportSpans(respond("rejected", 400, "server", recordException))

		expect(span?.status.code).toBe(STATUS_OK)
		expect(span?.events.map((event) => event.name)).toEqual(["exception"])
	})
})

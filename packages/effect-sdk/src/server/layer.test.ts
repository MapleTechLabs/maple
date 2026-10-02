import { describe, it } from "@effect/vitest"
import { Data, Effect, Layer, Tracer } from "effect"
import { afterEach, beforeEach, expect, vi } from "vitest"
import { layer } from "./layer.js"

interface ExportCall {
	readonly url: string
	readonly authorization: string | null
	readonly body: ExportBody
}
interface ExportBody {
	readonly resourceSpans?: ReadonlyArray<{
		readonly resource: { readonly attributes: ReadonlyArray<{ readonly key: string }> }
		readonly scopeSpans: ReadonlyArray<{ readonly spans: ReadonlyArray<ExportedSpan> }>
	}>
	readonly resourceLogs?: ReadonlyArray<{
		readonly scopeLogs: ReadonlyArray<{
			readonly logRecords: ReadonlyArray<{ readonly traceId?: string }>
		}>
	}>
}
interface ExportedSpan {
	readonly name: string
	readonly traceId: string
	readonly status: { readonly code: number }
	readonly events: ReadonlyArray<{ readonly name: string }>
}

// Installed for the whole file: `FetchHttpClient` resolves `globalThis.fetch`
// once, so a per-test swap would be missed after the first export.
const calls: Array<ExportCall> = []
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const request = new Request(input, init)
	const text = await request.text()
	calls.push({
		url: request.url,
		authorization: request.headers.get("authorization"),
		body: text ? JSON.parse(text) : {},
	})
	return new Response(null, { status: 200 })
}) as typeof fetch

const exportedSpans = (): Array<ExportedSpan> =>
	calls
		.filter((call) => call.url.endsWith("/v1/traces"))
		.flatMap((call) => call.body.resourceSpans ?? [])
		.flatMap((resourceSpan) => resourceSpan.scopeSpans.flatMap((scope) => scope.spans))

class DuplicateDocument extends Data.TaggedError("DuplicateDocument")<{}> {}

// `Maple.layer` had no tests, which is how a dead `if (!resolved.endpoint)`
// guard survived long after `resolveResource` started defaulting the endpoint.
// These pin the real contract: this layer ALWAYS exports. A missing ingest key
// is not a disable signal — keyless export to a local `maple start` sink or a
// self-hosted collector is supported, and silently no-op'ing would break it.

const serviceKeys = async (config: Parameters<typeof layer>[0]): Promise<Array<string>> => {
	const context = await Effect.runPromise(Effect.scoped(Layer.build(layer(config))))
	// `CurrentMemoMap` is bookkeeping every `Layer.build` adds, including
	// `Layer.empty`'s — it is not a service the layer contributed.
	return [...context.mapUnsafe.keys()].filter((key) => key !== "effect/Layer/CurrentMemoMap")
}

describe("Maple.layer", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("installs tracer, logger, and exporter when an ingest key is configured", async () => {
		const keys = await serviceKeys({
			serviceName: "unit-test",
			endpoint: "https://collector.test",
			ingestKey: "secret",
		})

		expect(keys).toContain("effect/Tracer")
		expect(keys).toContain("effect/Logger/CurrentLoggers")
		expect(keys).toContain("effect/observability/OtlpExporter/Flusher")
	})

	it("still exports to a custom endpoint with no ingest key", async () => {
		// The `examples/effect-todo` shape: local-mode sink, no key. Disabling
		// this was a real regression, so it gets a test of its own.
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

		const keys = await serviceKeys({ serviceName: "unit-test", endpoint: "http://127.0.0.1:4318" })

		expect(keys).toContain("effect/Tracer")
		// A self-hosted collector taking unauthenticated writes is legitimate —
		// no scolding.
		expect(warnSpy).not.toHaveBeenCalled()
	})

	it("warns once when keyless against the public ingest, but still builds", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

		// No endpoint → defaults to the public ingest, which 401s without a key.
		const keys = await serviceKeys({ serviceName: "unit-test" })

		expect(keys).toContain("effect/Tracer")
		expect(warnSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain("401")
	})
})

describe("Maple.layer span options", () => {
	const config = {
		serviceName: "unit-test",
		endpoint: "https://collector.test",
		ingestKey: "secret",
		environment: "test",
	}

	beforeEach(() => {
		calls.length = 0
	})

	// Exports happen on scope close (the shutdown flush), not on an interval tick.
	const run = (options: Parameters<typeof layer>[0], program: Effect.Effect<unknown, unknown>) =>
		Effect.runPromise(program.pipe(Effect.exit, Effect.provide(layer(options))))

	it("exports spans on shutdown with the ingest key and resource", async () => {
		await run(config, Effect.void.pipe(Effect.withSpan("hello")))

		const traces = calls.find((call) => call.url === "https://collector.test/v1/traces")
		expect(traces?.authorization).toBe("Bearer secret")
		const keys = traces?.body.resourceSpans?.[0]?.resource.attributes.map((attribute) => attribute.key)
		expect(keys).toContain("service.name")
		expect(keys).toContain("deployment.environment.name")
		expect(exportedSpans().map((span) => span.name)).toEqual(["hello"])
	})

	it("drops a subtree but keeps sibling work and its logs", async () => {
		await run(
			{ ...config, dropSpanSubtrees: ["queue.poll"] },
			Effect.gen(function* () {
				yield* Effect.void.pipe(Effect.withSpan("db.query"), Effect.withSpan("queue.poll"))
				yield* Effect.log("processing").pipe(Effect.withSpan("job.process"))
			}),
		)

		const spans = exportedSpans()
		expect(spans.map((span) => span.name)).toEqual(["job.process"])
		const logTraceIds = calls
			.filter((call) => call.url.endsWith("/v1/logs"))
			.flatMap((call) => call.body.resourceLogs ?? [])
			.flatMap((resourceLog) => resourceLog.scopeLogs.flatMap((scope) => scope.logRecords))
			.map((record) => record.traceId)
		expect(logTraceIds).toContain(spans[0]?.traceId)
	})

	it("exports anticipated failures as Ok with no exception event", async () => {
		await run(
			{ ...config, anticipatedErrorIdentifiers: ["DuplicateDocument"] },
			Effect.fail(new DuplicateDocument()).pipe(Effect.withSpan("documents.insert")),
		)

		const [span] = exportedSpans()
		expect(span?.status.code).toBe(1)
		expect(span?.events.some((event) => event.name === "exception")).toBe(false)
	})

	it("still records unexpected failures as Error", async () => {
		await run(config, Effect.fail(new DuplicateDocument()).pipe(Effect.withSpan("documents.insert")))

		const [span] = exportedSpans()
		expect(span?.status.code).toBe(2)
		expect(span?.events.some((event) => event.name === "exception")).toBe(true)
	})

	// The no-option recipe the docs point to: a Debug span under an Info
	// minimum trace level is unsampled, and so is everything beneath it.
	it("leaves a Debug-level span and its subtree unexported under MinimumTraceLevel Info", async () => {
		await run(
			config,
			Effect.gen(function* () {
				yield* Effect.void.pipe(
					Effect.withSpan("db.query"),
					Effect.withSpan("queue.poll", { level: "Debug" }),
				)
				yield* Effect.void.pipe(Effect.withSpan("job.process"))
			}).pipe(Effect.provideService(Tracer.MinimumTraceLevel, "Info")),
		)

		expect(exportedSpans().map((span) => span.name)).toEqual(["job.process"])
	})
})

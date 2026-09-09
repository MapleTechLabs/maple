import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Layer, Logger, References, Schema, Tracer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { V1SchemaErrors, V1UnexpectedErrors } from "@maple/domain/http"
import { V1ErrorBoundaryLive } from "./error-boundary"

/** A declared failure the endpoint answers with a 502 — the shape every warehouse error takes. */
class UpstreamError extends Schema.TaggedError<UpstreamError>()(
	"@maple/test/UpstreamError",
	{ message: Schema.String },
	{ httpApiStatus: 502 },
) {}

/** A declared failure that is the caller's problem. */
class ConflictError extends Schema.TaggedError<ConflictError>()(
	"@maple/test/ConflictError",
	{ message: Schema.String },
	{ httpApiStatus: 409 },
) {}

const BoundaryGroup = HttpApiGroup.make("boundary")
	.add(
		HttpApiEndpoint.post("validate", "/validate", {
			payload: Schema.Struct({ name: Schema.String.check(Schema.isMinLength(2)) }),
			success: Schema.String,
		}),
	)
	.add(HttpApiEndpoint.get("invalidResponse", "/invalid-response", { success: Schema.String }))
	.add(HttpApiEndpoint.get("defect", "/defect", { success: Schema.String }))
	.add(
		HttpApiEndpoint.get("declared", "/declared", {
			success: Schema.String,
			error: [UpstreamError, ConflictError],
		}),
	)

class BoundaryApi extends HttpApi.make("BoundaryApi")
	.add(BoundaryGroup)
	.middleware(V1SchemaErrors)
	.middleware(V1UnexpectedErrors) {}

const BoundaryHandlersLive = HttpApiBuilder.group(BoundaryApi, "boundary", (handlers) =>
	Effect.succeed(
		handlers
			.handle("validate", ({ payload }) => Effect.succeed(payload.name))
			.handle("invalidResponse", () => Effect.succeed(42 as never))
			.handle("defect", () => Effect.die(new Error("database password must not cross the wire")))
			.handle("declared", ({ request }) =>
				request.headers["x-fail-with"] === "conflict"
					? Effect.fail(new ConflictError({ message: "already running" }))
					: Effect.fail(new UpstreamError({ message: "SELECT failed: memory limit exceeded" })),
			),
	),
)

interface RecordedLog {
	readonly level: string
	readonly message: string
	readonly annotations: Readonly<Record<string, unknown>>
}

/** A request context whose spans and log lines are kept, so the boundary's telemetry can be read. */
const makeRecordingContext = () => {
	const spans: Array<Tracer.NativeSpan> = []
	const logs: Array<RecordedLog> = []
	const tracer = Tracer.make({
		span(options) {
			const span = new Tracer.NativeSpan(options)
			spans.push(span)
			return span
		},
	})
	const logger = Logger.make(({ fiber, logLevel, message }) => {
		logs.push({
			level: logLevel,
			message: JSON.stringify(message),
			annotations: fiber.getRef(References.CurrentLogAnnotations),
		})
	})
	const context = Context.make(Tracer.Tracer, tracer).pipe(
		Context.add(Logger.CurrentLoggers, new Set([logger])),
	)
	return { spans, logs, context }
}

const makeHarness = () => {
	const routes = HttpApiBuilder.layer(BoundaryApi).pipe(
		Layer.provide(BoundaryHandlersLive),
		Layer.provide(V1ErrorBoundaryLive),
	)
	const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true })
	const request = async (
		method: string,
		path: string,
		body?: unknown,
		options: { headers?: Record<string, string>; context?: Context.Context<never> } = {},
	) => {
		const response = await handler(
			new Request(`http://maple.test${path}`, {
				method,
				headers: {
					...(body === undefined ? undefined : { "content-type": "application/json" }),
					...options.headers,
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			}),
			(options.context ?? Context.empty()) as never,
		)
		return { status: response.status, body: await response.json() }
	}
	return { request, dispose }
}

describe("v1 HTTP error boundary", () => {
	it("returns a structured, path-anchored 400 for every request decode failure", async () => {
		const harness = makeHarness()
		try {
			const response = await harness.request("POST", "/validate", { name: "" })
			expect(response.status).toBe(400)
			expect(response.body).toMatchObject({
				_tag: "@maple/http/v1/V1RequestValidationError",
				param: "name",
				details: [expect.stringContaining("name")],
			})
		} finally {
			await harness.dispose()
		}
	})

	it("logs defects and returns a sanitized 500", async () => {
		const harness = makeHarness()
		try {
			const response = await harness.request("GET", "/defect")
			expect(response.status).toBe(500)
			expect(response.body).toEqual({
				_tag: "@maple/http/v1/V1UnexpectedError",
				message: "An unexpected error occurred on our end.",
			})
			expect(JSON.stringify(response.body)).not.toContain("database password")
		} finally {
			await harness.dispose()
		}
	})

	// A declared 5xx passes the boundary as a plain value and is encoded from its class, so it
	// used to leave no log line and no span attribute: the api's query-engine 500s were invisible.
	it("logs a declared 5xx and names it on the span", async () => {
		const harness = makeHarness()
		const { spans, logs, context } = makeRecordingContext()
		try {
			const response = await harness.request("GET", "/declared", undefined, { context })
			expect(response.status).toBe(502)

			const log = logs.find((entry) => entry.message.includes("Route answered with a server error"))
			expect(log).toBeDefined()
			expect(log?.level).toBe("Error")
			expect(log?.annotations).toMatchObject({
				errorTag: "@maple/test/UpstreamError",
				status: 502,
				group: "boundary",
				operation: "declared",
				message: "SELECT failed: memory limit exceeded",
			})

			const span = spans.find((s) => s.attributes.get("error.type") === "@maple/test/UpstreamError")
			expect(span).toBeDefined()
			expect(span?.attributes.get("http.response.status_code")).toBe(502)
		} finally {
			await harness.dispose()
		}
	})

	it("stays quiet about a declared 4xx", async () => {
		const harness = makeHarness()
		const { spans, logs, context } = makeRecordingContext()
		try {
			const response = await harness.request("GET", "/declared", undefined, {
				headers: { "x-fail-with": "conflict" },
				context,
			})
			expect(response.status).toBe(409)
			expect(logs.filter((entry) => entry.level === "Error")).toEqual([])
			expect(spans.some((s) => s.attributes.has("error.type"))).toBe(false)
		} finally {
			await harness.dispose()
		}
	})

	it("treats an invalid handler response as a sanitized 500, not a caller 400", async () => {
		const harness = makeHarness()
		try {
			const response = await harness.request("GET", "/invalid-response")
			expect(response.status).toBe(500)
			expect(response.body).toEqual({
				_tag: "@maple/http/v1/V1UnexpectedError",
				message: "An unexpected error occurred on our end.",
			})
			expect(JSON.stringify(response.body)).not.toContain("42")
		} finally {
			await harness.dispose()
		}
	})
})

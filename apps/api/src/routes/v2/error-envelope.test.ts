import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Layer, Logger, References, Schema, Tracer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { WarehouseQueryError } from "@maple/domain/http"
import { publicError, V2SchemaErrors, V2UnexpectedErrors } from "@maple/domain/http/v2"
import { V2TransportErrorBoundaryLive } from "./error-envelope"

const ResponseSchemaGroup = HttpApiGroup.make("responseSchema")
	.add(HttpApiEndpoint.get("invalidResponse", "/invalid-response", { success: Schema.String }))
	.add(
		HttpApiEndpoint.get("declared", "/declared", {
			success: Schema.String,
			error: publicError(WarehouseQueryError),
		}),
	)

class ResponseSchemaApi extends HttpApi.make("ResponseSchemaApi")
	.add(ResponseSchemaGroup)
	.middleware(V2SchemaErrors)
	.middleware(V2UnexpectedErrors) {}

const ResponseSchemaHandlersLive = HttpApiBuilder.group(ResponseSchemaApi, "responseSchema", (handlers) =>
	Effect.succeed(
		handlers
			.handle("invalidResponse", () => Effect.succeed(42 as never))
			.handle("declared", () =>
				Effect.fail(
					new WarehouseQueryError({
						message: "Memory limit (for query) exceeded",
						pipeName: "service_usage",
					}),
				),
			),
	),
)

const makeHarness = () => {
	const routes = HttpApiBuilder.layer(ResponseSchemaApi).pipe(
		Layer.provide(ResponseSchemaHandlersLive),
		Layer.provide(V2TransportErrorBoundaryLive),
	)
	return HttpRouter.toWebHandler(routes, { disableLogger: true })
}

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

describe("v2 response schema boundary", () => {
	// A declared 5xx is encoded straight from its class and never touched the boundary's logging,
	// so a warehouse failure behind a 502 left no log line and no span attribute.
	it("logs a declared 5xx and names it on the span", async () => {
		const { handler, dispose } = makeHarness()
		const { spans, logs, context } = makeRecordingContext()
		try {
			const response = await handler(new Request("http://maple.test/declared"), context as never)
			expect(response.status).toBe(502)

			const log = logs.find((entry) => entry.message.includes("Route answered with a server error"))
			expect(log).toBeDefined()
			expect(log?.level).toBe("Error")
			expect(log?.annotations).toMatchObject({
				errorTag: "@maple/http/errors/WarehouseQueryError",
				status: 502,
				group: "responseSchema",
				operation: "declared",
				message: "Memory limit (for query) exceeded",
			})

			const span = spans.find(
				(s) => s.attributes.get("error.type") === "@maple/http/errors/WarehouseQueryError",
			)
			expect(span).toBeDefined()
			expect(span?.attributes.get("http.response.status_code")).toBe(502)
		} finally {
			await dispose()
		}
	})

	it("logs response drift and returns a sanitized 500 envelope", async () => {
		const { handler, dispose } = makeHarness()
		try {
			const response = await handler(
				new Request("http://maple.test/invalid-response"),
				Context.empty() as never,
			)
			const body = await response.json()
			expect(response.status).toBe(500)
			expect(body).toEqual({
				error: {
					_tag: "@maple/http/v2/ResponseSchemaError",
					type: "api_error",
					code: "internal_error",
					title: "Something went wrong",
					message: "An unexpected error occurred on our end.",
					retryable: false,
					recovery: "contact_support",
				},
			})
			expect(JSON.stringify(body)).not.toContain("42")
		} finally {
			await dispose()
		}
	})
})

import { SpanKind, SpanStatusCode } from "@opentelemetry/api"
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	type ReadableSpan,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { describe, expect, it } from "vitest"
import { HttpStatusExporter } from "./http-status"

const exported = new InMemorySpanExporter()
const tracerWith = (captureStatus?: ConstructorParameters<typeof HttpStatusExporter>[1]) =>
	new BasicTracerProvider({
		spanProcessors: [new SimpleSpanProcessor(new HttpStatusExporter(exported, captureStatus))],
	}).getTracer("test")
const tracer = tracerWith()

const finish = (
	build: (span: ReturnType<typeof tracer.startSpan>) => void,
	kind = SpanKind.CLIENT,
	using = tracer,
): ReadableSpan => {
	exported.reset()
	const span = using.startSpan("GET", { kind })
	build(span)
	span.end()
	const [result] = exported.getFinishedSpans()
	if (!result) throw new Error("nothing exported")
	return result
}

describe("HttpStatusExporter", () => {
	it("clears an Error set only because of the response status", () => {
		const span = finish((s) => {
			s.setAttribute("http.response.status_code", 404)
			s.setAttribute("error.type", "404")
			s.setStatus({ code: SpanStatusCode.ERROR })
		})
		expect(span.status.code).toBe(SpanStatusCode.UNSET)
		expect(span.attributes["error.type"]).toBeUndefined()
		expect(span.attributes["http.response.status_code"]).toBe(404)
		expect(span.spanContext().spanId).toMatch(/^[0-9a-f]{16}$/)
	})

	it("keeps network failures, recorded exceptions, and non-client spans", () => {
		const network = finish((s) => {
			s.setAttribute("error.type", "timeout")
			s.setStatus({ code: SpanStatusCode.ERROR, message: "timeout" })
		})
		expect(network.status.code).toBe(SpanStatusCode.ERROR)

		const withException = finish((s) => {
			s.setAttribute("error.type", "500")
			s.recordException(new Error("boom"))
			s.setStatus({ code: SpanStatusCode.ERROR })
		})
		expect(withException.status.code).toBe(SpanStatusCode.ERROR)

		const internal = finish((s) => {
			s.setAttribute("error.type", "500")
			s.setStatus({ code: SpanStatusCode.ERROR })
		}, SpanKind.INTERNAL)
		expect(internal.status.code).toBe(SpanStatusCode.ERROR)
	})
})

describe("errors.captureHttpStatus", () => {
	const capturing = tracerWith([[500, 599], 429])

	it("makes a listed status an Error, typed by the status and described by the request", () => {
		const span = finish(
			(s) => {
				s.setAttribute("http.request.method", "POST")
				s.setAttribute("url.full", "https://api.test/users/42?token=REDACTED")
				s.setAttribute("http.response.status_code", 503)
			},
			SpanKind.CLIENT,
			capturing,
		)
		expect(span.status.code).toBe(SpanStatusCode.ERROR)
		expect(span.attributes["error.type"]).toBe("503")
		expect(span.attributes["error.message"]).toBe("POST https://api.test/users/42 -> 503")
	})

	it("matches single codes and old-semconv attributes, and leaves the rest alone", () => {
		const limited = finish(
			(s) => {
				s.setAttribute("http.method", "GET")
				s.setAttribute("http.url", "https://api.test/search")
				s.setAttribute("http.status_code", 429)
			},
			SpanKind.CLIENT,
			capturing,
		)
		expect(limited.attributes["error.type"]).toBe("429")

		const notFound = finish(
			(s) => {
				s.setAttribute("http.response.status_code", 404)
				s.setAttribute("error.type", "404")
				s.setStatus({ code: SpanStatusCode.ERROR })
			},
			SpanKind.CLIENT,
			capturing,
		)
		expect(notFound.status.code).toBe(SpanStatusCode.UNSET)
	})

	it("keeps a network failure an error and describes it like a status error", () => {
		const failed = finish((s) => {
			s.setAttribute("http.request.method", "POST")
			s.setAttribute("url.full", "https://api.test/orders?id=7")
			s.setAttribute("http.response.status_code", 0)
			s.setAttribute("error.type", "TypeError")
			s.setStatus({ code: SpanStatusCode.ERROR, message: "Failed to fetch" })
		})
		expect(failed.status.code).toBe(SpanStatusCode.ERROR)
		expect(failed.attributes["error.message"]).toBe("POST https://api.test/orders -> TypeError")
	})
})

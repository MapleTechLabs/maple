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

describe("HttpStatusExporter, by default", () => {
	it("keeps 4xx and 5xx client spans Error, typed by the status, with no description", () => {
		for (const status of [404, 503]) {
			const span = finish((s) => {
				s.setAttribute("http.request.method", "POST")
				s.setAttribute("url.full", "https://api.test/users/42")
				s.setAttribute("http.response.status_code", status)
			})
			expect(span.status).toEqual({ code: SpanStatusCode.ERROR })
			expect(span.attributes["error.type"]).toBe(String(status))
			expect(span.attributes["error.message"]).toBeUndefined()
		}
	})

	it("leaves 2xx/3xx, recorded exceptions, network failures and non-client spans alone", () => {
		const ok = finish((s) => s.setAttribute("http.response.status_code", 204))
		expect(ok.status.code).toBe(SpanStatusCode.UNSET)

		const network = finish((s) => {
			s.setAttribute("error.type", "TypeError")
			s.setStatus({ code: SpanStatusCode.ERROR })
		})
		expect(network.status.code).toBe(SpanStatusCode.ERROR)
		expect(network.attributes["error.message"]).toBeUndefined()

		const withException = finish((s) => {
			s.setAttribute("http.response.status_code", 500)
			s.recordException(new Error("boom"))
			s.setStatus({ code: SpanStatusCode.ERROR })
		})
		expect(withException.status.code).toBe(SpanStatusCode.ERROR)

		const internal = finish((s) => {
			s.setAttribute("http.response.status_code", 500)
		}, SpanKind.INTERNAL)
		expect(internal.status.code).toBe(SpanStatusCode.UNSET)
	})
})

describe("errors.captureHttpStatus, narrowed", () => {
	const serverErrors = tracerWith([[500, 599], 429])

	it("keeps listed statuses Error, including old-semconv attributes", () => {
		const limited = finish((s) => s.setAttribute("http.status_code", 429), SpanKind.CLIENT, serverErrors)
		expect(limited.status.code).toBe(SpanStatusCode.ERROR)
		expect(limited.attributes["error.type"]).toBe("429")
	})

	it("clears the Error an instrumentation set for a status left out", () => {
		const notFound = finish(
			(s) => {
				s.setAttribute("http.response.status_code", 404)
				s.setAttribute("error.type", "404")
				s.setStatus({ code: SpanStatusCode.ERROR })
			},
			SpanKind.CLIENT,
			serverErrors,
		)
		expect(notFound.status.code).toBe(SpanStatusCode.UNSET)
		expect(notFound.attributes["error.type"]).toBeUndefined()
	})
})

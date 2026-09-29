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
const tracer = new BasicTracerProvider({
	spanProcessors: [new SimpleSpanProcessor(new HttpStatusExporter(exported))],
}).getTracer("test")

const finish = (
	build: (span: ReturnType<typeof tracer.startSpan>) => void,
	kind = SpanKind.CLIENT,
): ReadableSpan => {
	exported.reset()
	const span = tracer.startSpan("GET", { kind })
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

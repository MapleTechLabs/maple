import {
	defaultTextMapGetter,
	defaultTextMapSetter,
	propagation,
	ROOT_CONTEXT,
	TraceFlags,
	trace,
} from "@opentelemetry/api"
import { describe, expect, it } from "vitest"
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from "./propagation"
import { TraceState } from "./trace-state"

const propagator = new CompositePropagator([new W3CTraceContextPropagator(), new W3CBaggagePropagator()])
const SPAN = { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7" }

const inject = (context = ROOT_CONTEXT): Record<string, string> => {
	const headers: Record<string, string> = {}
	propagator.inject(context, headers, defaultTextMapSetter)
	return headers
}

describe("W3C propagation", () => {
	it("writes traceparent, tracestate and baggage, and reads back the same context", () => {
		const traceState = new TraceState("vendor=abc").set("ot", "th:8")
		const baggage = propagation.createBaggage({ "user tier": { value: "pro plan" } })
		const context = propagation.setBaggage(
			trace.setSpanContext(ROOT_CONTEXT, { ...SPAN, traceFlags: TraceFlags.SAMPLED, traceState }),
			baggage,
		)

		const headers = inject(context)
		expect(headers).toEqual({
			traceparent: `00-${SPAN.traceId}-${SPAN.spanId}-01`,
			tracestate: "ot=th:8,vendor=abc",
			baggage: "user%20tier=pro%20plan",
		})

		const extracted = propagator.extract(ROOT_CONTEXT, headers, defaultTextMapGetter)
		const spanContext = trace.getSpanContext(extracted)
		expect(spanContext).toMatchObject({ ...SPAN, traceFlags: TraceFlags.SAMPLED, isRemote: true })
		expect(spanContext?.traceState?.serialize()).toBe("ot=th:8,vendor=abc")
		expect(propagation.getBaggage(extracted)?.getEntry("user tier")?.value).toBe("pro plan")
	})

	it("ignores traceparent values the spec rejects", () => {
		const rejected = [
			`ff-${SPAN.traceId}-${SPAN.spanId}-01`,
			`00-${"0".repeat(32)}-${SPAN.spanId}-01`,
			`00-${SPAN.traceId}-${"0".repeat(16)}-01`,
			`00-${SPAN.traceId}-${SPAN.spanId}-01-extra`,
		]
		for (const traceparent of rejected) {
			const extracted = propagator.extract(ROOT_CONTEXT, { traceparent }, defaultTextMapGetter)
			expect(trace.getSpanContext(extracted)).toBeUndefined()
		}
	})

	it("writes the flags as exactly two hex digits", () => {
		const header = (traceFlags: number | undefined): string | undefined => {
			const context = trace.setSpanContext(ROOT_CONTEXT, { ...SPAN, traceFlags: traceFlags ?? 0 })
			// A plain-JS caller may leave the flags off entirely.
			if (traceFlags === undefined)
				Reflect.deleteProperty(trace.getSpanContext(context) ?? {}, "traceFlags")
			return inject(context)["traceparent"]?.split("-")[3]
		}
		expect([0x00, 0x01, 0x10, 0xff, Number.NaN, undefined].map(header)).toEqual([
			"00",
			"01",
			"10",
			"ff",
			"00",
			"00",
		])
	})

	it("keeps flags of 0x10 and above through extract and inject", () => {
		const traceparent = `00-${SPAN.traceId}-${SPAN.spanId}-11`
		const extracted = propagator.extract(ROOT_CONTEXT, { traceparent }, defaultTextMapGetter)
		expect(inject(extracted)["traceparent"]).toBe(traceparent)
	})

	it("writes nothing without a valid span context or baggage", () => {
		expect(inject()).toEqual({})
	})
})

describe("TraceState", () => {
	it("keeps the newest member first and drops invalid members", () => {
		const state = new TraceState("a=1, Bad=2 ,b=2,c")
		expect(state.serialize()).toBe("a=1,b=2")
		expect(state.set("b", "3").serialize()).toBe("b=3,a=1")
		expect(state.unset("a").serialize()).toBe("b=2")
		expect(state.get("Bad")).toBeUndefined()
	})
})

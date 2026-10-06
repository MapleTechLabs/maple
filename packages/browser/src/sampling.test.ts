import { clearSessionSink, publishSessionSink } from "@maple/browser-session"
import { ROOT_CONTEXT, trace, TraceFlags } from "@opentelemetry/api"
import { SamplingDecision } from "@opentelemetry/sdk-trace-base"
import { afterEach, describe, expect, it } from "vitest"
import { sessionRoll } from "@maple/sdk-core"
import { keepContext, SessionSampler } from "./sampling"

// The sampling math itself is tested in @maple/sdk-core; this is the OTel adapter.
const TRACE_ID = "0af7651916cd43dd8448eb211c80319c"
const parent = (flags: number) =>
	trace.setSpanContext(ROOT_CONTEXT, { traceId: TRACE_ID, spanId: "b7ad6b7169203331", traceFlags: flags })

afterEach(() => clearSessionSink())

describe("SessionSampler", () => {
	it("samples a whole session or none of it, and marks sampled roots with th", () => {
		const sampler = new SessionSampler(0.5)
		const ids = Array.from({ length: 40 }, (_, i) => `session-${i}`)
		const sampled = ids.filter((id) => sessionRoll(id) < 0.5)
		expect(sampled.length).toBeGreaterThan(0)
		expect(sampled.length).toBeLessThan(ids.length)
		for (const id of ids) {
			publishSessionSink(id)
			const decisions = new Set([0, 1, 2].map(() => sampler.shouldSample(ROOT_CONTEXT).decision))
			expect(decisions.size).toBe(1)
			const result = sampler.shouldSample(ROOT_CONTEXT)
			if (sampled.includes(id)) {
				expect(result.decision).toBe(SamplingDecision.RECORD_AND_SAMPLED)
				const ot = result.traceState?.get("ot") ?? ""
				expect(ot).toMatch(/^th:8;rv:[0-9a-f]{14}$/)
				// A consistent-probability sampler downstream keeps it too: rv >= th.
				expect(Number.parseInt(ot.split("rv:")[1] ?? "", 16)).toBeGreaterThanOrEqual(2 ** 55)
			} else {
				expect(result.decision).toBe(SamplingDecision.NOT_RECORD)
			}
		}
	})

	it("follows the parent's decision, including a server-rendered one", () => {
		const sampler = new SessionSampler(0)
		expect(sampler.shouldSample(parent(TraceFlags.SAMPLED)).decision).toBe(
			SamplingDecision.RECORD_AND_SAMPLED,
		)
		expect(new SessionSampler(1).shouldSample(parent(TraceFlags.NONE)).decision).toBe(
			SamplingDecision.NOT_RECORD,
		)
	})

	it("adds no th at rate 1, since every span is already weight 1", () => {
		publishSessionSink("any")
		const result = new SessionSampler(1).shouldSample(ROOT_CONTEXT)
		expect(result.decision).toBe(SamplingDecision.RECORD_AND_SAMPLED)
		expect(result.traceState).toBeUndefined()
	})

	it("always samples a kept context, detaching it from an unsampled parent", () => {
		const sampler = new SessionSampler(0)
		expect(sampler.shouldSample(keepContext(ROOT_CONTEXT)).decision).toBe(
			SamplingDecision.RECORD_AND_SAMPLED,
		)
		const kept = keepContext(parent(TraceFlags.NONE))
		expect(trace.getSpanContext(kept)).toBeUndefined()
		expect(sampler.shouldSample(kept).decision).toBe(SamplingDecision.RECORD_AND_SAMPLED)
		expect(trace.getSpanContext(keepContext(parent(TraceFlags.SAMPLED)))?.traceId).toBe(TRACE_ID)
	})
})

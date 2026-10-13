// The OTel adapter for the shared per-session sampling decision.
import { readSessionSink } from "@maple/browser-session"
import { sampleSession } from "@maple/sdk-core"
import {
	type Context,
	createContextKey,
	createTraceState,
	isSpanContextValid,
	trace,
	TraceFlags,
} from "@opentelemetry/api"
import { type Sampler, SamplingDecision, type SamplingResult } from "@opentelemetry/sdk-trace-base"

const KEEP = createContextKey("maple.sampling.keep")

/**
 * A context whose next span is always sampled, for errors. An unsampled parent
 * is dropped first, so the error exports as a root rather than an orphan.
 */
export function keepContext(ctx: Context): Context {
	const parent = trace.getSpanContext(ctx)
	const base = parent && (parent.traceFlags & TraceFlags.SAMPLED) === 0 ? trace.deleteSpan(ctx) : ctx
	return base.setValue(KEEP, true)
}

export class SessionSampler implements Sampler {
	constructor(private readonly rate: number) {}

	shouldSample(ctx: Context): SamplingResult {
		if (ctx.getValue(KEEP) === true) return { decision: SamplingDecision.RECORD_AND_SAMPLED }
		const parent = trace.getSpanContext(ctx)
		if (parent && isSpanContextValid(parent)) {
			return {
				decision:
					(parent.traceFlags & TraceFlags.SAMPLED) === 0
						? SamplingDecision.NOT_RECORD
						: SamplingDecision.RECORD_AND_SAMPLED,
			}
		}
		const decision = sampleSession(readSessionSink()?.sessionId, this.rate)
		if (!decision.sampled) return { decision: SamplingDecision.NOT_RECORD }
		// `createTraceState` parses the `ot=…` list member itself.
		return {
			decision: SamplingDecision.RECORD_AND_SAMPLED,
			...(decision.traceState ? { traceState: createTraceState(decision.traceState) } : undefined),
		}
	}

	toString(): string {
		return `MapleSessionSampler{${this.rate}}`
	}
}

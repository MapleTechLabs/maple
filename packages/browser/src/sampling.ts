// Head sampling, decided per session rather than per trace, so a session's
// replay never links to a trace that was dropped halfway through it.
import { readSessionSink } from "@maple/browser-session"
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

/** FNV-1a over the session id, mapped to [0, 1). */
export function sessionRoll(sessionId: string): number {
	let hash = 0x811c9dc5
	for (let i = 0; i < sessionId.length; i++) {
		hash ^= sessionId.charCodeAt(i)
		hash = Math.imul(hash, 0x01000193)
	}
	return (hash >>> 0) / 2 ** 32
}

/**
 * The W3C `ot=th:` rejection threshold for a sampling probability: 56 bits,
 * hex, trailing zeros dropped. Ingest reads it back as the span's weight.
 */
export function rejectionThreshold(probability: number): string {
	const threshold = Math.round((1 - probability) * 2 ** 56)
	return threshold.toString(16).padStart(14, "0").replace(/0+$/, "") || "0"
}

export class SessionSampler implements Sampler {
	private readonly threshold: string

	constructor(private readonly rate: number) {
		this.threshold = rejectionThreshold(rate)
	}

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
		if (this.rate >= 1) return { decision: SamplingDecision.RECORD_AND_SAMPLED }
		const sessionId = readSessionSink()?.sessionId
		const roll = sessionId ? sessionRoll(sessionId) : Math.random()
		if (roll >= this.rate) return { decision: SamplingDecision.NOT_RECORD }
		return {
			decision: SamplingDecision.RECORD_AND_SAMPLED,
			traceState: createTraceState().set("ot", `th:${this.threshold}`),
		}
	}

	toString(): string {
		return `MapleSessionSampler{${this.rate}}`
	}
}

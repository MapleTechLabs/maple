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

const MAX_56 = 2 ** 56

/** 56 bits as the 14-hex-digit form `ot=th`/`ot=rv` use; `th` drops trailing zeros. */
const hex56 = (value: number): string => value.toString(16).padStart(14, "0")

/**
 * The W3C `ot=th:` rejection threshold for a sampling probability: 56 bits,
 * hex, trailing zeros dropped. Ingest reads it back as the span's weight.
 */
export function rejectionThreshold(probability: number): string {
	return hex56(Math.round((1 - probability) * MAX_56)).replace(/0+$/, "") || "0"
}

/**
 * The session's randomness as the W3C `ot=rv:` value. The decision is `rv >= th`,
 * so a downstream consistent-probability sampler reaches the same answer as this
 * one instead of re-deciding from the trace id.
 */
export function randomnessValue(roll: number): number {
	return Math.min(MAX_56 - 1, Math.floor((1 - roll) * MAX_56))
}

export class SessionSampler implements Sampler {
	private readonly threshold: string
	private readonly thresholdValue: number

	constructor(private readonly rate: number) {
		this.threshold = rejectionThreshold(rate)
		this.thresholdValue = Math.round((1 - rate) * MAX_56)
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
		if (this.rate <= 0) return { decision: SamplingDecision.NOT_RECORD }
		const sessionId = readSessionSink()?.sessionId
		const rv = randomnessValue(sessionId ? sessionRoll(sessionId) : Math.random())
		if (rv < this.thresholdValue) return { decision: SamplingDecision.NOT_RECORD }
		return {
			decision: SamplingDecision.RECORD_AND_SAMPLED,
			traceState: createTraceState().set("ot", `th:${this.threshold};rv:${hex56(rv)}`),
		}
	}

	toString(): string {
		return `MapleSessionSampler{${this.rate}}`
	}
}

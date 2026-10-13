// Head sampling decided per session rather than per trace, so a session's
// replay never links to a trace that was dropped halfway through it. Pure: each
// SDK applies the decision in its own tracer.

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
 * so a downstream consistent-probability sampler reaches the same answer.
 */
export function randomnessValue(roll: number): number {
	return Math.min(MAX_56 - 1, Math.floor((1 - roll) * MAX_56))
}

export interface SamplingDecision {
	readonly sampled: boolean
	/** The `tracestate` value for a sampled trace at a rate below 1: `ot=th:…;rv:…`. */
	readonly traceState?: string | undefined
}

const KEEP: SamplingDecision = { sampled: true }
const DROP: SamplingDecision = { sampled: false }

/**
 * Whether a new root trace in `sessionId` is exported at `rate`. Without a
 * session (SSR, consent withheld) the roll is per trace.
 */
export function sampleSession(sessionId: string | undefined, rate: number): SamplingDecision {
	if (rate >= 1) return KEEP
	if (rate <= 0) return DROP
	const rv = randomnessValue(sessionId ? sessionRoll(sessionId) : Math.random())
	if (rv < Math.round((1 - rate) * MAX_56)) return DROP
	return { sampled: true, traceState: `ot=th:${rejectionThreshold(rate)};rv:${hex56(rv)}` }
}

/** A rate outside 0 to 1 is a typo, not a policy: clamp it and say so. */
export function resolveSampleRate(option: string, raw: number | undefined, fallback = 1): number {
	if (raw === undefined) return fallback
	if (typeof raw !== "number" || Number.isNaN(raw)) {
		console.warn(
			`[maple] ${option} must be a number between 0 and 1; got ${String(raw)}. Using ${fallback}.`,
		)
		return fallback
	}
	if (raw < 0 || raw > 1) {
		const clamped = Math.min(1, Math.max(0, raw))
		console.warn(`[maple] ${option} must be between 0 and 1; got ${raw}. Using ${clamped}.`)
		return clamped
	}
	return raw
}

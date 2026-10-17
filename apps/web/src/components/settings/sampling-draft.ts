import type { V2TraceSamplingPolicy } from "@maple/domain/http/v2"

/** The editable sampling fields as typed: a percentage and an optional millisecond threshold. */
export interface SamplingDraft {
	readonly keepPercent: string
	readonly slowMs: string
}

export const MIN_KEEP_PERCENT = 0.0001
const MAX_SLOW_MS = 2_147_483_647

/** Ratio to a percentage string without float noise: 0.07 shows as "7", not "7.000000000000001". */
export function ratioToPercent(ratio: number): string {
	return String(Number((ratio * 100).toPrecision(6)))
}

export function samplingDraftFromPolicy(
	policy: Pick<V2TraceSamplingPolicy, "trace_sample_ratio" | "always_keep_slow_spans_ms">,
): SamplingDraft {
	return {
		keepPercent: ratioToPercent(policy.trace_sample_ratio),
		slowMs: policy.always_keep_slow_spans_ms === null ? "" : String(policy.always_keep_slow_spans_ms),
	}
}

export type SamplingDraftResult =
	| {
			readonly ok: true
			readonly payload: {
				readonly trace_sample_ratio: number
				readonly always_keep_slow_spans_ms: number | null
			}
	  }
	| { readonly ok: false; readonly errors: { readonly keepPercent?: string; readonly slowMs?: string } }

const DECIMAL = /^\d+(\.\d+)?$/
const INTEGER = /^\d+$/

/** Parses the draft into the PATCH body, or says which field is wrong and why. */
export function validateSamplingDraft(draft: SamplingDraft): SamplingDraftResult {
	const percentText = draft.keepPercent.trim()
	const percent = Number(percentText)
	const keepPercent =
		!DECIMAL.test(percentText) || percent < MIN_KEEP_PERCENT || percent > 100
			? `Enter a percentage from ${MIN_KEEP_PERCENT} to 100.`
			: undefined

	const slowText = draft.slowMs.trim()
	const slow = Number(slowText)
	const slowMs =
		slowText.length > 0 && (!INTEGER.test(slowText) || slow < 1 || slow > MAX_SLOW_MS)
			? "Enter a whole number of milliseconds, or leave it empty."
			: undefined

	if (keepPercent !== undefined || slowMs !== undefined) {
		return { ok: false, errors: { keepPercent, slowMs } }
	}
	return {
		ok: true,
		payload: {
			// Dividing can land a hair outside the bounds the API checks, so clamp to them.
			trace_sample_ratio: Math.min(1, Math.max(MIN_KEEP_PERCENT / 100, percent / 100)),
			always_keep_slow_spans_ms: slowText.length === 0 ? null : slow,
		},
	}
}

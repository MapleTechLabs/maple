/** The bounds the API enforces on each auto-triage ceiling (`AiTriageSettingsUpdateRequest`). */
export const RUNS_PER_DAY_LIMITS = { min: 1, max: 500 } as const
export const PASSES_PER_DAY_LIMITS = { min: 1, max: 2000 } as const

export type ParsedLimit =
	| { readonly ok: true; readonly value: number }
	| { readonly ok: false; readonly message: string }

/** Reads a typed ceiling: a whole number within the API's bounds, or the reason it is not. */
export function parseDailyLimit(text: string, bounds: { min: number; max: number }): ParsedLimit {
	const trimmed = text.trim()
	const range = `Enter a whole number from ${bounds.min} to ${bounds.max}.`
	if (!/^\d+$/.test(trimmed)) return { ok: false, message: range }
	const value = Number(trimmed)
	if (value < bounds.min || value > bounds.max) return { ok: false, message: range }
	return { ok: true, value }
}

export interface AiTriageLimitsDraft {
	readonly maxRunsPerDay: string
	readonly maxPassesPerDay: string
}

/**
 * The update a draft amounts to: only the ceilings that changed, or the first validation error.
 * `null` fields mean unchanged, so a save never rewrites a ceiling the user did not touch.
 */
export function limitsUpdate(
	draft: AiTriageLimitsDraft,
	saved: { readonly maxRunsPerDay: number; readonly maxPassesPerDay: number },
):
	| { readonly ok: true; readonly maxRunsPerDay: number | null; readonly maxPassesPerDay: number | null }
	| { readonly ok: false } {
	const runs = parseDailyLimit(draft.maxRunsPerDay, RUNS_PER_DAY_LIMITS)
	const passes = parseDailyLimit(draft.maxPassesPerDay, PASSES_PER_DAY_LIMITS)
	if (!runs.ok || !passes.ok) return { ok: false }
	return {
		ok: true,
		maxRunsPerDay: runs.value === saved.maxRunsPerDay ? null : runs.value,
		maxPassesPerDay: passes.value === saved.maxPassesPerDay ? null : passes.value,
	}
}

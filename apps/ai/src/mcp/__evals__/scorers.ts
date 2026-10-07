import type { Scorer } from "./harness"

/**
 * Asserts the task's output contains every required substring and none of the
 * forbidden ones. Used to verify rendered tool output end-to-end (e.g. a
 * bounded `inspect_trace` emits "Showing N of M spans").
 */
export const OutputContainsScorer = (config: {
	readonly mustContain?: ReadonlyArray<string>
	readonly mustNotContain?: ReadonlyArray<string>
}): Scorer => ({
	name: "OutputContainsScorer",
	score: ({ output }) => {
		const missing = (config.mustContain ?? []).filter((needle) => !output.includes(needle))
		const unexpected = (config.mustNotContain ?? []).filter((needle) => output.includes(needle))
		const checks = (config.mustContain?.length ?? 0) + (config.mustNotContain?.length ?? 0)
		const failures = missing.length + unexpected.length
		return {
			score: checks === 0 ? 1 : (checks - failures) / checks,
			rationale:
				failures === 0
					? "all required substrings present"
					: `missing=${JSON.stringify(missing)} unexpected=${JSON.stringify(unexpected)}`,
		}
	},
})

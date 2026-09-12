import type { BaseScorerOptions, Score } from "vitest-evals"

// Tool-selection + argument matching is handled by vitest-evals' built-in
// `ToolCallScorer` (compares the task's returned `toolCalls` against the data
// item's `expectedTools`). This module only adds an output-substring scorer for
// full-execution evals, where we assert on the rendered tool output.

/**
 * Asserts the task's `output` string contains every required substring and none
 * of the forbidden ones. Used to verify rendered tool output end-to-end (e.g. a
 * bounded `inspect_trace` emits "Showing N of M spans").
 */
export function OutputContainsScorer(config: {
	readonly mustContain?: ReadonlyArray<string>
	readonly mustNotContain?: ReadonlyArray<string>
}) {
	return async function OutputContainsScorer(opts: BaseScorerOptions): Promise<Score> {
		const text = opts.output ?? ""
		const missing = (config.mustContain ?? []).filter((needle) => !text.includes(needle))
		const unexpected = (config.mustNotContain ?? []).filter((needle) => text.includes(needle))
		const checks = (config.mustContain?.length ?? 0) + (config.mustNotContain?.length ?? 0)
		const failures = missing.length + unexpected.length
		return {
			score: checks === 0 ? 1 : (checks - failures) / checks,
			metadata: {
				rationale:
					failures === 0
						? "all required substrings present"
						: `missing=${JSON.stringify(missing)} unexpected=${JSON.stringify(unexpected)}`,
			},
		}
	}
}

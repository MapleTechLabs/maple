import type { CodeProposal, CodeRunResult } from "./types.ts"
import { DEFAULT_OUTPUT_CAP_BYTES, PROPOSED_BATCH_STATUS } from "./types.ts"

const capText = (s: string, cap: number): string =>
	s.length > cap ? `${s.slice(0, cap)}\n...[truncated]` : s

/** Build the human/model-facing summary of a sandbox run. */
export const formatRunOutput = (result: CodeRunResult, cap = DEFAULT_OUTPUT_CAP_BYTES): string => {
	const parts: string[] = []

	if (result.crashed && result.error) {
		parts.push(`Code mode failed to run your snippet (${result.error.name}): ${result.error.message}`)
		return capText(parts.join("\n\n"), cap)
	}

	if (result.logs.length > 0) {
		parts.push(`Console output:\n${result.logs.join("\n")}`)
	}

	if (result.returnValue !== undefined) {
		let rendered: string
		try {
			rendered =
				typeof result.returnValue === "string"
					? result.returnValue
					: JSON.stringify(result.returnValue, null, 2)
		} catch {
			rendered = String(result.returnValue)
		}
		parts.push(`Return value:\n${rendered}`)
	}

	if (result.error) {
		parts.push(`Error (${result.error.name}): ${result.error.message}`)
	}

	if (parts.length === 0) {
		parts.push("(code ran with no console output and no return value)")
	}

	return capText(parts.join("\n\n"), cap)
}

/**
 * Hard cap on proposals surfaced from a single code run. A run queuing more than
 * this is almost certainly a mistake/runaway; bounding it keeps the returned
 * envelope (and the number of approval cards) from growing without limit.
 */
export const MAX_PROPOSALS_PER_RUN = 25

/**
 * The final string `run_code` returns to the model. When the run queued mutating
 * proposals (chat approval flow), wrap it as a `proposed_batch` envelope the web
 * client parses into one approval card per proposal; otherwise return the plain
 * summary so the model just reads its results. Both the inner `text` (via
 * `formatRunOutput`) and the proposal count are bounded so the envelope can't
 * grow unboundedly with the model's run.
 */
export const formatRunResult = (
	result: CodeRunResult,
	proposals: ReadonlyArray<CodeProposal> = [],
	cap = DEFAULT_OUTPUT_CAP_BYTES,
): string => {
	const text = formatRunOutput(result, cap)
	if (proposals.length === 0) return text

	const kept = proposals.slice(0, MAX_PROPOSALS_PER_RUN)
	const dropped = proposals.length - kept.length
	const queueNote =
		`\n\nQueued ${kept.length} change(s) for approval: ${kept.map((p) => p.tool).join(", ")}.` +
		(dropped > 0 ? ` (${dropped} more change(s) were dropped — keep code-mode runs to a few mutations.)` : "")
	return JSON.stringify({
		status: PROPOSED_BATCH_STATUS,
		proposals: kept,
		text: text + queueNote,
	})
}

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
 * The final string `run_code` returns to the model. When the run queued mutating
 * proposals (chat approval flow), wrap it as a `proposed_batch` envelope the web
 * client parses into one approval card per proposal; otherwise return the plain
 * summary so the model just reads its results.
 */
export const formatRunResult = (
	result: CodeRunResult,
	proposals: ReadonlyArray<CodeProposal> = [],
	cap = DEFAULT_OUTPUT_CAP_BYTES,
): string => {
	const text = formatRunOutput(result, cap)
	if (proposals.length === 0) return text
	const queueNote = `\n\nQueued ${proposals.length} change(s) for approval: ${proposals
		.map((p) => p.tool)
		.join(", ")}.`
	return JSON.stringify({
		status: PROPOSED_BATCH_STATUS,
		proposals,
		text: text + queueNote,
	})
}

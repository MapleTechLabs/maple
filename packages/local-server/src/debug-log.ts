// `--debug` (or MAPLE_DEBUG=1) surfaces diagnostics on stderr, so stdout stays
// clean. Read straight from argv/env: the code that emits these lines runs
// outside any parsed-flag context. The CLI's styled printer shares this switch.

export const debugEnabled = (): boolean =>
	(typeof process !== "undefined" && Array.isArray(process.argv) && process.argv.includes("--debug")) ||
	process.env.MAPLE_DEBUG === "1"

/** Emit a plain debug line to stderr (no-op unless debug is enabled). */
export const debugLog = (label: string, detail?: string): void => {
	if (!debugEnabled()) return
	process.stderr.write(`[debug] ${label}\n`)
	if (detail) process.stderr.write(`${detail}\n`)
}

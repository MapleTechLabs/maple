// `--debug` (or MAPLE_DEBUG=1) surfaces the compiled SQL and per-query timing on
// stderr, so stdout stays clean JSON for piping. Read straight from argv: like
// the mode resolver (core/mode.ts), the executor that emits these lines is built
// outside the parsed-flag context, so it scans argv rather than threading a flag.

import { dim, gray } from "./style"

export const debugEnabled = (): boolean =>
	(typeof process !== "undefined" && Array.isArray(process.argv) && process.argv.includes("--debug")) ||
	process.env.MAPLE_DEBUG === "1"

/** Emit a debug line to stderr (no-op unless debug is enabled). */
export const debugLog = (label: string, detail?: string): void => {
	if (!debugEnabled()) return
	process.stderr.write(`${gray("[debug]")} ${label}\n`)
	if (detail) process.stderr.write(`${dim(detail)}\n`)
}

/** Whether warehouse diagnostics should reach stderr: `--debug` or an explicit `--log-level`. */
export const verboseLogging = (): boolean =>
	debugEnabled() || process.argv.some((arg) => arg === "--log-level" || arg.startsWith("--log-level="))

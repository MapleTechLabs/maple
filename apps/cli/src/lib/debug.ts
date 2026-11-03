// `--debug` (or MAPLE_DEBUG=1) surfaces the compiled SQL and per-query timing on
// stderr, so stdout stays clean JSON for piping. Read straight from argv: like
// the mode resolver (core/mode.ts), the executor that emits these lines is built
// outside the parsed-flag context, so it scans argv rather than threading a flag.

import { debugEnabled } from "@maple/local-server/debug-log"
import { dim, gray } from "./style"
import { Array as Arr, String as Str } from "effect"

/** Emit a debug line to stderr (no-op unless debug is enabled). */
export const debugLog = (label: string, detail?: string): void => {
	if (!debugEnabled()) return
	process.stderr.write(`${gray("[debug]")} ${label}\n`)
	if (detail) process.stderr.write(`${dim(detail)}\n`)
}

/** Whether warehouse diagnostics should reach stderr: `--debug` or an explicit `--log-level`. */
export const verboseLogging = (): boolean =>
	debugEnabled() ||
	Arr.some(process.argv, (arg) => arg === "--log-level" || Str.startsWith("--log-level=")(arg))

// Uncaught errors that are not the app's: a browser extension's own failures and
// the benign `ResizeObserver loop` notice. `@maple/browser` drops the same two.

const EXTENSION_URL = /^(?:chrome|moz|safari(?:-web)?|ms-browser)-extension:\/\//
const BENIGN_MESSAGE = /^ResizeObserver loop (?:limit exceeded|completed with undelivered notifications)/

/** The stack's first frame: after `at ` (V8), else after `@` (SpiderMonkey, JavaScriptCore). */
const topFrame = (stack: string): string | undefined => {
	const lines = stack.split("\n").map((line) => line.trim())
	// V8 opens with the message line, which may itself contain an `@`.
	const v8 = lines.find((line) => line.startsWith("at "))
	if (v8 !== undefined) {
		const open = v8.indexOf("(")
		return open === -1 ? v8.slice(3) : v8.slice(open + 1)
	}
	const frame = lines.find((line) => line.includes("@"))
	return frame === undefined ? undefined : frame.slice(frame.indexOf("@") + 1)
}

/** True for an error the page's own code did not throw. `filename` is `ErrorEvent.filename`. */
export const isBrowserNoise = (error: unknown, filename?: string): boolean => {
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : ""
	if (BENIGN_MESSAGE.test(message)) return true
	if (filename !== undefined && EXTENSION_URL.test(filename)) return true
	const frame =
		error instanceof Error && typeof error.stack === "string" ? topFrame(error.stack) : undefined
	return frame !== undefined && EXTENSION_URL.test(frame)
}

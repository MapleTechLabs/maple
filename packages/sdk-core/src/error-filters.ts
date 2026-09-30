// Client-side error filtering: runs before an error span exists, so a dropped
// error costs nothing and never reaches an issue.
import type { HttpStatusRange } from "./http-status"

export type ErrorSource = "captureException" | "window.onerror" | "unhandledrejection"

export interface ErrorFilterHint {
	readonly source: ErrorSource
	/** What was thrown, before it was normalized into an `Error`. */
	// BOUNDARY: a thrown value is unparsed by definition.
	readonly originalError: unknown
}

export interface ErrorFilterOptions {
	/** Drop errors whose `Name: message` contains a string or matches a RegExp. */
	readonly ignore?: ReadonlyArray<string | RegExp>
	/** Report only errors whose top frame's script URL matches one of these. Errors with no frames are kept. */
	readonly allowUrls?: ReadonlyArray<string | RegExp>
	/** Drop errors whose top frame's script URL matches one of these. */
	readonly denyUrls?: ReadonlyArray<string | RegExp>
	/** Return `false` to drop the error. Runs after the lists; if it throws, the error is kept. */
	readonly beforeCapture?: (error: Error, hint: ErrorFilterHint) => boolean
	/**
	 * HTTP response statuses that make a client request span an error (and so an
	 * issue), e.g. `[[500, 599]]`. Default none: a response status alone is not
	 * an error, and a network failure always is.
	 */
	readonly captureHttpStatus?: ReadonlyArray<HttpStatusRange>
	/**
	 * Drop errors thrown from browser extensions and the benign `ResizeObserver
	 * loop` notices. Default true.
	 */
	readonly defaultFilters?: boolean
}

/** `(error, hint, frameUrl?) => keep`. `frameUrl` is the top frame's script URL when the caller knows it. */
export type ErrorFilter = (error: Error, hint: ErrorFilterHint, frameUrl?: string) => boolean

const EXTENSION_URL = /^(?:chrome|moz|safari(?:-web)?|ms-browser)-extension:\/\//
const BENIGN_MESSAGES = [/^ResizeObserver loop (?:limit exceeded|completed with undelivered notifications)/]

const URL_SCHEME = /^[a-z][\w+.-]*:\/\//i
const DIGITS = /^\d+$/

/**
 * The script URL of one frame: `at fn (url:1:2)`, `at url:1:2` (V8) or `fn@url:1:2`
 * (SpiderMonkey, JavaScriptCore). Parsed by position, not one regex: a stack is page
 * data, and a backtracking pattern over it can be made to run in polynomial time.
 */
function frameUrl(line: string): string | undefined {
	let frame = line.trim()
	if (frame.endsWith(")")) {
		const open = frame.lastIndexOf("(")
		if (open === -1) return undefined
		frame = frame.slice(open + 1, -1)
	} else if (frame.startsWith("at ")) {
		frame = frame.slice(3)
	} else {
		const at = frame.lastIndexOf("@")
		if (at === -1) return undefined
		frame = frame.slice(at + 1)
	}
	// `:line` and an optional `:column` come off the end; at least the line must be there.
	for (let parts = 0; parts < 2; parts++) {
		const colon = frame.lastIndexOf(":")
		if (colon === -1 || !DIGITS.test(frame.slice(colon + 1))) {
			if (parts === 0) return undefined
			break
		}
		frame = frame.slice(0, colon)
	}
	if (!URL_SCHEME.test(frame) || /[\s()]/.test(frame)) return undefined
	return frame
}

/** The script URL of each stack frame, top first. */
export function frameUrls(stack: string | undefined): string[] {
	if (!stack) return []
	const urls: string[] = []
	for (const line of stack.split("\n")) {
		const url = frameUrl(line)
		if (url) urls.push(url)
	}
	return urls
}

const matches = (value: string, patterns: ReadonlyArray<string | RegExp>): boolean =>
	patterns.some((pattern) => {
		if (typeof pattern === "string") return value.includes(pattern)
		// A `g`/`y` regex is stateful: `test` advances `lastIndex`, so reset it first.
		pattern.lastIndex = 0
		return pattern.test(value)
	})

/**
 * Build the filter for `options`. Without a `frameUrl`, only a thrown `Error`
 * has frames of its own: an `Error` wrapped around anything else points at the
 * SDK, so no URL list applies to it.
 */
export function makeErrorFilter(options: ErrorFilterOptions = {}): ErrorFilter {
	return (error, hint, frameUrl) => {
		const text = `${error.name}: ${error.message}`
		const topUrl =
			frameUrl ?? (hint.originalError instanceof Error ? frameUrls(error.stack)[0] : undefined)
		if (options.defaultFilters !== false) {
			if (matches(error.message, BENIGN_MESSAGES)) return false
			if (topUrl && EXTENSION_URL.test(topUrl)) return false
		}
		if (options.ignore && matches(text, options.ignore)) return false
		if (topUrl && options.denyUrls && matches(topUrl, options.denyUrls)) return false
		if (topUrl && options.allowUrls?.length && !matches(topUrl, options.allowUrls)) return false
		if (!options.beforeCapture) return true
		try {
			return options.beforeCapture(error, hint) !== false
		} catch {
			return true
		}
	}
}

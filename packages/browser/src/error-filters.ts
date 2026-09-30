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
	 * HTTP response statuses that make a `fetch`/XHR span an error (and so an
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

const EXTENSION_URL = /^(?:chrome|moz|safari(?:-web)?|ms-browser)-extension:\/\//
const BENIGN_MESSAGES = [/^ResizeObserver loop (?:limit exceeded|completed with undelivered notifications)/]

// `at fn (url:1:2)`, `at url:1:2` (V8) and `fn@url:1:2` (SpiderMonkey, JavaScriptCore).
const FRAME_URL = /(?:^\s*at (?:.*?\()?|@)([a-z][\w+.-]*:\/\/[^\s()]+?)(?::\d+){1,2}\)?\s*$/i

/** The script URL of each stack frame, top first. */
export function frameUrls(stack: string | undefined): string[] {
	if (!stack) return []
	const urls: string[] = []
	for (const line of stack.split("\n")) {
		const url = FRAME_URL.exec(line)?.[1]
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

let options: ErrorFilterOptions = {}

export function configureErrorFilters(next: ErrorFilterOptions | undefined): void {
	options = next ?? {}
}

/**
 * Whether `error` should be reported. `frameUrl`, when given, is the top frame's
 * script URL (`window.onerror`'s filename). Otherwise only a thrown `Error` has
 * frames of its own: the stack of an `Error` wrapped around anything else points
 * at this SDK, so no URL list applies to it.
 */
export function shouldCapture(error: Error, hint: ErrorFilterHint, frameUrl?: string): boolean {
	const text = `${error.name}: ${error.message}`
	const topUrl = frameUrl ?? (hint.originalError instanceof Error ? frameUrls(error.stack)[0] : undefined)
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

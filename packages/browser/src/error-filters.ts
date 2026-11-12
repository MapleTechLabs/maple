// The filter `init()` configured, shared by the global handlers and `captureException`.
import {
	asError,
	type ErrorFilter,
	type ErrorFilterOptions,
	type ErrorSource,
	makeErrorFilter,
} from "@maple/sdk-core"

let filter: ErrorFilter = makeErrorFilter()
/** The default filters alone, unless the app turned them off. */
let defaults: ErrorFilter = makeErrorFilter()

export function configureErrorFilters(next: ErrorFilterOptions | undefined): void {
	filter = makeErrorFilter(next)
	defaults = makeErrorFilter(next?.defaultFilters === false ? { defaultFilters: false } : {})
}

/**
 * True for an uncaught error the default filters drop (a browser extension's, the
 * benign `ResizeObserver loop` notice): it is no session error either. The app's
 * own `ignore` lists and `beforeCapture` decide issues only, and run once per error.
 */
export const isErrorNoise = (error: unknown, source: ErrorSource, filename?: string): boolean =>
	!defaults(asError(error), { source, originalError: error }, filename)

export const shouldCapture: ErrorFilter = (error, hint, frameUrl) => filter(error, hint, frameUrl)

// Uncaught errors that are not the app's: a browser extension's own failures and
// the benign `ResizeObserver loop` notice. The patterns are `@maple/sdk-core`'s
// default filters, the same ones `@maple/browser` applies.
import { asError, type ErrorSource, makeErrorFilter } from "@maple/sdk-core"

const defaultFilters = makeErrorFilter()

/** True for an error the page's own code did not throw. `filename` is `ErrorEvent.filename`. */
export const isBrowserNoise = (error: unknown, source: ErrorSource, filename?: string): boolean =>
	!defaultFilters(asError(error), { source, originalError: error }, filename || undefined)

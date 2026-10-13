// The filter `init()` configured, shared by the global handlers and `captureException`.
import { type ErrorFilter, type ErrorFilterOptions, makeErrorFilter } from "@maple/sdk-core"

let filter: ErrorFilter = makeErrorFilter()

export function configureErrorFilters(next: ErrorFilterOptions | undefined): void {
	filter = makeErrorFilter(next)
}

export const shouldCapture: ErrorFilter = (error, hint, frameUrl) => filter(error, hint, frameUrl)

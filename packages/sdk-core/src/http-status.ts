// One rule for when an HTTP client span is an error, whichever SDK or
// instrumentation made it. By default it is the HTTP semantic conventions' rule:
// a 4xx or 5xx response makes a client span Error, with `error.type` set to the
// status code and no status description. `errors.captureHttpStatus` narrows the
// statuses that count. A network failure is always an error.

/** A status code, or an inclusive `[from, to]` range. */
export type HttpStatusRange = number | readonly [number, number]

/** A span attribute value as OTel models it; an SDK with looser values narrows them before asking. */
export type AttributeValue =
	| string
	| number
	| boolean
	| ReadonlyArray<string | number | boolean | null | undefined>

/** Reads one attribute of the span being classified. */
export type ReadAttribute = (key: string) => AttributeValue | undefined

/** The statuses the HTTP semantic conventions make a client span Error for: every 4xx and 5xx. */
export const DEFAULT_ERROR_STATUS: ReadonlyArray<HttpStatusRange> = [[400, 599]]

export const inStatusRanges = (status: number, ranges: ReadonlyArray<HttpStatusRange>): boolean =>
	ranges.some((range) =>
		typeof range === "number" ? range === status : status >= range[0] && status <= range[1],
	)

/** The status on a span's attributes, current or pre-1.23 semconv key. */
export function responseStatus(read: ReadAttribute): number | undefined {
	const value = read("http.response.status_code") ?? read("http.status_code")
	if (typeof value === "number") return value
	if (typeof value === "string" && /^\d{3}$/.test(value)) return Number(value)
	return undefined
}

/**
 * The `error.type` for a counted status or a network failure (`TypeError`,
 * `timeout`), per the HTTP semantic conventions. No message: `error.message` is
 * deprecated, and the status code already says what went wrong.
 */
export function httpErrorType(status: number | string): { readonly "error.type": string } {
	return { "error.type": String(status) }
}

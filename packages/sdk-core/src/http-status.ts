// One rule for when an HTTP client span is an error, whichever SDK or
// instrumentation made it: a response status is an error only when the app
// lists it in `errors.captureHttpStatus`; a network failure always is.

/** A status code, or an inclusive `[from, to]` range. */
export type HttpStatusRange = number | readonly [number, number]

export const inStatusRanges = (status: number, ranges: ReadonlyArray<HttpStatusRange>): boolean =>
	ranges.some((range) =>
		typeof range === "number" ? range === status : status >= range[0] && status <= range[1],
	)

/** The status on a span's attributes, current or pre-1.23 semconv key. */
export function responseStatus(read: (key: string) => unknown): number | undefined {
	const value = read("http.response.status_code") ?? read("http.status_code")
	if (typeof value === "number") return value
	if (typeof value === "string" && /^\d{3}$/.test(value)) return Number(value)
	return undefined
}

/**
 * The `error.type` / `error.message` pair for a listed status or a network
 * failure (`TypeError`, `timeout`), e.g. `POST https://api.example.com/users/42 -> 503`.
 * The query is dropped; ids in the path are redacted by the issue fingerprint.
 */
export function httpStatusError(
	read: (key: string) => unknown,
	status: number | string,
): { readonly "error.type": string; readonly "error.message": string } {
	const method = read("http.request.method") ?? read("http.method") ?? "GET"
	const url = String(read("url.full") ?? read("http.url") ?? "").replace(/[?#].*$/, "")
	return { "error.type": String(status), "error.message": `${String(method)} ${url} -> ${status}` }
}

import type { Span } from "@opentelemetry/api"

/** `getAllResponseHeaders()` text as a lower-cased map: only the headers CORS exposes are in it. */
export function responseHeaders(raw: string): Map<string, string> {
	const headers = new Map<string, string>()
	for (const line of raw.split(/\r?\n/)) {
		const colon = line.indexOf(":")
		if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim())
	}
	return headers
}

/** Stamp the listed headers that `read` finds. Cross-origin responses expose only CORS-safelisted headers unless the server lists more in `Access-Control-Expose-Headers`. */
export function setHeaderAttributes(
	span: Span,
	direction: "request" | "response",
	names: ReadonlyArray<string>,
	read: (name: string) => string | null | undefined,
): void {
	for (const name of names) {
		const value = read(name)
		// One entry: commas are part of many values (`date`, `cache-control`), and the
		// browser has already joined repeated headers into one string.
		if (value) span.setAttribute(`http.${direction}.header.${name}`, [value])
	}
}

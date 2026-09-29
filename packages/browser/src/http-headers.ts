// Allowlisted request/response headers as the HTTP semconv span attributes
// `http.request.header.<name>` / `http.response.header.<name>` (string arrays).
import type { Span } from "@opentelemetry/api"

/** Never recorded, even when listed: they carry credentials. */
const CREDENTIAL_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie"])

export interface HeaderCapture {
	readonly request: ReadonlyArray<string>
	readonly response: ReadonlyArray<string>
}

export function resolveHeaderCapture(
	raw: { readonly request?: ReadonlyArray<string>; readonly response?: ReadonlyArray<string> } | undefined,
): HeaderCapture {
	const clean = (names: ReadonlyArray<string> | undefined) =>
		(names ?? []).map((name) => name.toLowerCase()).filter((name) => !CREDENTIAL_HEADERS.has(name))
	return { request: clean(raw?.request), response: clean(raw?.response) }
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

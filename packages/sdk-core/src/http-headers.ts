// Allowlisted request/response headers as the HTTP semconv span attributes
// `http.request.header.<name>` / `http.response.header.<name>` (string arrays).
import type { AttributeValue } from "./http-status"

/** Never recorded, even when listed: they carry credentials. */
const CREDENTIAL_HEADERS = new Set([
	"authorization",
	"proxy-authorization",
	"cookie",
	"set-cookie",
	"x-api-key",
])

export interface HeaderCaptureOptions {
	readonly request?: ReadonlyArray<string>
	readonly response?: ReadonlyArray<string>
}

export interface HeaderCapture {
	readonly request: ReadonlyArray<string>
	readonly response: ReadonlyArray<string>
}

export function resolveHeaderCapture(raw: HeaderCaptureOptions | undefined): HeaderCapture {
	const clean = (names: ReadonlyArray<string> | undefined) =>
		(names ?? []).map((name) => name.toLowerCase()).filter((name) => !CREDENTIAL_HEADERS.has(name))
	return { request: clean(raw?.request), response: clean(raw?.response) }
}

const HEADER_ATTRIBUTE = /^http\.(request|response)\.header\.(.+)$/

/**
 * Keep a `http.<direction>.header.<name>` attribute only when `<name>` is
 * allowlisted, as a one-element string array. Returns `undefined` to drop it,
 * and passes any other attribute through untouched.
 */
export function filterHeaderAttribute(
	capture: HeaderCapture,
	key: string,
	value: AttributeValue | undefined,
): AttributeValue | undefined {
	const match = HEADER_ATTRIBUTE.exec(key)
	if (!match) return value
	const names = match[1] === "request" ? capture.request : capture.response
	const name = (match[2] ?? "").toLowerCase()
	if (!names.includes(name) || value === undefined || value === "") return undefined
	// One entry: commas are part of many values (`date`, `cache-control`).
	return isList(value) ? value.map(String) : [String(value)]
}

const isList = (value: AttributeValue): value is Extract<AttributeValue, ReadonlyArray<unknown>> =>
	Array.isArray(value)

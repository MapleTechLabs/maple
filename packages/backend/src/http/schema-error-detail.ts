/**
 * Turns an `HttpApiSchemaError` (the framework's request-decode failure) into
 * human-readable, path-anchored lines.
 *
 * The runtime's own response for a decode failure is an empty 400 (no field,
 * no value, no message), which leaves callers bisecting their payload widget by
 * widget to find the one bad key. Every route that can reject a hand-authored
 * document should render the issue tree instead.
 *
 * Each line reads `<json path>: Expected …`; the path identifies an array element
 * positionally (`widgets[0]`).
 */
import { SchemaIssue, Array as Arr } from "effect"

/** Which part of the request failed to decode; mirrors `HttpApiSchemaError.kind`. */
export type SchemaErrorKind = "Params" | "Headers" | "Query" | "Body" | "Payload" | "ResponseHeaders"

/** Formats a path as `dashboard.widgets[3].display.fillNulls`. */
const formatIssuePath = (path: ReadonlyArray<PropertyKey>): string => {
	let out = ""
	for (const segment of path) {
		if (typeof segment === "number") {
			out += `[${segment}]`
		} else if (typeof segment === "symbol") {
			out += out === "" ? (segment.description ?? "<symbol>") : `.${segment.description ?? "<symbol>"}`
		} else {
			out += out === "" ? segment : `.${segment}`
		}
	}
	return out
}

const formatStandard = SchemaIssue.makeFormatterStandardSchemaV1()

export interface SchemaIssueDetail {
	/** Dotted/bracketed JSON path of the offending value, `""` at the root. */
	readonly path: string
	/** Expected-vs-received message(s) for this path, joined with `; `. */
	readonly message: string
	/** `path: message`, the string surfaced to API callers. */
	readonly line: string
}

/** Hard cap so a wholesale-malformed document can't produce a megabyte of 400. */
const MAX_DETAILS = 20

/**
 * Flattens a decode failure into one entry per offending path. Issues sharing a
 * path (union branches, most commonly) are merged so a two-branch union reads as
 * one problem rather than two.
 */
export const describeSchemaIssue = (issue: SchemaIssue.Issue): ReadonlyArray<SchemaIssueDetail> => {
	const byPath = new Map<string, Array<string>>()

	for (const entry of formatStandard(issue).issues) {
		// Standard Schema allows either a bare key or a `{ key }` segment object.
		const path = Arr.map(entry.path ?? [], (segment) =>
			typeof segment === "object" && segment !== null ? segment.key : segment,
		)
		const key = formatIssuePath(path)
		const existing = byPath.get(key)
		if (existing === undefined) {
			byPath.set(key, [entry.message])
		} else if (!existing.includes(entry.message)) {
			existing.push(entry.message)
		}
	}

	const details: Array<SchemaIssueDetail> = []
	for (const [key, messages] of byPath) {
		const message = Arr.join(messages, "; ")
		const location = key === "" ? "<root>" : key
		details.push({ path: key, message, line: `${location}: ${message}` })
		if (details.length === MAX_DETAILS) break
	}
	return details
}

const KIND_LABEL: Record<SchemaErrorKind, string> = {
	Params: "path parameters",
	Headers: "headers",
	Query: "query string",
	Body: "body",
	Payload: "payload",
	ResponseHeaders: "response headers",
} satisfies Record<SchemaErrorKind, string>

/** `Request payload is invalid (2 problems).`: the summary line for the 400. */
export const summarizeSchemaError = (
	kind: SchemaErrorKind,
	details: ReadonlyArray<SchemaIssueDetail>,
): string => {
	const label = KIND_LABEL[kind]
	if (details.length === 0) return `Request ${label} is invalid.`
	const count = details.length === 1 ? "1 problem" : `${details.length} problems`
	return `Request ${label} is invalid (${count}).`
}

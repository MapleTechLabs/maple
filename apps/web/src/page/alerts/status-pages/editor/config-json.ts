import {
	diffStatusPageConfig,
	StatusPageComponentPublicId,
	StatusPageConfig,
	type StatusPageConfigChanges,
	type V2StatusPage,
	type V2StatusPageComponent,
} from "@maple/domain/http/v2"
import { Result, Schema, SchemaIssue } from "effect"

// The JSON tab's document: the loaded page as a `StatusPageConfig`, and a draft parsed back.

/** The same document `GET /v2/status_pages/{id}/config` returns, from the reads already loaded. */
export const configOf = (
	page: V2StatusPage,
	components: ReadonlyArray<V2StatusPageComponent>,
): StatusPageConfig => ({
	name: page.name,
	slug: page.slug,
	description: page.description,
	website_url: page.website_url,
	logo_url: page.logo_url,
	show_powered_by: page.show_powered_by,
	auto_incidents: page.auto_incidents,
	theme: page.theme,
	components: components.map((component) => ({
		id: component.id,
		name: component.name,
		description: component.description,
		group: component.group,
		monitor_id: component.monitor_id,
		manual_status: component.manual_status,
		show_uptime: component.show_uptime,
	})),
})

const encodeConfig = Schema.encodeSync(StatusPageConfig)
const encodeId = Schema.encodeSync(StatusPageComponentPublicId)

/** Pretty-printed with public ids, two-space indent. */
export const formatConfig = (config: StatusPageConfig): string =>
	JSON.stringify(encodeConfig(config), null, 2)

export type DraftProblem =
	| { readonly _tag: "Syntax"; readonly message: string; readonly line: number; readonly column: number }
	| { readonly _tag: "Schema"; readonly path: string; readonly message: string }

export type DraftResult = Result.Result<
	{ readonly config: StatusPageConfig; readonly changes: StatusPageConfigChanges },
	DraftProblem
>

// JSON SYNTAX
// Engines word (and locate) parse errors differently, so a small scanner finds the first one.

const WHITESPACE = /[ \t\n\r]*/y
const STRING = /"(?:[^"\\\n\r\t]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y
const LITERAL = /true|false|null/y

type Scan =
	| { readonly ok: true; readonly at: number }
	| { readonly ok: false; readonly at: number; readonly message: string }

const skip = (text: string, at: number): number => {
	WHITESPACE.lastIndex = at
	WHITESPACE.test(text)
	return WHITESPACE.lastIndex
}

const token = (pattern: RegExp, text: string, at: number): number | null => {
	pattern.lastIndex = at
	return pattern.test(text) ? pattern.lastIndex : null
}

const fail = (at: number, message: string): Scan => ({ ok: false, at, message })

const scanString = (text: string, at: number): Scan => {
	const end = token(STRING, text, at)
	return end === null ? fail(at, "Unterminated or invalid string") : { ok: true, at: end }
}

const scanMembers = (
	text: string,
	at: number,
	close: "}" | "]",
	member: (text: string, at: number) => Scan,
): Scan => {
	const scanned = member(text, skip(text, at))
	if (!scanned.ok) return scanned
	const next = skip(text, scanned.at)
	if (text[next] === ",") return scanMembers(text, next + 1, close, member)
	if (text[next] === close) return { ok: true, at: next + 1 }
	return fail(next, `Expected ',' or '${close}'`)
}

const scanProperty = (text: string, at: number): Scan => {
	if (text[at] !== '"') return fail(at, "Expected a double-quoted property name")
	const key = scanString(text, at)
	if (!key.ok) return key
	const colon = skip(text, key.at)
	if (text[colon] !== ":") return fail(colon, "Expected ':' after the property name")
	return scanValue(text, skip(text, colon + 1))
}

const scanValue = (text: string, at: number): Scan => {
	const char = text[at]
	if (char === "{") {
		const inner = skip(text, at + 1)
		return text[inner] === "}" ? { ok: true, at: inner + 1 } : scanMembers(text, inner, "}", scanProperty)
	}
	if (char === "[") {
		const inner = skip(text, at + 1)
		return text[inner] === "]"
			? { ok: true, at: inner + 1 }
			: scanMembers(text, inner, "]", (source, from) => scanValue(source, from))
	}
	if (char === '"') return scanString(text, at)
	const end = token(NUMBER, text, at) ?? token(LITERAL, text, at)
	if (end !== null) return { ok: true, at: end }
	return fail(at, at >= text.length ? "Unexpected end of the document" : "Expected a value")
}

const locate = (text: string, at: number) => {
	const before = text.slice(0, at).split("\n")
	return { line: before.length, column: (before.at(-1)?.length ?? 0) + 1 }
}

const syntaxProblem = (text: string): DraftProblem => {
	const scanned = scanValue(text, skip(text, 0))
	const end = scanned.ok ? skip(text, scanned.at) : scanned.at
	const message = scanned.ok ? "Unexpected text after the document" : scanned.message
	return { _tag: "Syntax", message, ...locate(text, Math.min(end, text.length)) }
}

// SCHEMA

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1()

type PathSegment = PropertyKey | { readonly key: PropertyKey }

const pathOf = (path: ReadonlyArray<PathSegment>): string =>
	path
		.map((segment) => (typeof segment === "object" ? segment.key : segment))
		.reduce<string>(
			(out, key) =>
				typeof key === "number"
					? `${out}[${key}]`
					: out === ""
						? String(key)
						: `${out}.${String(key)}`,
			"",
		)

const parseJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown))
const decode = Schema.decodeUnknownResult(StatusPageConfig)

/** A draft decoded against the schema, unknown keys refused, then the ids the apply would refuse. */
export const parseDraft = (text: string, current: StatusPageConfig): DraftResult =>
	Result.mapError(parseJson(text), () => syntaxProblem(text)).pipe(
		Result.flatMap((value) =>
			Result.mapError(decode(value, { onExcessProperty: "error" }), (error): DraftProblem => {
				const [first] = formatIssue(error.issue).issues
				return {
					_tag: "Schema",
					path: pathOf(first?.path ?? []),
					message: first?.message ?? error.message,
				}
			}),
		),
		Result.flatMap((config): DraftResult => {
			const changes = diffStatusPageConfig(current, config)
			const [unknown] = changes.unknownIds
			if (unknown !== undefined)
				return Result.fail({
					_tag: "Schema",
					path: `components[${config.components.findIndex((c) => c.id === unknown)}].id`,
					message: `${encodeId(unknown)} is not a component of this page. Remove the id to add a new one.`,
				})
			const [duplicate] = changes.duplicateIds
			if (duplicate !== undefined)
				return Result.fail({
					_tag: "Schema",
					path: `components[${config.components.map((c) => c.id).lastIndexOf(duplicate)}].id`,
					message: `${encodeId(duplicate)} is listed more than once`,
				})
			return Result.succeed({ config, changes })
		}),
	)

export const problemText = (problem: DraftProblem): string =>
	problem._tag === "Syntax"
		? `Line ${problem.line}, column ${problem.column}: ${problem.message}`
		: problem.path === ""
			? problem.message
			: `${problem.path}: ${problem.message}`

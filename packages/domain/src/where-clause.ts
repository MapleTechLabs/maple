import { Match, Schema } from "effect"

// Schemas

export const Operator = Schema.Literals([
	"=",
	"!=",
	">",
	"<",
	">=",
	"<=",
	"contains",
	"!contains",
	"exists",
	"!exists",
])
export type Operator = Schema.Schema.Type<typeof Operator>

export const ParsedClause = Schema.Struct({
	key: Schema.String,
	/** The key as typed, for sources whose keys are case-sensitive (`track()` props). */
	rawKey: Schema.optionalKey(Schema.String),
	operator: Operator,
	value: Schema.String,
})
export type ParsedClause = Schema.Schema.Type<typeof ParsedClause>

export class WhereClauseParseWarning extends Schema.TaggedError<WhereClauseParseWarning>()(
	"@maple/where-clause/errors/WhereClauseParseWarning",
	{
		message: Schema.String,
		clause: Schema.String,
	},
) {}

// Key alias normalization (single source of truth)

export const normalizeKey = (raw: string): string =>
	Match.value(raw.trim().toLowerCase()).pipe(
		Match.when("service", () => "service.name"),
		Match.when("span", () => "span.name"),
		// The stable semconv key is a resource attribute too; without this it fell
		// through to a span-attribute filter that matches nothing.
		Match.whenOr("environment", "env", "deployment.environment.name", () => "deployment.environment"),
		// `deployment.commit_sha` is retired telemetry, kept only as an alias so a
		// saved where-clause written against it still names the commit filter.
		Match.whenOr("commit_sha", "deployment.commit_sha", () => "vcs.ref.head.revision"),
		Match.when("root.only", () => "root_only"),
		Match.when("errors_only", () => "has_error"),
		Match.orElse((k) => k),
	)

// Shared parsing helpers

const TRUE_VALUES = new Set(["1", "true", "yes", "y"])
const FALSE_VALUES = new Set(["0", "false", "no", "n"])

export function parseBoolean(value: string): boolean | null {
	const normalized = value.trim().toLowerCase()
	if (TRUE_VALUES.has(normalized)) return true
	if (FALSE_VALUES.has(normalized)) return false
	return null
}

export function parseNumber(value: string): number | null {
	if (!value.trim()) return null
	const parsed = Number(value)
	if (!Number.isFinite(parsed)) return null
	return parsed
}

export function splitCsv(input: string): string[] {
	return input
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean)
}

// Where-clause parser

/**
 * Split an expression on a whitespace-delimited, case-insensitive keyword, but
 * only outside quoted values and parentheses, so `"buy and sell"` and
 * `(a = 1 OR b = 2)` are never mis-split.
 */
function splitOnKeyword(expression: string, keyword: "AND" | "OR"): string[] {
	const separatorPattern = new RegExp(`^\\s+${keyword}\\s+`, "i")
	const parts: string[] = []
	let start = 0
	let depth = 0
	let quote: '"' | "'" | null = null
	for (let i = 0; i < expression.length; i++) {
		const char = expression[i]
		if (quote !== null) {
			if (char === quote) quote = null
			continue
		}
		if (char === '"' || char === "'") {
			quote = char
			continue
		}
		if (char === "(") depth++
		else if (char === ")") depth = Math.max(0, depth - 1)
		else if (depth === 0 && (char === " " || char === "\t" || char === "\n" || char === "\r")) {
			const separator = separatorPattern.exec(expression.slice(i))
			if (separator) {
				parts.push(expression.slice(start, i))
				i += separator[0].length - 1
				start = i + 1
			}
		}
	}
	parts.push(expression.slice(start))
	return parts.map((part) => part.trim()).filter(Boolean)
}

/**
 * Split a where-clause expression into its `AND`-joined clauses. A
 * parenthesized `(a OR b)` group stays one clause.
 */
export function splitWhereClause(expression: string): string[] {
	return splitOnKeyword(expression, "AND")
}

/**
 * A value as the quoted literal the grammar above reads back verbatim. The
 * grammar has no escape character, so the quote is the one the value does not
 * contain. A value carrying both kinds cannot be spelled at all; it is emitted
 * as-is so the parser rejects the clause visibly instead of a quietly altered
 * value matching something else.
 */
export function quoteWhereValue(value: string): string {
	if (!value.includes('"')) return `"${value}"`
	if (!value.includes("'")) return `'${value}'`
	return `"${value}"`
}

export interface ParseWhereClauseResult {
	clauses: readonly ParsedClause[]
	/**
	 * `(a OR b OR ...)` groups, each AND-ed with `clauses` and with each other.
	 * Only filled when the caller passes `orGroups: true`; otherwise a group is
	 * reported as unsupported, so a consumer that cannot apply one never drops
	 * it silently.
	 */
	groups: readonly (readonly ParsedClause[])[]
	warnings: readonly WhereClauseParseWarning[]
}

export interface ParseWhereClauseOptions {
	readonly orGroups?: boolean
}

const unsupported = (part: string) =>
	new WhereClauseParseWarning({ message: `Unsupported clause syntax ignored: ${part}`, clause: part })

/** One `key op value` clause, or the warning explaining why it is not one. */
function parseSimpleClause(part: string): ParsedClause | WhereClauseParseWarning {
	// Match negated operators first so the shorter prefix cannot consume them.
	const notExistsMatch = part.match(/^([a-zA-Z0-9_.-]+)\s+!\s*exists$/i)
	if (notExistsMatch) {
		return {
			key: notExistsMatch[1].trim().toLowerCase(),
			rawKey: notExistsMatch[1].trim(),
			operator: "!exists",
			value: "",
		}
	}

	const existsMatch = part.match(/^([a-zA-Z0-9_.-]+)\s+exists$/i)
	if (existsMatch) {
		return {
			key: existsMatch[1].trim().toLowerCase(),
			rawKey: existsMatch[1].trim(),
			operator: "exists",
			value: "",
		}
	}

	const notContainsMatch = part.match(
		/^([a-zA-Z0-9_.-]+)\s+!\s*contains\s+(?:"([^"]*)"|'([^']*)'|([^\s]+))$/i,
	)
	if (notContainsMatch) {
		return {
			key: notContainsMatch[1].trim().toLowerCase(),
			rawKey: notContainsMatch[1].trim(),
			operator: "!contains",
			value: (notContainsMatch[2] ?? notContainsMatch[3] ?? notContainsMatch[4] ?? "").trim(),
		}
	}

	const containsMatch = part.match(/^([a-zA-Z0-9_.-]+)\s+contains\s+(?:"([^"]*)"|'([^']*)'|([^\s]+))$/i)
	if (containsMatch) {
		return {
			key: containsMatch[1].trim().toLowerCase(),
			rawKey: containsMatch[1].trim(),
			operator: "contains",
			value: (containsMatch[2] ?? containsMatch[3] ?? containsMatch[4] ?? "").trim(),
		}
	}

	const compMatch = part.match(/^([a-zA-Z0-9_.-]+)\s*(!=|<=|>=|<|>|=)\s*(?:"([^"]*)"|'([^']*)'|([^\s]+))$/)
	if (compMatch) {
		const unquotedToken = compMatch[5]
		if (unquotedToken && (unquotedToken.startsWith('"') || unquotedToken.startsWith("'"))) {
			return new WhereClauseParseWarning({ message: `Unclosed quote in clause: ${part}`, clause: part })
		}
		return {
			key: compMatch[1].trim().toLowerCase(),
			rawKey: compMatch[1].trim(),
			operator: compMatch[2] as Operator,
			value: (compMatch[3] ?? compMatch[4] ?? compMatch[5] ?? "").trim(),
		}
	}

	return unsupported(part)
}

/** The inside of `( ... )` when the parentheses wrap the whole part, else undefined. */
function unwrapParentheses(part: string): string | undefined {
	if (!part.startsWith("(") || !part.endsWith(")")) return undefined
	let depth = 0
	let quote: '"' | "'" | null = null
	for (let i = 0; i < part.length; i++) {
		const char = part[i]
		if (quote !== null) {
			if (char === quote) quote = null
			continue
		}
		if (char === '"' || char === "'") quote = char
		else if (char === "(") depth++
		else if (char === ")") {
			depth--
			// Closed before the end: `(a) AND (b)`-shaped, not one wrapped group.
			if (depth === 0 && i !== part.length - 1) return undefined
		}
	}
	return depth === 0 ? part.slice(1, -1).trim() : undefined
}

export function parseWhereClause(
	expression: string,
	options: ParseWhereClauseOptions = {},
): ParseWhereClauseResult {
	const trimmed = expression.trim()
	if (!trimmed) {
		return { clauses: [], groups: [], warnings: [] }
	}

	const clauses: ParsedClause[] = []
	const groups: ParsedClause[][] = []
	const warnings: WhereClauseParseWarning[] = []

	for (const part of splitWhereClause(trimmed)) {
		const inner = unwrapParentheses(part)
		if (inner === undefined) {
			const parsed = parseSimpleClause(part)
			if (parsed instanceof WhereClauseParseWarning) warnings.push(parsed)
			else clauses.push(parsed)
			continue
		}

		// One level of `(a OR b OR ...)`; AND or nesting inside the group is not
		// part of the grammar.
		const members = splitOnKeyword(inner, "OR")
		if (members.length === 1) {
			const parsed = parseSimpleClause(inner)
			if (parsed instanceof WhereClauseParseWarning) warnings.push(unsupported(part))
			else clauses.push(parsed)
			continue
		}
		if (!options.orGroups) {
			warnings.push(unsupported(part))
			continue
		}
		const parsedMembers = members.map(parseSimpleClause)
		const valid = parsedMembers.filter((m): m is ParsedClause => !(m instanceof WhereClauseParseWarning))
		if (valid.length !== parsedMembers.length) {
			warnings.push(
				new WhereClauseParseWarning({
					message: `OR group ignored: every member must be a single clause, without AND or nested parentheses: ${part}`,
					clause: part,
				}),
			)
			continue
		}
		groups.push(valid)
	}

	return { clauses, groups, warnings }
}

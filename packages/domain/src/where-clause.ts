import { Match, Option, Schema, Array as Arr, String as Str } from "effect"

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
	Match.value(Str.toLowerCase(Str.trim(raw))).pipe(
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
	const normalized = Str.toLowerCase(Str.trim(value))
	if (TRUE_VALUES.has(normalized)) return true
	if (FALSE_VALUES.has(normalized)) return false
	return null
}

export function parseNumber(value: string): number | null {
	if (!Str.trim(value)) return null
	const parsed = Number(value)
	if (!Number.isFinite(parsed)) return null
	return parsed
}

export function splitCsv(input: string): string[] {
	return Arr.filter(
		Arr.map(Str.split(",")(input), (item) => Str.trim(item)),
		Boolean,
	)
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
			const separator = separatorPattern.exec(Str.slice(i)(expression))
			if (separator) {
				parts.push(Str.slice(start, i)(expression))
				i += separator[0].length - 1
				start = i + 1
			}
		}
	}
	parts.push(Str.slice(start)(expression))
	return Arr.filter(
		Arr.map(parts, (part) => Str.trim(part)),
		Boolean,
	)
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
	if (!Str.includes('"')(value)) return `"${value}"`
	if (!Str.includes("'")(value)) return `'${value}'`
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

const isParseWarning = Schema.is(WhereClauseParseWarning)

const unsupported = (part: string) =>
	new WhereClauseParseWarning({ message: `Unsupported clause syntax ignored: ${part}`, clause: part })

const matchOrNull = (text: string, regex: RegExp): RegExpMatchArray | null =>
	Option.getOrNull(Str.match(regex)(text))

/** One `key op value` clause, or the warning explaining why it is not one. */
function parseSimpleClause(part: string): ParsedClause | WhereClauseParseWarning {
	// Match negated operators first so the shorter prefix cannot consume them.
	const notExistsMatch = matchOrNull(part, /^([a-zA-Z0-9_.-]+)\s+!\s*exists$/i)
	if (notExistsMatch) {
		return {
			key: Str.toLowerCase(Str.trim(notExistsMatch[1])),
			rawKey: Str.trim(notExistsMatch[1]),
			operator: "!exists",
			value: "",
		}
	}

	const existsMatch = matchOrNull(part, /^([a-zA-Z0-9_.-]+)\s+exists$/i)
	if (existsMatch) {
		return {
			key: Str.toLowerCase(Str.trim(existsMatch[1])),
			rawKey: Str.trim(existsMatch[1]),
			operator: "exists",
			value: "",
		}
	}

	const notContainsMatch = matchOrNull(
		part,
		/^([a-zA-Z0-9_.-]+)\s+!\s*contains\s+(?:"([^"]*)"|'([^']*)'|([^\s]+))$/i,
	)
	if (notContainsMatch) {
		return {
			key: Str.toLowerCase(Str.trim(notContainsMatch[1])),
			rawKey: Str.trim(notContainsMatch[1]),
			operator: "!contains",
			value: Str.trim(notContainsMatch[2] ?? notContainsMatch[3] ?? notContainsMatch[4] ?? ""),
		}
	}

	const containsMatch = matchOrNull(
		part,
		/^([a-zA-Z0-9_.-]+)\s+contains\s+(?:"([^"]*)"|'([^']*)'|([^\s]+))$/i,
	)
	if (containsMatch) {
		return {
			key: Str.toLowerCase(Str.trim(containsMatch[1])),
			rawKey: Str.trim(containsMatch[1]),
			operator: "contains",
			value: Str.trim(containsMatch[2] ?? containsMatch[3] ?? containsMatch[4] ?? ""),
		}
	}

	const compMatch = matchOrNull(
		part,
		/^([a-zA-Z0-9_.-]+)\s*(!=|<=|>=|<|>|=)\s*(?:"([^"]*)"|'([^']*)'|([^\s]+))$/,
	)
	if (compMatch) {
		const unquotedToken = compMatch[5]
		if (unquotedToken && (Str.startsWith('"')(unquotedToken) || Str.startsWith("'")(unquotedToken))) {
			return new WhereClauseParseWarning({ message: `Unclosed quote in clause: ${part}`, clause: part })
		}
		return {
			key: Str.toLowerCase(Str.trim(compMatch[1])),
			rawKey: Str.trim(compMatch[1]),
			operator: compMatch[2] as Operator,
			value: Str.trim(compMatch[3] ?? compMatch[4] ?? compMatch[5] ?? ""),
		}
	}

	return unsupported(part)
}

/** The inside of `( ... )` when the parentheses wrap the whole part, else undefined. */
function unwrapParentheses(part: string): string | undefined {
	if (!Str.startsWith("(")(part) || !Str.endsWith(")")(part)) return undefined
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
	return depth === 0 ? Str.trim(Str.slice(1, -1)(part)) : undefined
}

export function parseWhereClause(
	expression: string,
	options: ParseWhereClauseOptions = {},
): ParseWhereClauseResult {
	const trimmed = Str.trim(expression)
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
			if (isParseWarning(parsed)) warnings.push(parsed)
			else clauses.push(parsed)
			continue
		}

		// One level of `(a OR b OR ...)`; AND or nesting inside the group is not
		// part of the grammar.
		const members = splitOnKeyword(inner, "OR")
		if (members.length === 1) {
			const parsed = parseSimpleClause(inner)
			if (isParseWarning(parsed)) warnings.push(unsupported(part))
			else clauses.push(parsed)
			continue
		}
		if (!options.orGroups) {
			warnings.push(unsupported(part))
			continue
		}
		const parsedMembers = Arr.map(members, parseSimpleClause)
		const valid = Arr.filter(parsedMembers, (m): m is ParsedClause => !isParseWarning(m))
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

import { Array as Arr, Option, String as Str } from "effect"
import { maskLiteralsAndComments } from "@maple/domain/raw-sql"
import type { SourceCatalog } from "@maple/domain/data-sources"
import { didYouMean } from "../../suggest"
import { EPOCH_HELP } from "./sql"

// PostgreSQL and MySQL habits that fail on ClickHouse, each with the ClickHouse spelling.
// Shown only when a query was refused or ClickHouse rejected it, never on success.

interface Mismatch {
	readonly name: string
	readonly pattern: RegExp
	/** Matched on literal-masked text; false for patterns that need the literal itself. */
	readonly masked: boolean
	readonly dialect: "PostgreSQL" | "MySQL"
	readonly fix: string
}

const MISMATCHES: ReadonlyArray<Mismatch> = [
	{
		name: "date_trunc",
		pattern: /\bdate_trunc\s*\(/i,
		masked: true,
		dialect: "PostgreSQL",
		fix: "Use `$__timeGroup(created_at)` or `toStartOfInterval(created_at, INTERVAL 1 DAY)`",
	},
	{
		name: "generate_series",
		pattern: /\bgenerate_series\s*\(/i,
		masked: true,
		dialect: "PostgreSQL",
		fix: "Use `range(start, end)` or `FROM numbers(n)`",
	},
	{
		name: "extract(epoch from",
		pattern: /\bextract\s*\(\s*epoch\s+from\b/i,
		masked: true,
		dialect: "PostgreSQL",
		fix: "Use `toUnixTimestamp(created_at)`",
	},
	{
		name: "to_char",
		pattern: /\bto_char\s*\(/i,
		masked: true,
		dialect: "PostgreSQL",
		fix: "Use `formatDateTime(created_at, '%Y-%m-%d')`",
	},
	{
		name: "string_agg",
		pattern: /\bstring_agg\s*\(/i,
		masked: true,
		dialect: "PostgreSQL",
		fix: "Use `arrayStringConcat(groupArray(x), ',')`",
	},
	{
		name: "::type",
		pattern: /::\s*[A-Za-z]/,
		masked: true,
		dialect: "PostgreSQL",
		fix: "Use `CAST(x AS Type)` or a conversion function such as `toDate(x)`",
	},
	{
		name: "interval '1 day'",
		pattern: /\binterval\s+'\s*\d+\s*[a-z]+\s*'/i,
		masked: false,
		dialect: "PostgreSQL",
		fix: "Use `INTERVAL 1 DAY` (number and unit, unquoted), e.g. `now() - INTERVAL 1 DAY`",
	},
	{
		name: "DATE_FORMAT",
		pattern: /\bdate_format\s*\(/i,
		masked: true,
		dialect: "MySQL",
		fix: "Use `formatDateTime(created_at, '%Y-%m-%d')`",
	},
	{
		name: "STR_TO_DATE",
		pattern: /\bstr_to_date\s*\(/i,
		masked: true,
		dialect: "MySQL",
		fix: "Use `parseDateTimeBestEffort(text)`",
	},
	{
		name: "UNIX_TIMESTAMP",
		pattern: /\bunix_timestamp\s*\(/i,
		masked: true,
		dialect: "MySQL",
		fix: "Use `toUnixTimestamp(created_at)`",
	},
]

const render = (mismatch: Mismatch): string =>
	` This source is ClickHouse; \`${mismatch.name}\` is ${mismatch.dialect}. ${mismatch.fix}.`

const detect = (sql: string): ReadonlyArray<Mismatch> => {
	const masked = maskLiteralsAndComments(sql)
	return Arr.filter(MISMATCHES, (mismatch) => mismatch.pattern.test(mismatch.masked ? masked : sql))
}

/** Hints for a query refused before it ran: every dialect slip found in the text. */
export const validationHints = (sql: string): string => Arr.join(Arr.map(detect(sql), render), "")

const UNKNOWN_FUNCTION_RE = /(?:Function with name|Unknown function)\s+[`'"]?([A-Za-z_][A-Za-z0-9_]*)/i
const UNKNOWN_IDENTIFIER_RE =
	/(?:Unknown (?:expression )?identifier|Missing columns:|no column)\s+[`'"]?([A-Za-z_][A-Za-z0-9_.]*)/i
const UNKNOWN_TABLE_RE =
	/(?:Unknown table expression identifier|Table)\s+[`'"]?([A-Za-z_][A-Za-z0-9_.]*)[`'"]?\s*(?:in scope|does(?:n't| not) exist)/i

const catalogFieldNames = (catalog: SourceCatalog): ReadonlyArray<string> =>
	Arr.dedupe(Arr.flatMap(catalog.entries, (entry) => Arr.map(entry.fields, (field) => field.name)))

/** The fix to append to a ClickHouse error: a dialect hint, or a "did you mean" from the catalog. */
export const runtimeHint = (
	sql: string,
	code: string | undefined,
	message: string,
	catalog: SourceCatalog,
): string => {
	if (code === "46" || UNKNOWN_FUNCTION_RE.test(message)) {
		const fn = Option.fromNullishOr(UNKNOWN_FUNCTION_RE.exec(message)?.[1])
		const hit = Option.flatMap(fn, (name) =>
			Arr.findFirst(detect(sql), (mismatch) =>
				Str.startsWith(Str.toLowerCase(name))(Str.toLowerCase(mismatch.name)),
			),
		)
		return Option.match(hit, { onNone: () => "", onSome: render })
	}
	if (code === "62") return validationHints(sql)
	if (code === "43" && /toStartOfInterval/.test(message) && /Illegal type U?Int/.test(message)) {
		return ` ${EPOCH_HELP}`
	}
	const table = UNKNOWN_TABLE_RE.exec(message)?.[1]
	if (code === "60" || (code === "81" && table !== undefined)) {
		return table === undefined
			? ""
			: didYouMean(
					table,
					Arr.map(catalog.entries, (entry) => entry.name),
				)
	}
	const identifier = UNKNOWN_IDENTIFIER_RE.exec(message)?.[1]
	if (identifier !== undefined && (code === "47" || code === "16")) {
		return didYouMean(identifier, catalogFieldNames(catalog))
	}
	return ""
}

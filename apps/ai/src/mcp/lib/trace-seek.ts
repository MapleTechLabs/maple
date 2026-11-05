import { TRACE_BUCKET_FN } from "@maple/domain/tinybird/datasources"
import { MAX_RAW_SQL_LENGTH, maskLiteralsAndComments, rawSqlIssue } from "@maple/domain/raw-sql"
import { definedNames, referencedTableNames } from "./sql-identifiers"
import { Array as Arr, Option, String as Str } from "effect"

const ID = "'[0-9a-fA-F]{16,32}'"

/** `TraceId = '<id>'` or `TraceId IN ('<id>', ...)`, optionally qualified. */
const TRACE_ID_PREDICATE = new RegExp(
	`(?<![\\w.])(?:(\\w+)\\.)?TraceId\\s*(?:=\\s*${ID}|IN\\s*\\(\\s*${ID}(?:\\s*,\\s*${ID})*\\s*\\))`,
	"g",
)

/** A time bound already lets ClickHouse prune partitions, so the query is left as written. */
const TIME_BOUND = /\$__timeFilter\(|\$__startTime|\$__endTime|\bTimestamp\s*(?:>|<|BETWEEN\b)/i

// Only a plain conjunct of the WHERE clause: not inside `if()`, `NOT`, or an OR.
const BEFORE_CONJUNCT = /\b(?:WHERE|PREWHERE|AND)\s*$/i
const AFTER_CONJUNCT = /^\s*(?:$|\)|AND\b|GROUP\b|ORDER\b|LIMIT\b|HAVING\b|SETTINGS\b|FORMAT\b|UNION\b)/i

/**
 * A `traces` read by literal trace id with no time bound, seeked through `trace_index`
 * like `inspect_trace` does. A bare `TraceId = ...` probes every daily partition and ran
 * past the time limit for large orgs. The seek is ANDed onto the trace-id conjunct, so it
 * can only select rows the predicate already selects; the index holds every
 * (trace, service, bucket) its spans occupy.
 */
export const withTraceIndexSeek = (sql: string): string | undefined => {
	const masked = maskLiteralsAndComments(sql)
	const tables = referencedTableNames(sql)
	const defined = definedNames(sql)
	if (
		tables.length !== 1 ||
		tables[0] !== "traces" ||
		TIME_BOUND.test(masked) ||
		// The seek brings its own `$__orgFilter`; the query must pass the gate without it.
		rawSqlIssue(sql) !== null ||
		Arr.some(["ServiceName", "Timestamp", "TraceId"], (name) => defined.has(name))
	)
		return undefined
	// The literal is blanked in `masked`, so match the original and keep conjuncts outside literals.
	// @effect-diagnostics-next-line preferEffectString:off -- match.index feeds arithmetic; Str.matchAll types it as optional
	const hits = Arr.filter([...sql.matchAll(TRACE_ID_PREDICATE)], (m) => {
		const name = `${m[1] === undefined ? "" : `${m[1]}.`}TraceId`
		return (
			Str.startsWith(name, m.index)(masked) &&
			BEFORE_CONJUNCT.test(Str.slice(0, m.index)(masked)) &&
			AFTER_CONJUNCT.test(Str.slice(m.index + m[0].length)(masked))
		)
	})
	if (hits.length === 0) return undefined
	const seeked = Arr.reduceRight(hits, sql, (text, m) => {
		const q = m[1] === undefined ? "" : `${m[1]}.`
		const ids = Option.match(Str.match(new RegExp(ID, "g"))(m[0]), {
			onNone: () => "",
			onSome: (found) => Arr.join(found, ", "),
		})
		const seek =
			`(${q}ServiceName, ${TRACE_BUCKET_FN}(${q}Timestamp), ${q}TraceId) IN ` +
			`(SELECT ServiceName, Bucket, TraceId FROM trace_index WHERE $__orgFilter AND TraceId IN (${ids}))`
		return `${Str.slice(0, m.index)(text)}(${m[0]} AND ${seek})${Str.slice(m.index + m[0].length)(text)}`
	})
	// The seek adds text; a statement it pushes past the length limit runs as written.
	return seeked.length > MAX_RAW_SQL_LENGTH ? undefined : seeked
}

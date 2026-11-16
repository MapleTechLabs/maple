// BOUNDARY: This module owns unparsed external values and narrows them before domain use.
import {
	WarehouseAuthError,
	WarehouseClientError,
	WarehouseConfigError,
	WarehouseInvalidSqlError,
	WarehouseMalformedQueryError,
	WarehouseQueryError,
	WarehouseQuotaExceededError,
	WarehouseSchemaDriftError,
	WarehouseUpstreamError,
	type WarehouseClassifiedError as DomainWarehouseClassifiedError,
	type WarehouseReadError,
	type WarehouseSettingsRouteError,
	type WarehouseTokenRouteError,
} from "@maple/domain/http"
import type { WarehouseDriverError, WarehouseDriverFailureReason } from "./driver-error"
import { detectQuotaSetting } from "../profiles"
import { Array as Arr, Option, Record as Rec, String as Str } from "effect"
import { isDatasourceDefinition } from "@maple-dev/effect-orm/tinybird"
import * as Datasources from "@maple/domain/tinybird"
import { indexOfFrom } from "@maple/strings"

/**
 * The OTel database conventions' failure attributes for a warehouse span.
 * `db.response.status_code` is the code the database answered with — the
 * ClickHouse error code where the driver saw one, otherwise the HTTP status
 * an upstream returned. `error.type` names the failure at low cardinality:
 * the ClickHouse exception type (`UNKNOWN_TABLE`), then the code, then the
 * error's own tag for failures that never reached a database.
 */
export const warehouseFailureAttributes = (error: {
	readonly _tag: string
	readonly clickhouseCode?: string | undefined
	readonly clickhouseType?: string | undefined
	readonly upstreamStatus?: number | undefined
}): Record<string, string> => {
	const statusCode =
		error.clickhouseCode ??
		(error.upstreamStatus === undefined ? undefined : String(error.upstreamStatus))
	return {
		"error.type": error.clickhouseType ?? error.clickhouseCode ?? error._tag,
		...(statusCode === undefined ? undefined : { "db.response.status_code": statusCode }),
	}
}

const INVALID_TOKEN_MARKER = "invalid token"

/**
 * `Invalid token b'…'` / `Invalid token "…"` with the quoted token redacted. A
 * single left-to-right scan: the lazy-regex version was quadratic on a message
 * made of repeated markers, and this is an untrusted upstream body.
 */
const redactInvalidTokens = (message: string): string => {
	const lower = Str.toLowerCase(message)
	let out = ""
	let cursor = 0
	for (;;) {
		const at = indexOfFrom(lower, INVALID_TOKEN_MARKER, cursor)
		if (at === -1) break
		let i = at + INVALID_TOKEN_MARKER.length
		while (i < message.length && Option.exists(Str.charAt(message, i), (ch) => /\s/.test(ch))) i++
		if (message[i] === "b") i++
		const quote = message[i]
		const close = quote === "'" || quote === '"' ? indexOfFrom(message, quote, i + 1) : -1
		if (close === -1) {
			out += Str.slice(cursor, i)(message)
			cursor = i
			continue
		}
		out += `${Str.slice(cursor, i + 1)(message)}[redacted]${quote}`
		cursor = close + 1
	}
	return out + Str.slice(cursor)(message)
}

const redactWarehouseCredentials = (message: string): string =>
	Str.replace(
		/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
		"[redacted]",
	)(redactInvalidTokens(message))

// Only real HTML tags: warehouse errors echo the caller's SQL, and a generic
// `<[^>]+>` ate everything between a `<=` and a later `>=` in it.
const HTML_TAG =
	/<!doctype[^>]*>|<\/?(?:html|head|body|center|h[1-6]|hr|title|p|br|div|span|pre|meta|a|b|i|strong|em)(?:\s+[\w:-]+=(?:"[^"]*"|'[^']*'|[^\s"'<>=]+))*\s*\/?>/gi

/** Strip credentials, HTML error pages and whitespace noise before exposing an upstream failure. */
export const cleanErrorMessage = (raw: string): string => {
	const redacted = redactWarehouseCredentials(raw)
	let cleaned = redacted
	const htmlIndex = Str.search(cleaned, /<(!doctype|html|head|body|center|h1|hr|title)\b/i)
	if (Option.isSome(htmlIndex)) cleaned = Str.slice(0, htmlIndex.value)(cleaned)
	cleaned = Str.trim(
		Str.replace(
			/\s+/g,
			" ",
		)(Str.replace(/\s*Upgrade your plan[^.\n]*\.?/gi, "")(Str.replace(HTML_TAG, " ")(cleaned))),
	)
	if (Str.endsWith(":")(cleaned)) cleaned = Str.trim(Str.slice(0, -1)(cleaned))
	return cleaned || Str.slice(0, 200)(redacted)
}

const extractUpstreamStatus = (message: string): number | undefined => {
	const match = Str.match(/(?:status|HTTP status|response status code)[:\s]+(\d{3})/i)(message)
	if (Option.isSome(match)) return Number(match.value[1])
	const titleMatch = Str.match(/\b(\d{3})\s+(?:error|service temporarily unavailable)\b/i)(message)
	if (Option.isSome(titleMatch)) return Number(titleMatch.value[1])
	return undefined
}

/**
 * Every warehouse error `mapWarehouseError` can produce. Precondition and row
 * decode failures are raised elsewhere in the executor, so they are absent.
 */
export type WarehouseClassifiedError = DomainWarehouseClassifiedError

/** Failures while resolving settings or executing an ordinary read. */
export type WarehouseReadExecutionError = WarehouseClassifiedError | WarehouseSettingsRouteError

/** Raw SQL adds org-token failures to the normal read execution set. */
export type WarehouseExecutionError = WarehouseReadExecutionError | WarehouseTokenRouteError

/** SQL execution plus the result-schema failure unique to compiled queries. */
export type WarehouseCompiledQueryError = WarehouseReadError

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null

const unknownToMessage = (error: unknown, fallback = "ClickHouse query failed"): string => {
	if (typeof error === "string") return error
	if (error instanceof Error) return error.message
	if (isRecord(error) && typeof error.message === "string") return error.message
	return fallback
}

/** Fields shared by every warehouse error, built once per classification. */
type ClassifiedBase = {
	readonly pipeName: string
	readonly message: string
	readonly cause: unknown
	readonly clickhouseCode: string | undefined
	readonly clickhouseType: string | undefined
}

/**
 * Who wrote the SQL that failed. The same ClickHouse error means different
 * things depending on the answer: a type mismatch in SQL Maple generated is our
 * bug, the identical message from the raw-SQL widget or the `run_sql` MCP tool
 * is the author's typo and they need to see the database's own explanation.
 */
export type SqlAuthorship = "maple" | "caller"

type ClassificationRule = {
	/**
	 * HTTP status match. Consulted only when the driver reported no ClickHouse
	 * identity: a `DB::Exception` rides on whatever status the server picked for
	 * its code (a type mismatch is a 500 on some versions), and that status must
	 * not outrank the code that names the actual failure.
	 */
	readonly status?: (status: number) => boolean
	readonly types?: ReadonlySet<string>
	readonly pattern?: RegExp
	readonly reasons?: ReadonlySet<WarehouseDriverFailureReason>
	/** Any other condition, given what the database answered. */
	readonly test?: (answer: DatabaseAnswer) => boolean
	/** Restricts the rule to SQL with this authorship. Unset means either. */
	readonly authoredBy?: SqlAuthorship
	/** Construct the tagged error for this rule. `upstreamStatus` is only used by the rules that carry it. */
	readonly make: (base: ClassifiedBase, upstreamStatus: number | undefined) => WarehouseClassifiedError
}

type DatabaseAnswer = {
	readonly rawMessage: string
	readonly code: string | undefined
	readonly ruleType: string | undefined
	readonly upstreamStatus: number | undefined
}

const MISSING_RESOURCE = /Resource '([^']*)' not found/i

/** Every table Maple defines, the ones raw SQL may not read included. */
const MAPLE_DATASOURCE_NAMES: ReadonlySet<string> = new Set(
	Arr.map(Arr.filter(Rec.values(Datasources), isDatasourceDefinition), (ds) => ds._name),
)

/**
 * Exception types that are only ever about the statement itself (its syntax, names, types or
 * arguments). An allow-list: an unlisted type (a capacity limit, an engine fault, a new code)
 * stays a server-side query error, never the caller's mistake.
 */
const STATEMENT_TYPES: ReadonlyMap<string, string> = new Map([
	["CANNOT_PARSE_TEXT", "6"],
	["THERE_IS_NO_COLUMN", "8"],
	["DUPLICATE_COLUMN", "15"],
	["NO_SUCH_COLUMN_IN_TABLE", "16"],
	["BAD_ARGUMENTS", "36"],
	["CANNOT_PARSE_DATE", "38"],
	["CANNOT_PARSE_DATETIME", "41"],
	["NUMBER_OF_ARGUMENTS_DOESNT_MATCH", "42"],
	["ILLEGAL_TYPE_OF_ARGUMENT", "43"],
	["ILLEGAL_COLUMN", "44"],
	["UNKNOWN_FUNCTION", "46"],
	["UNKNOWN_IDENTIFIER", "47"],
	["NOT_IMPLEMENTED", "48"],
	["UNKNOWN_TYPE", "50"],
	["TYPE_MISMATCH", "53"],
	["UNKNOWN_TABLE", "60"],
	["SYNTAX_ERROR", "62"],
	["UNKNOWN_AGGREGATE_FUNCTION", "63"],
	["ARGUMENT_OUT_OF_BOUND", "69"],
	["CANNOT_CONVERT_TYPE", "70"],
	["CANNOT_PARSE_NUMBER", "72"],
	["INCORRECT_QUERY", "80"],
	["UNKNOWN_DATABASE", "81"],
	["ILLEGAL_DIVISION", "153"],
	["ILLEGAL_AGGREGATION", "184"],
	["SIZES_OF_ARRAYS_DONT_MATCH", "190"],
	["AMBIGUOUS_IDENTIFIER", "207"],
	["NOT_AN_AGGREGATE", "215"],
	["AMBIGUOUS_COLUMN_NAME", "352"],
	["NO_COMMON_TYPE", "386"],
	["CANNOT_COMPILE_REGEXP", "427"],
	["INVALID_JOIN_ON_EXPRESSION", "403"],
	["CANNOT_READ_ARRAY_FROM_TEXT", "130"],
])

const STATEMENT_CODES: ReadonlySet<string> = new Set(STATEMENT_TYPES.values())

/** UNSUPPORTED_METHOD also covers server-side limits; only this analyzer complaint is the statement's. */
const QUALIFIED_MATCHER = /Qualified matcher .* found a non-compound expression/i

/**
 * The database parsed a caller's statement and refused it: a statement-level exception type, or
 * a bare statement-level code (`Code: 43`). The status is never read: it can be scraped from
 * message text that echoes the caller's SQL.
 */
const refusedStatement = ({ code, ruleType, rawMessage }: DatabaseAnswer): boolean =>
	ruleType === "UNSUPPORTED_METHOD"
		? QUALIFIED_MATCHER.test(rawMessage)
		: ruleType !== undefined
			? STATEMENT_TYPES.has(ruleType)
			: code !== undefined && STATEMENT_CODES.has(code)

// Ordered rules — first match wins. A raw error can satisfy several patterns
// (e.g. a 503 carrying an HTML body, or schema-drift text inside a transient
// failure), so the order encodes precedence:
// missing datasource > auth > refused caller SQL > upstream > config > client > schema_drift > (default) query.
const CLASSIFICATION_RULES: ReadonlyArray<ClassificationRule> = [
	{
		// A caller naming a table Maple never had (`FROM spans`, a CTE Tinybird cannot resolve) gets
		// the same 403 as an undeployed datasource; only a Maple table missing is configuration.
		authoredBy: "caller",
		// Only a gateway answer with no ClickHouse identity, or a statement refusal: the message can
		// echo the caller's SQL, so a timeout quoting `Resource 'x' not found` must not match.
		test: (answer) => {
			const name = MISSING_RESOURCE.exec(answer.rawMessage)?.[1]
			const hasIdentity = answer.code !== undefined || answer.ruleType !== undefined
			return (
				name !== undefined &&
				!MAPLE_DATASOURCE_NAMES.has(name) &&
				(!hasIdentity || refusedStatement(answer))
			)
		},
		make: (base) => new WarehouseInvalidSqlError(base),
	},
	{
		// Tinybird answers a missing datasource with a 403, so the auth rule's status match read a
		// table still being deployed as rejected credentials. The text names the failure; it wins,
		// unless a ClickHouse identity says the text is only echoed SQL.
		test: ({ rawMessage, code, ruleType }) =>
			MISSING_RESOURCE.test(rawMessage) && code === undefined && ruleType === undefined,
		make: (base) => new WarehouseConfigError(base),
	},
	{
		status: (s) => s === 401 || s === 403,
		types: new Set(["AUTHENTICATION_FAILED", "ACCESS_DENIED", "USER_DOESNT_EXIST", "REQUIRED_PASSWORD"]),
		pattern:
			/authentication failed|access denied|not enough privileges|password is incorrect|invalid authentication token/i,
		make: (base, upstreamStatus) => new WarehouseAuthError({ ...base, upstreamStatus }),
	},
	{
		// Before the upstream rule: its patterns match anywhere in the message, which echoes the
		// caller's SQL, so `LIKE '%fetch failed%'` read an unknown column as a network failure.
		authoredBy: "caller",
		test: refusedStatement,
		make: (base) => new WarehouseInvalidSqlError(base),
	},
	{
		status: (s) => s === 408 || s === 429 || (s >= 500 && s < 600),
		reasons: new Set(["transport"]),
		types: new Set([
			"NETWORK_ERROR",
			"SOCKET_TIMEOUT",
			"TOO_MANY_SIMULTANEOUS_QUERIES",
			"SERVER_OVERLOADED",
			"CANNOT_SCHEDULE_TASK",
			"KEEPER_EXCEPTION",
			"ALL_CONNECTION_TRIES_FAILED",
		]),
		// First alternative is anchored (exact "Timeout error"); the rest match anywhere.
		pattern:
			/^Timeout error\.?$|The user aborted a request|Failed to fetch|fetch failed|NetworkError|Load failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|certificate/i,
		make: (base, upstreamStatus) => new WarehouseUpstreamError({ ...base, upstreamStatus }),
	},
	{
		// A table the CALLER named that does not exist — `run_sql`, the raw_sql
		// widget, `maple query`. The config rule below reads the identical
		// complaint as "Maple is pointed at the wrong database", which told a user
		// who mistyped `FROM spans` that their warehouse was misconfigured. Same
		// caller-before-maple ordering as the malformed-query twin further down.
		//
		// Deliberately no `status` matcher: a bare 404 says nothing about whether a
		// table was named, so `Invalid URL`, `UNKNOWN_SETTING` and Tinybird's
		// "Resource '<name>' not found" (a missing datasource, genuinely config)
		// stay with the rule below.
		authoredBy: "caller",
		types: new Set(["UNKNOWN_DATABASE", "UNKNOWN_TABLE", "TABLE_IS_DROPPED"]),
		pattern: /unknown table|table .* does not exist|database .* does not exist/i,
		make: (base) => new WarehouseInvalidSqlError(base),
	},
	{
		status: (s) => s === 404,
		types: new Set(["UNKNOWN_DATABASE", "UNKNOWN_TABLE", "TABLE_IS_DROPPED", "UNKNOWN_SETTING"]),
		// Tinybird's "Resource '<name>' not found" is claimed by the missing-resource rule above, only
		// without a ClickHouse identity, so a typed error that merely echoes it is not read as config.
		pattern:
			/Invalid URL|unknown database|unknown table|table .* does not exist|database .* does not exist/i,
		make: (base) => new WarehouseConfigError(base),
	},
	{
		reasons: new Set(["protocol"]),
		pattern:
			/Cannot decode .* as JSON|Unexpected token .* JSON|Stream has been already consumed|Failed to parse ClickHouse response/i,
		make: (base) => new WarehouseClientError(base),
	},
	{
		// The same analyzer complaints as the Maple-authored rule below, but about
		// SQL the CALLER wrote. Without this twin a plain typo in a raw_sql widget
		// or `run_sql` — a stray comma, a function called with two arguments — fell
		// past every authorship-guarded rule to the default `WarehouseQueryError`:
		// a 502 reading "Database query failed. Contact support" that hid the one
		// thing the author needed, which was ClickHouse's own explanation.
		authoredBy: "caller",
		types: new Set([
			"NO_COMMON_TYPE",
			"ILLEGAL_TYPE_OF_ARGUMENT",
			"ILLEGAL_AGGREGATION",
			"NUMBER_OF_ARGUMENTS_DOESNT_MATCH",
			"TYPE_MISMATCH",
			"SYNTAX_ERROR",
			"UNKNOWN_FUNCTION",
			"AMBIGUOUS_COLUMN_NAME",
			// A literal the column cannot read, e.g. `EventsName != ''` on an Array.
			"CANNOT_READ_ARRAY_FROM_TEXT",
			"CANNOT_PARSE_TEXT",
			// `Timestamp >= '2026-10-04T00:00:00Z'`, a column outside GROUP BY, a made-up function.
			"CANNOT_PARSE_DATETIME",
			"NOT_AN_AGGREGATE",
			"UNKNOWN_AGGREGATE_FUNCTION",
			// A range join (`ON abs(dateDiff(...)) < 1500`), a bad timezone or format argument.
			"INVALID_JOIN_ON_EXPRESSION",
			"BAD_ARGUMENTS",
		]),
		// Some Tinybird messages name no exception type at all, so they match by wording:
		// a nested aggregate (`median(median(x))`) and an IP function fed an empty string.
		// `modifiers FINAL`: `FROM t FINAL` on Tinybird, whose tenant filter makes every table a
		// subquery. Matched by message: its UNSUPPORTED_METHOD type also covers server-side limits.
		pattern:
			/There is no supertype|Illegal type .* of argument|Number of arguments doesn't match|Syntax error|Array does not start with '\['|Unknown (?:aggregate )?function|is not under aggregate function|modifiers FINAL are not supported|inside another aggregate function|Neither IPv4 nor IPv6 address/i,
		make: (base) => new WarehouseInvalidSqlError(base),
	},
	{
		// The analyzer refused SQL that Maple itself generated: mismatched `if()`
		// arms or UNION branches (NO_COMMON_TYPE), a function applied to the wrong
		// type, the wrong argument count. These are Maple bugs — identical for
		// every org, on every cluster, unaffected by retry or by schema apply — so
		// they get their own tag to be alertable and to keep the UI from blaming
		// the customer's database. Ordered before the schema-drift rule, which is
		// the same shape of complaint but a customer-side cause.
		//
		// `authoredBy: "maple"` is what makes the type list safe. Every error here
		// is also an ordinary hand-written-SQL mistake — comparing a String to a
		// number, calling a function with two arguments instead of three — and the
		// raw_sql widget and `run_sql` MCP tool run caller-authored SQL through
		// this same classifier. Blaming ourselves for those would swallow the
		// database's explanation and page on-call for someone else's typo.
		authoredBy: "maple",
		types: new Set([
			"NO_COMMON_TYPE",
			"ILLEGAL_TYPE_OF_ARGUMENT",
			"ILLEGAL_AGGREGATION",
			"NUMBER_OF_ARGUMENTS_DOESNT_MATCH",
			"TYPE_MISMATCH",
			"SYNTAX_ERROR",
			"UNKNOWN_FUNCTION",
			"AMBIGUOUS_COLUMN_NAME",
		]),
		pattern:
			/There is no supertype|Illegal type .* of argument|Number of arguments doesn't match|Syntax error/i,
		make: (base) => new WarehouseMalformedQueryError(base),
	},
	{
		// The same complaint as the schema-drift rule below, but about SQL the CALLER
		// wrote — the `run_sql` MCP tool and the raw_sql widget. A bad table alias
		// (`t.OrgId`) or a column the author invented is a mistake in that query, not
		// evidence that the cluster's schema is behind.
		//
		// This rule exists because the drift rule below had no authorship guard, so
		// agent typos came back to customers as "your ClickHouse cluster's schema is
		// out of sync — run schema apply". Ordered first so the caller case is claimed
		// before the Maple-authored one can match it.
		authoredBy: "caller",
		types: new Set([
			"UNKNOWN_IDENTIFIER",
			"NO_SUCH_COLUMN_IN_TABLE",
			"THERE_IS_NO_COLUMN",
			"NOT_FOUND_COLUMN_IN_BLOCK",
		]),
		// Newer ClickHouse says `Unknown expression identifier`, which the drift rule's pattern misses.
		pattern:
			/Unknown (?:expression (?:or function )?)?identifier|Missing columns|There is no column|No such column/i,
		make: (base) => new WarehouseInvalidSqlError(base),
	},
	{
		// CH error types raised when a column or function reference doesn't exist in
		// the cluster's schema. For BYO-ClickHouse customers this is almost always
		// schema drift between Maple's expected schema and what the cluster has —
		// resolved by running schema apply, not by retrying. Surfacing it as a
		// distinct error lets the MCP layer return an actionable message.
		//
		// `authoredBy: "maple"` is load-bearing for the same reason it is on the
		// malformed-query rule above: only a query WE generated can testify about the
		// cluster's schema. See the caller-authored twin directly above.
		authoredBy: "maple",
		types: new Set([
			"UNKNOWN_IDENTIFIER",
			"NO_SUCH_COLUMN_IN_TABLE",
			"THERE_IS_NO_COLUMN",
			"NOT_FOUND_COLUMN_IN_BLOCK",
		]),
		pattern:
			/Unknown (?:expression or function )?identifier|Missing columns|There is no column|No such column/i,
		make: (base) => new WarehouseSchemaDriftError(base),
	},
]

/**
 * `[Error] ... FORMAT JSON. (UNKNOWN_IDENTIFIER)`, which Tinybird may follow with
 * `(version 25.8.40.3 (official build))` and `(query_id=...)`. The type is the
 * last upper-case group ending the message or followed by one of those two.
 */
const EXCEPTION_TYPE = /\(([A-Z][A-Z0-9_]{2,})\)(?=\s*(?:$|\(version |\(query_id=))/g

const exceptionTypeFromMessage = (message: string): string | undefined =>
	Array.from(Str.matchAll(EXCEPTION_TYPE)(message)).at(-1)?.[1]

export const toWarehouseQueryError = (pipe: string, error: unknown) => {
	const rawMessage = unknownToMessage(error, "Warehouse query failed")
	const redacted = redactWarehouseCredentials(rawMessage)
	return new WarehouseQueryError({
		message: cleanErrorMessage(redacted),
		pipeName: pipe,
		cause: redacted === rawMessage ? error : redacted,
	})
}

/**
 * Classify a warehouse failure into a tagged error.
 *
 * `authoredBy` defaults to `"caller"`: the conservative reading. A wrong
 * "this is a bug in Maple" is worse than a generic message, so a call site has
 * to opt in by declaring the SQL was machine-generated.
 */
export const mapWarehouseError = (
	pipe: string,
	error: WarehouseDriverError,
	authoredBy: SqlAuthorship = "caller",
): WarehouseClassifiedError => {
	const rawMessage = error.message
	const { code, type } = error
	const redacted = redactWarehouseCredentials(rawMessage)
	const message = cleanErrorMessage(rawMessage)
	// Tinybird names the exception only in its text. Read it for caller SQL alone, so the
	// classification of Maple's own queries is unchanged. A named type outranks the HTTP status.
	const ruleType = type ?? (authoredBy === "caller" ? exceptionTypeFromMessage(rawMessage) : undefined)
	const base: ClassifiedBase = {
		pipeName: pipe,
		message,
		// Tinybird can echo the rejected JWT. Keeping the original cause would
		// leak it through Effect's cause/stack rendering even with a clean message.
		cause: redacted === rawMessage ? error : redacted,
		clickhouseCode: code,
		// On the span as `error.type`, so a caller's ILLEGAL_AGGREGATION reads as itself.
		clickhouseType: ruleType,
	}

	// The driver refused to run: an endpoint it cannot address, settings it will
	// not send, a redirect it will not follow. Nothing about the query or the
	// cluster's health is known, so this is configuration, never transient.
	if (error.reason === "config") return new WarehouseConfigError(base)

	const setting = detectQuotaSetting(rawMessage, code, type)
	if (setting) {
		return new WarehouseQuotaExceededError({ ...base, setting })
	}

	const upstreamStatus = error.status ?? extractUpstreamStatus(rawMessage)
	const hasIdentity = code !== undefined || ruleType !== undefined
	for (const rule of CLASSIFICATION_RULES) {
		if (rule.authoredBy !== undefined && rule.authoredBy !== authoredBy) continue
		const matches =
			(rule.reasons !== undefined && rule.reasons.has(error.reason)) ||
			(rule.status !== undefined &&
				!hasIdentity &&
				upstreamStatus !== undefined &&
				rule.status(upstreamStatus)) ||
			(rule.types !== undefined && ruleType !== undefined && rule.types.has(ruleType)) ||
			(rule.pattern !== undefined && rule.pattern.test(rawMessage)) ||
			(rule.test !== undefined && rule.test({ rawMessage, code, ruleType, upstreamStatus }))
		if (matches) return rule.make(base, upstreamStatus)
	}
	return new WarehouseQueryError(base)
}

// Guard for client SQL on `/local/query`. The engine's own parser canonicalizes
// the text, the canonical statement is what runs, and read statements carry
// `readonly = 1` plus result caps, so enforcement does not rest on a regex.

import { disallowedTableFunction } from "@maple/domain/raw-sql"
import { Option, Result, Schema, Array as Arr, Record as Rec, String as Str } from "effect"
import type { Chdb } from "./chdb"

/** Body prefix clients map to a clean "not allowed" error. */
export const READ_ONLY_REJECTION_PREFIX = "read-only query endpoint: "

export class ReadOnlyQueryRejected extends Schema.TaggedError<ReadOnlyQueryRejected>()(
	"@maple/cli/ReadOnlyQueryRejected",
	{ message: Schema.String },
) {}

/** The engine could not parse the submitted SQL. */
export class LocalQueryInvalid extends Schema.TaggedError<LocalQueryInvalid>()(
	"@maple/cli/LocalQueryInvalid",
	{ message: Schema.String },
) {}

/** Engine-level ceilings for client queries; a client may only lower them. */
export const CLIENT_QUERY_LIMITS = {
	max_execution_time: 30,
	max_memory_usage: 4_000_000_000,
	max_result_rows: 1_000_000,
	max_result_bytes: 256 * 1024 * 1024,
} as const

// Settings a compiled Maple query may carry (query-engine `settingToCh`).
const CAPPED_SETTINGS = new Set<string>(Rec.keys(CLIENT_QUERY_LIMITS))
const ALLOWED_SETTINGS = new Set<string>([
	...CAPPED_SETTINGS,
	"max_threads",
	"max_block_size",
	"enable_full_text_index",
])

const READ_STATEMENTS = new Set(["SELECT", "WITH", "SHOW", "DESCRIBE", "EXISTS", "EXPLAIN"])
// Statement keywords that must not appear under EXPLAIN.
const WRITE_KEYWORDS = new Set([
	"INSERT",
	"CREATE",
	"ALTER",
	"DROP",
	"TRUNCATE",
	"RENAME",
	"OPTIMIZE",
	"SYSTEM",
	"KILL",
	"GRANT",
	"REVOKE",
	"ATTACH",
	"DETACH",
	"DELETE",
	"UPDATE",
	"EXCHANGE",
	"UNDROP",
	"BACKUP",
	"RESTORE",
	"SET",
	"USE",
])
// `readonly` does not cover reads (`file` reaches any local path), so table functions
// get hosted raw SQL's allow list and its readers are refused in any position.
const DENIED_FUNCTIONS = new Set(["catboostevaluate"])

export interface PreparedLocalQuery {
	readonly kind: "read" | "write"
	/** The statement to execute, output format included. */
	readonly sql: string
}

interface Word {
	readonly text: string
	readonly start: number
	readonly end: number
	readonly depth: number
	readonly callee: boolean
	readonly quoted: boolean
}

const reject = (reason: string) => Result.fail(new ReadOnlyQueryRejected({ message: reason }))

const isWordStart = (c: string) => /[A-Za-z_]/.test(c)
const isWordPart = (c: string) => /[A-Za-z0-9_$]/.test(c)

/** Words of canonical engine output (no comments, quoted literals skipped). */
const scanWords = (sql: string): ReadonlyArray<Word> | undefined => {
	const words: Word[] = []
	let depth = 0
	let i = 0
	const nextIsParen = (from: number) => {
		let k = from
		while (sql[k] === " ") k++
		return sql[k] === "("
	}
	while (i < sql.length) {
		const c = sql[i]
		if (c === "'" || c === '"' || c === "`") {
			let j = i + 1
			while (j < sql.length && sql[j] !== c) j += sql[j] === "\\" ? 2 : 1
			if (j >= sql.length) return undefined
			if (c !== "'")
				words.push({
					text: Str.slice(i + 1, j)(sql),
					start: i,
					end: j + 1,
					depth,
					callee: nextIsParen(j + 1),
					quoted: true,
				})
			i = j + 1
		} else if (c === "(" || c === "[" || c === "{") {
			depth++
			i++
		} else if (c === ")" || c === "]" || c === "}") {
			depth--
			i++
		} else if (isWordStart(c)) {
			let j = i + 1
			while (j < sql.length && isWordPart(sql[j])) j++
			words.push({
				text: Str.slice(i, j)(sql),
				start: i,
				end: j,
				depth,
				callee: nextIsParen(j),
				quoted: false,
			})
			i = j
		} else if (/[0-9]/.test(c)) {
			// Numeric literals such as 1e9 or 0x1F are not words.
			let j = i + 1
			while (j < sql.length && /[0-9A-Za-z_.]/.test(sql[j])) j++
			i = j
		} else i++
	}
	return words
}

type Assignment = readonly [name: string, value: number]

/** `name = <integer>, ...` or undefined when the tail is anything else. */
const parseAssignments = (tail: string): ReadonlyArray<Assignment> | undefined => {
	const assignments: Assignment[] = []
	for (const part of Str.split(",")(tail)) {
		const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\d+)\s*$/.exec(part)
		const name = match?.[1]
		const value = match?.[2]
		if (name === undefined || value === undefined) return undefined
		assignments.push([Str.toLowerCase(name), Number(value)])
	}
	return assignments
}

interface Peeled {
	readonly body: string
	readonly settings: ReadonlyArray<Assignment>
}

/** Remove the trailing FORMAT and parseable SETTINGS clauses of the outer query. */
const peelTerminalClauses = (canonical: string, words: ReadonlyArray<Word>): Peeled => {
	let body = canonical
	const settings: Assignment[] = []
	const topLevel = () => Arr.filter(words, (word) => word.depth === 0 && word.end <= body.length)
	const keyword = (word: Word | undefined, text: string) =>
		word !== undefined && !word.quoted && word.text === text
	const peelSettings = () => {
		const found = Arr.findLast(topLevel(), (word) => keyword(word, "SETTINGS"))
		if (Option.isNone(found)) return
		const last = found.value
		const parsed = parseAssignments(Str.slice(last.end)(body))
		if (parsed === undefined) return
		settings.push(...parsed)
		body = Str.trimEnd(Str.slice(0, last.start)(body))
	}
	const peelFormat = () => {
		const top = topLevel()
		const format = top.at(-2)
		const name = top.at(-1)
		if (
			format === undefined ||
			!keyword(format, "FORMAT") ||
			name === undefined ||
			name.end !== body.length
		)
			return
		body = Str.trimEnd(Str.slice(0, format.start)(body))
	}
	peelSettings()
	peelFormat()
	peelSettings()
	return { body, settings }
}

const settingsClause = (
	requested: ReadonlyArray<Assignment>,
): Result.Result<string, ReadOnlyQueryRejected> => {
	const merged = new Map<string, number>(Rec.toEntries(CLIENT_QUERY_LIMITS))
	for (const [name, value] of requested) {
		if (!ALLOWED_SETTINGS.has(name)) return reject(`setting ${name} is not allowed`)
		const ceiling = merged.get(name)
		// 0 means "unlimited" to ClickHouse, so it never lifts a ceiling.
		if (!CAPPED_SETTINGS.has(name) || ceiling === undefined) merged.set(name, value)
		else if (value > 0 && value < ceiling) merged.set(name, value)
	}
	const parts = Arr.map([...merged], ([name, value]) => `${name} = ${value}`)
	// Applied in order, so readonly comes last; after it no setting may change.
	return Result.succeed(Arr.join([...parts, "output_format_json_array_of_rows = 1", "readonly = 1"], ", "))
}

const escapeLiteral = (value: string) => Str.replace(/'/g, "\\'")(Str.replace(/\\/g, "\\\\")(value))

// The wrapper query is noise in a syntax error about the client's SQL.
const cleanParseError = (message: string) =>
	Str.replace(/:? In scope SELECT formatQuerySingleLine\([\s\S]*?(\s\([A-Z_]+\))?$/, "$1")(message)

/** Canonicalize `sql` with the engine parser and build the statement to run. */
export const prepareLocalQuery = (
	db: Pick<Chdb, "query">,
	sql: string,
	options: { readonly allowWrites: boolean },
): Result.Result<PreparedLocalQuery, ReadOnlyQueryRejected | LocalQueryInvalid> =>
	Result.gen(function* () {
		if (Str.includes("\0")(sql)) return yield* reject("NUL bytes are not allowed")
		const canonical = yield* Result.try({
			try: () =>
				Str.trim(
					db.query(
						`SELECT formatQuerySingleLine('${escapeLiteral(sql)}')\nFORMAT RawBLOB\nSETTINGS readonly = 1, max_execution_time = 5`,
						"RawBLOB",
					),
				),
			catch: (error) => {
				const message = error instanceof Error ? error.message : String(error)
				return /Multi-statements are not allowed/.test(message)
					? new ReadOnlyQueryRejected({ message: "multiple statements are not allowed" })
					: new LocalQueryInvalid({ message: cleanParseError(message) })
			},
		})
		const words = scanWords(canonical)
		const first = words?.[0]
		if (words === undefined || first === undefined)
			return yield* reject("could not tokenize the statement")
		for (const [index, word] of words.entries()) {
			if (word.callee && DENIED_FUNCTIONS.has(Str.toLowerCase(word.text)))
				return yield* reject(`function ${word.text} is not allowed`)
			if (word.text === "INTO" && words[index + 1]?.text === "OUTFILE")
				return yield* reject("INTO OUTFILE is not allowed")
		}
		const tableFunction = disallowedTableFunction(canonical)
		if (tableFunction !== null) return yield* reject(`function ${tableFunction} is not allowed`)
		const leading = Str.startsWith("(")(canonical) ? "SELECT" : first.text
		if (!READ_STATEMENTS.has(leading)) {
			if (options.allowWrites) {
				// The canonical form drops an INSERT's inline rows (and their unscanned
				// expressions), so only INSERT ... SELECT survives canonicalization intact.
				if (
					first.text === "INSERT" &&
					!Arr.some(words, (word) => !word.quoted && word.text === "SELECT")
				)
					return yield* reject("INSERT with inline data is not allowed; use INSERT ... SELECT")
				return { kind: "write" as const, sql: canonical }
			}
			return yield* reject(
				`only SELECT, WITH, SHOW, DESCRIBE, EXISTS and EXPLAIN statements are allowed`,
			)
		}
		if (leading === "EXPLAIN" && Arr.some(words, (word) => WRITE_KEYWORDS.has(word.text)))
			return yield* reject("EXPLAIN is only allowed for read statements")
		const peeled = peelTerminalClauses(canonical, words)
		// A subquery's own SETTINGS would apply after the appended `readonly = 1`.
		if (
			Arr.some(
				words,
				(word) => !word.quoted && word.text === "SETTINGS" && word.end <= peeled.body.length,
			)
		)
			return yield* reject("SETTINGS is only allowed once, at the end of the query")
		// Schema inference reads whatever a table function points at, and
		// DESCRIBE skips the readonly check, so only plain tables are described.
		if (
			leading === "DESCRIBE" &&
			!/^DESCRIBE TABLE (?:`[^`]+`|[A-Za-z_][\w$]*)(?:\.(?:`[^`]+`|[A-Za-z_][\w$]*))?$/.test(
				peeled.body,
			)
		)
			return yield* reject("DESCRIBE only accepts a table name")
		const settings = yield* settingsClause(peeled.settings)
		return { kind: "read" as const, sql: `${peeled.body}\nFORMAT JSONEachRow\nSETTINGS ${settings}` }
	})

/** Rows in `output_format_json_array_of_rows` output: every row starts a line with `{`. */
export const countArrayRows = (bytes: Uint8Array): number => {
	const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	let rows = 0
	for (let at = buffer.indexOf("\n{"); at !== -1; at = buffer.indexOf("\n{", at + 2)) rows++
	return rows
}

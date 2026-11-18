import { Array as Arr, Option, String as Str } from "effect"

// What an agent may not name on a ClickHouse source with hidden entries. The SQL is read as words
// (comments dropped, quoted names unquoted, strings decoded), so no quoting or casing hides a name.
// Runs after `clickHouseSqlIssue`, which refuses what this lexer and the server read differently.

interface Word {
	/** Lowercased name or keyword; the character itself for punctuation. */
	readonly text: string
	readonly kind: "name" | "number" | "punctuation" | "literal"
	readonly quoted: boolean
	/** A string literal's value as the server may read it, lowercased; `null` when no reading is certain. */
	readonly values?: ReadonlyArray<string> | null
}

// The escapes the server decodes in a string. Any other `\c` keeps its backslash on current
// servers and was documented to drop it, so both readings are kept.
const STRING_ESCAPES: ReadonlyMap<string, string> = new Map([
	["\\", "\\"],
	["'", "'"],
	['"', '"'],
	["`", "`"],
	["/", "/"],
	["=", "="],
	["b", "\b"],
	["f", "\f"],
	["n", "\n"],
	["r", "\r"],
	["t", "\t"],
	["0", "\0"],
	["a", "\x07"],
	["v", "\v"],
	["e", "\x1b"],
	["N", ""],
])

// A doubled quote, or a backslash with what it takes: two hex digits after `x`, else one character.
const STRING_ESCAPE_RE = /''|\\(x[0-9A-Fa-f]{2}|[\s\S]|$)/g

/** What a string literal's body may mean to the server, or `null` when an escape has no certain reading. */
const stringValues = (body: string): ReadonlyArray<string> | null => {
	if (!Str.includes("\\")(body) && !Str.includes("''")(body)) return [Str.toLowerCase(body)]
	const escapes = Arr.fromIterable(Str.matchAll(STRING_ESCAPE_RE)(body))
	// `\x` without two hex digits reads two arbitrary bytes, and a lone trailing backslash ends nothing.
	if (Arr.some(escapes, (match) => match[1] === "x" || match[1] === "")) return null
	// Spliced by position, as macro expansion is: the text between escapes is copied as written.
	const decode = (unknown: (escape: string) => string) => {
		const { out, at } = Arr.reduce(escapes, { out: "", at: 0 }, (acc, match) => {
			const start = match.index ?? 0
			const escaped = match[1]
			const piece =
				escaped === undefined
					? "'"
					: escaped.length === 3
						? String.fromCharCode(Number.parseInt(Str.slice(1)(escaped), 16))
						: (STRING_ESCAPES.get(escaped) ?? unknown(match[0]))
			return { out: acc.out + Str.slice(acc.at, start)(body) + piece, at: start + match[0].length }
		})
		return Str.toLowerCase(out + Str.slice(at)(body))
	}
	return [decode((whole) => whole), decode((whole) => Str.slice(1)(whole))]
}

// One alternative per lexeme, comments and literals first so their bodies are never read as names.
// A bare name takes `$` and may start with a digit, as the server's does.
const LEXEME_RE =
	/--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:\\[\s\S]|''|[^'\\])*'?|`(?:``|[^`])*`?|"(?:""|[^"])*"?|[A-Za-z0-9_$]+|\S/g

const unquote = (lexeme: string): string => {
	const quote = Str.slice(0, 1)(lexeme)
	const closed = lexeme.length > 1 && Str.endsWith(quote)(lexeme)
	return Str.replaceAll(`${quote}${quote}`, quote)(Str.slice(1, closed ? -1 : undefined)(lexeme))
}

const toWord = (lexeme: string): Word | null => {
	if (Str.startsWith("--")(lexeme) || Str.startsWith("/*")(lexeme)) return null
	if (Str.startsWith("'")(lexeme)) {
		const closed = lexeme.length > 1 && Str.endsWith("'")(lexeme)
		const values = stringValues(Str.slice(1, closed ? -1 : undefined)(lexeme))
		return { text: "", kind: "literal", quoted: false, values }
	}
	if (Str.startsWith("`")(lexeme) || Str.startsWith('"')(lexeme)) {
		return { text: Str.toLowerCase(unquote(lexeme)), kind: "name", quoted: true }
	}
	if (/^[0-9]+$/.test(lexeme)) return { text: lexeme, kind: "number", quoted: false }
	return {
		text: Str.toLowerCase(lexeme),
		kind: /^[A-Za-z0-9_$]+$/.test(lexeme) ? "name" : "punctuation",
		quoted: false,
	}
}

const wordsOf = (sql: string): ReadonlyArray<Word> => {
	// One array, filled in place: a 32 KB query is tens of thousands of lexemes.
	const words: Array<Word> = []
	return Arr.reduce(Arr.fromIterable(Str.matchAll(LEXEME_RE)(sql)), words, (all, match) => {
		const word = toWord(match[0])
		if (word !== null) all.push(word)
		return all
	})
}

interface Chain {
	readonly parts: Array<string>
	/** Followed by `(`: the chain is a function's name, not a table or column. */
	called: boolean
}

interface ChainWalk {
	readonly chains: Array<Chain>
	open: Chain | null
	afterDot: boolean
}

/** Dotted names as the server reads them: quoted, spaced or split by a comment, `a.b` is `[a, b]`. */
const chainsOf = (words: ReadonlyArray<Word>): ReadonlyArray<Chain> => {
	const start: ChainWalk = { chains: [], open: null, afterDot: false }
	return Arr.reduce(words, start, (walk, word) => {
		// After a dot a number is a name too: `db.60` reads a table called `60`.
		if (walk.open !== null && walk.afterDot && (word.kind === "name" || word.kind === "number")) {
			walk.open.parts.push(word.text)
			walk.afterDot = false
		} else if (word.kind === "name") {
			walk.open = { parts: [word.text], called: false }
			walk.chains.push(walk.open)
			walk.afterDot = false
		} else if (word.text === "." && walk.open !== null && !walk.afterDot) {
			walk.afterDot = true
		} else {
			if (walk.open !== null && word.text === "(" && !walk.afterDot) walk.open.called = true
			walk.open = null
			walk.afterDot = false
		}
		return walk
	}).chains
}

const SYSTEM_DATABASES: ReadonlySet<string> = new Set(["system", "information_schema"])

/** Functions that read a table or dictionary named by a string, which no name check can follow. */
const readsByStringName = (name: string): boolean =>
	Str.startsWith("dict")(name) || Str.startsWith("joinget")(name) || name === "hascolumnintable"

/** Statements that print a query's plan or a table's shape, and with it the tables under a view. */
const INTROSPECTION: ReadonlySet<string> = new Set(["explain", "describe", "desc", "show"])

interface HiddenNames {
	/** `db.table`, lowercased. */
	readonly full: ReadonlySet<string>
	/** `table` alone, for entries in the connection's own database: a bare name resolves there. */
	readonly bare: ReadonlySet<string>
	/** The most dotted parts any spelling has, so a chain is only read that far. */
	readonly maxParts: number
}

const hiddenNames = (hidden: ReadonlyArray<string>, defaultDatabase: string): HiddenNames => {
	const prefix = `${Str.toLowerCase(defaultDatabase)}.`
	const full = Arr.map(hidden, Str.toLowerCase)
	return {
		full: new Set(full),
		bare: new Set(
			Arr.map(
				Arr.filter(full, (name) => Str.startsWith(prefix)(name) && name.length > prefix.length),
				(name) => Str.slice(prefix.length)(name),
			),
		),
		maxParts: Arr.reduce(full, 1, (most, name) => Math.max(most, Str.split(".")(name).length)),
	}
}

/** Every spelling that starts at `start`, at most `max` parts long, shortest first. */
const spellingsFrom = (parts: ReadonlyArray<string>, start: number, max: number): ReadonlyArray<string> => {
	const spellings: Array<string> = []
	return Arr.reduce(Arr.range(start, Math.min(parts.length, start + max) - 1), spellings, (all, index) => {
		const part = parts[index] ?? ""
		all.push(all.length === 0 ? part : `${all.at(-1) ?? ""}.${part}`)
		return all
	})
}

type Match = { readonly spelling: string; readonly bare: boolean }

/** The hidden name `chain` spells: `db.table` anywhere in it, or the bare table where it starts. */
const hiddenNameIn = (chain: Chain, names: HiddenNames): Option.Option<Match> => {
	const full = Arr.findFirst(
		Arr.flatMap(Arr.range(0, chain.parts.length - 1), (start) =>
			spellingsFrom(chain.parts, start, names.maxParts),
		),
		(spelling) => names.full.has(spelling),
	)
	if (Option.isSome(full)) return Option.some({ spelling: full.value, bare: false })
	return Option.map(
		Arr.findFirst(
			spellingsFrom(chain.parts, 0, names.maxParts),
			// A whole chain that is called is a function (`count()`), never a table.
			(spelling, index) =>
				names.bare.has(spelling) && !(chain.called && index === chain.parts.length - 1),
		),
		(spelling) => ({ spelling, bare: true }),
	)
}

/**
 * The first reason an agent's SQL may not run on a source with hidden entries, or null. It
 * matches names, not tables: a column, alias or string value spelled like a hidden table in the
 * connection's database is refused too, and a view over a hidden table is not.
 */
export const hiddenEntryIssue = (
	sql: string,
	hidden: ReadonlyArray<string>,
	defaultDatabase: string,
): string | null => {
	if (hidden.length === 0) return null
	const words = wordsOf(sql)
	const chains = chainsOf(words)
	const database = Str.toLowerCase(defaultDatabase)
	const system = Arr.findFirst(chains, (chain) =>
		Arr.some(chain.parts, (part, index) => index < chain.parts.length - 1 && SYSTEM_DATABASES.has(part)),
	)
	if (Option.isSome(system) || SYSTEM_DATABASES.has(database)) {
		return "Agents cannot read the `system` or `information_schema` databases on this source: some of its tables are hidden from agents, and those databases list them. Use describe_data_source for the tables you can query."
	}
	const names = hiddenNames(hidden, database)
	const named = Arr.findFirst(chains, (chain) => hiddenNameIn(chain, names))
	if (Option.isSome(named)) {
		const { spelling, bare } = named.value
		return bare
			? `\`${spelling}\` names a table an admin hid from agents on this source. If you mean a column or a table in another database, qualify it (\`alias.${spelling}\`, \`other_db.${spelling}\`); otherwise leave it out, or ask an admin to show it to agents.`
			: `\`${spelling}\` names a table an admin hid from agents on this source, so this query cannot run. Leave it out, or ask an admin to show it to agents.`
	}
	// The server takes a string where a table goes, in more positions than any walk of the FROM list
	// can be trusted to find, so a string that spells a hidden table is refused wherever it stands.
	const literal = Arr.findFirst(
		words,
		(word) =>
			word.kind === "literal" &&
			(word.values === null || Arr.some(word.values ?? [], (value) => names.bare.has(value))),
	)
	if (Option.isSome(literal)) {
		return literal.value.values === null
			? "A string in this query holds a backslash escape with no certain reading (`\\x` needs two hex digits, and a backslash cannot end a string), so it cannot be checked against the tables hidden from agents on this source. Write the value without that escape."
			: "A string value in this query equals the name of a table an admin hid from agents on this source. The server reads a string as a table name where a table goes, so the query cannot run with that value in it, even as a plain value in a filter. Leave it out, or ask an admin to show the table to agents."
	}
	const introspection = Arr.findFirst(words, (word, index) => {
		const after = words[index + 1]
		return (
			!word.quoted &&
			INTROSPECTION.has(word.text) &&
			words[index - 1]?.text === "(" &&
			after !== undefined &&
			(after.kind === "name" || after.kind === "number" || after.text === "(")
		)
	})
	if (Option.isSome(introspection)) {
		return `\`${Str.toUpperCase(introspection.value.text)}\` in a subquery is not available to agents on this source: it prints the tables a view reads, and some are hidden from agents. Select from the table or view instead.`
	}
	const reader = Arr.findFirst(
		words,
		(word, index) =>
			word.kind === "name" && readsByStringName(word.text) && words[index + 1]?.text === "(",
	)
	return Option.isSome(reader)
		? `\`${reader.value.text}\` reads a table or dictionary named by a string, which cannot be checked against the tables hidden from agents on this source. Select from the table by name instead.`
		: null
}

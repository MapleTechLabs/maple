import { Array as Arr, Option, String as Str } from "effect"

// What an agent may not name on a ClickHouse source with entries an admin hid from agents. The
// checks read the SQL as words (comments and string literals dropped, quoted identifiers
// unquoted), so quoting, casing or a comment between the parts spells the same name.

interface Word {
	/** Lowercased identifier or keyword; the character itself for punctuation. */
	readonly text: string
	readonly kind: "name" | "punctuation" | "literal"
	/** A quoted identifier written with a backslash, which the server decodes and this does not. */
	readonly escaped: boolean
}

// One alternative per lexeme, comments and literals first so their bodies are never read as names.
const LEXEME_RE =
	/--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:\\[\s\S]|''|[^'\\])*'?|`(?:\\[\s\S]|``|[^`\\])*`?|"(?:\\[\s\S]|""|[^"\\])*"?|“[^”]*”?|[A-Za-z0-9_$]+|\S/g

const QUOTES = ["`", '"', "“"] as const

const unquote = (lexeme: string): string => {
	const open = Str.slice(0, 1)(lexeme)
	const close = open === "“" ? "”" : open
	const body =
		Str.endsWith(close)(lexeme) && lexeme.length > 1 ? Str.slice(1, -1)(lexeme) : Str.slice(1)(lexeme)
	return open === "“" ? body : Str.replaceAll(`${open}${open}`, open)(body)
}

const toWord = (lexeme: string): Option.Option<Word> => {
	if (Str.startsWith("--")(lexeme) || Str.startsWith("/*")(lexeme)) return Option.none()
	if (Str.startsWith("'")(lexeme)) return Option.some({ text: "", kind: "literal", escaped: false })
	if (Arr.some(QUOTES, (quote) => Str.startsWith(quote)(lexeme))) {
		const body = unquote(lexeme)
		return Option.some({ text: Str.toLowerCase(body), kind: "name", escaped: Str.includes("\\")(body) })
	}
	return Option.some({
		text: Str.toLowerCase(lexeme),
		kind: /^[A-Za-z0-9_$]+$/.test(lexeme) ? "name" : "punctuation",
		escaped: false,
	})
}

const wordsOf = (sql: string): ReadonlyArray<Word> =>
	Arr.getSomes(Arr.map(Arr.fromIterable(Str.matchAll(LEXEME_RE)(sql)), (match) => toWord(match[0])))

/** Whether a backtick or double-quoted identifier is written with a backslash escape. */
export const hasEscapedIdentifier = (sql: string): boolean => Arr.some(wordsOf(sql), (word) => word.escaped)

export const ESCAPED_IDENTIFIER_MESSAGE =
	"Write quoted identifiers without backslash escapes: Maple checks the names a query reads, and an escaped name cannot be checked."

interface Chains {
	readonly done: ReadonlyArray<ReadonlyArray<string>>
	readonly open: ReadonlyArray<string>
	readonly afterDot: boolean
}

const NO_CHAINS: Chains = { done: [], open: [], afterDot: false }

/** Dotted names as the server reads them: quoted, spaced or split by a comment, `a.b` is `[a, b]`. */
const chainsOf = (words: ReadonlyArray<Word>): ReadonlyArray<ReadonlyArray<string>> => {
	const close = (state: Chains): ReadonlyArray<ReadonlyArray<string>> =>
		state.open.length === 0 ? state.done : [...state.done, state.open]
	const end = Arr.reduce(words, NO_CHAINS, (state, word): Chains => {
		if (word.kind === "name") {
			return state.afterDot
				? { done: state.done, open: [...state.open, word.text], afterDot: false }
				: { done: close(state), open: [word.text], afterDot: false }
		}
		return word.text === "." && state.open.length > 0 && !state.afterDot
			? { ...state, afterDot: true }
			: { done: close(state), open: [], afterDot: false }
	})
	return close(end)
}

const SYSTEM_DATABASES: ReadonlySet<string> = new Set(["system", "information_schema"])

/** Functions that read a table or dictionary named by a string, which no name check can follow. */
const readsByStringName = (name: string): boolean =>
	Str.startsWith("dict")(name) || Str.startsWith("joinget")(name) || name === "hascolumnintable"

/** `db.table` and every shorter spelling after a dot (`table`): a bare name resolves by database. */
const spellingsOf = (entry: string): { readonly full: string; readonly bare: ReadonlyArray<string> } => {
	const parts = Str.split(".")(Str.toLowerCase(entry))
	return {
		full: Arr.join(parts, "."),
		bare: Arr.filter(
			Arr.map(Arr.range(1, parts.length), (from) => Arr.join(Arr.drop(parts, from), ".")),
			Str.isNonEmpty,
		),
	}
}

/** The spelling in `chain` that names the hidden entry: all of it anywhere, or its table at the start. */
const namedIn = (
	chain: ReadonlyArray<string>,
	entry: { readonly full: string; readonly bare: ReadonlyArray<string> },
): Option.Option<string> => {
	const from = (start: number) =>
		Arr.map(Arr.range(start + 1, chain.length), (end) => Arr.join(chain.slice(start, end), "."))
	return Option.orElse(
		Arr.findFirst(
			Arr.flatMap(Arr.range(0, chain.length - 1), from),
			(spelling) => spelling === entry.full,
		),
		() => Arr.findFirst(from(0), (spelling) => Arr.contains(entry.bare, spelling)),
	)
}

/**
 * The first reason an agent's SQL may not run on a source with hidden entries, or null. Names are
 * matched wherever they appear, so a column or alias spelled like a hidden table is refused too.
 */
export const hiddenEntryIssue = (
	sql: string,
	hidden: ReadonlyArray<string>,
	defaultDatabase: string,
): string | null => {
	if (hidden.length === 0) return null
	const words = wordsOf(sql)
	if (Arr.some(words, (word) => word.escaped)) return ESCAPED_IDENTIFIER_MESSAGE
	const chains = chainsOf(words)
	const system = Arr.findFirst(
		Arr.flatMap(chains, (chain) => Arr.dropRight(chain, 1)),
		(name) => SYSTEM_DATABASES.has(name),
	)
	if (Option.isSome(system) || SYSTEM_DATABASES.has(Str.toLowerCase(defaultDatabase))) {
		return `Agents cannot read the \`${Option.getOrElse(system, () => Str.toLowerCase(defaultDatabase))}\` database on this source: some of its tables are hidden from agents, and that database lists them. Use describe_data_source for the tables you can query.`
	}
	const entries = Arr.map(hidden, spellingsOf)
	const named = Arr.findFirst(
		Arr.flatMap(chains, (chain) => Arr.getSomes(Arr.map(entries, (entry) => namedIn(chain, entry)))),
		() => true,
	)
	if (Option.isSome(named)) {
		return `\`${named.value}\` names a table an admin hid from agents on this source, so this query cannot run. Leave it out (rename a column or alias spelled the same), or ask an admin to show it to agents.`
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

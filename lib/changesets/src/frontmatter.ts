/**
 * `@changesets/parse` without a YAML dependency. The frontmatter grammar covers what changesets
 * accepts in practice: a block or flow mapping of plain, single- or double-quoted package names to
 * release types, with comments and folded values. Anything else is reported as invalid YAML.
 */
import { Result } from "effect"
import type { Changeset, Release } from "./types.ts"

const isSpace = (char: string) => /^\s$/.test(char)

/** For each index, the first index at or after it whose character is not whitespace (or `length`). */
const nextNonSpaceIndex = (text: string): ReadonlyArray<number> =>
	Array.from({ length: text.length }, (_, i) => i).reduceRight(
		(next, i) => {
			next[i] = isSpace(text.charAt(i)) ? (next[i + 1] ?? text.length) : i
			return next
		},
		Array<number>(text.length + 1).fill(text.length),
	)

/**
 * `@changesets/parse`'s `/\s*---([^]*?)\r?\n\s*---(\s*(?:\n|$)[^]*)/` as one linear scan.
 * Only the first `---` can open a match: a later one has a subset of the same closing lines.
 * The closing line is the first `\n` (or `\r\n`) then optional whitespace then `---`, followed
 * by whitespace that holds a newline or runs to the end.
 */
export const splitFrontmatter = (text: string) => {
	const opener = text.indexOf("---")
	if (opener === -1) return undefined
	const start = opener + 3
	const nextNonSpace = nextNonSpaceIndex(text)
	const closes = (e: number) => {
		const lineStart = text.startsWith("\r\n", e) ? e + 2 : text.charAt(e) === "\n" ? e + 1 : -1
		if (lineStart === -1) return undefined
		const dashes = nextNonSpace[lineStart] ?? text.length
		if (!text.startsWith("---", dashes)) return undefined
		const after = dashes + 3
		const end = nextNonSpace[after] ?? text.length
		const newline = text.indexOf("\n", after)
		return end === text.length || (newline !== -1 && newline < end) ? after : undefined
	}
	const offsets = Array.from({ length: Math.max(text.length - start, 0) }, (_, i) => start + i)
	const close = offsets.find((e) => closes(e) !== undefined)
	if (close === undefined) return undefined
	return { releases: text.slice(start, close), summary: text.slice(closes(close)) }
}
const EXAMPLE_FORMAT = `---\n"package-name": patch\n---`
const validVersionTypes = ["major", "minor", "patch", "none"]

type Scalar = string | number | boolean | null
type YamlValue = Scalar | "object"
interface Entry {
	readonly key: string
	readonly value: YamlValue
}
type Document =
	| { readonly _tag: "Empty" }
	| { readonly _tag: "Map"; readonly entries: ReadonlyArray<Entry> }
	| {
			readonly _tag: "Other"
	  }

type Parsed<A> = Result.Result<A, string>

const truncate = (s: string, max = 200) => (s.length > max ? s.slice(0, max) + "..." : s)

// YAML 1.2 core schema resolution of an unquoted scalar.
const resolvePlain = (text: string): Scalar => {
	if (/^(~|null|Null|NULL)?$/.test(text)) return null
	if (/^(true|True|TRUE)$/.test(text)) return true
	if (/^(false|False|FALSE)$/.test(text)) return false
	if (/^[-+]?[0-9]+$/.test(text)) return Number.parseInt(text, 10)
	if (/^0o[0-7]+$/.test(text)) return Number.parseInt(text.slice(2), 8)
	if (/^0x[0-9a-fA-F]+$/.test(text)) return Number.parseInt(text.slice(2), 16)
	if (/^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/.test(text)) return Number.parseFloat(text)
	if (/^[-+]?\.(inf|Inf|INF)$/.test(text)) return text.startsWith("-") ? -Infinity : Infinity
	if (/^\.(nan|NaN|NAN)$/.test(text)) return Number.NaN
	return text
}

// YAML double-quoted escapes, keyed by the character after the backslash.
const escapes = new Map([
	["0", "\0"],
	["a", "\x07"],
	["b", "\b"],
	["t", "\t"],
	["\t", "\t"],
	["n", "\n"],
	["v", "\v"],
	["f", "\f"],
	["r", "\r"],
	["e", "\x1b"],
	[" ", " "],
	['"', '"'],
	["/", "/"],
	["\\", "\\"],
	["N", "\u0085"],
	["_", "\u00a0"],
	["L", "\u2028"],
	["P", "\u2029"],
])

interface Quoted {
	readonly value: string
	readonly rest: string
}

/** Reads a quoted scalar starting at `text[0]`; returns the value and the rest of the line. */
const readQuoted = (text: string): Parsed<Quoted> => {
	const quote = text[0]
	const chars = Array.from(text.slice(1))
	const read = (index: number, value: string): Parsed<Quoted> => {
		const char = chars[index]
		if (char === undefined) return Result.fail("Missing closing quote")
		if (quote === "'") {
			if (char !== "'") return read(index + 1, value + char)
			return chars[index + 1] === "'"
				? read(index + 2, value + "'")
				: Result.succeed({ value, rest: chars.slice(index + 1).join("") })
		}
		if (char === '"') return Result.succeed({ value, rest: chars.slice(index + 1).join("") })
		if (char !== "\\") return read(index + 1, value + char)
		const escape = chars[index + 1] ?? ""
		const hexLength = escape === "x" ? 2 : escape === "u" ? 4 : escape === "U" ? 8 : 0
		if (hexLength > 0) {
			const hex = chars.slice(index + 2, index + 2 + hexLength).join("")
			return new RegExp(`^[0-9a-fA-F]{${hexLength}}$`).test(hex)
				? read(index + 2 + hexLength, value + String.fromCodePoint(Number.parseInt(hex, 16)))
				: Result.fail("Invalid escape sequence")
		}
		const replacement = escapes.get(escape)
		return replacement === undefined
			? Result.fail(`Invalid escape sequence \\${escape}`)
			: read(index + 2, value + replacement)
	}
	return read(0, "")
}

// A `#` at the start or after whitespace opens a comment that runs to the end of the line.
const stripComment = (text: string) => {
	const at = text.search(/(?:^|\s)#/)
	return (at === -1 ? text : text.slice(0, at)).trim()
}
const isQuote = (text: string) => text.startsWith('"') || text.startsWith("'")

const readValue = (raw: string): Parsed<YamlValue> => {
	const text = raw.trim()
	if (isQuote(text)) {
		return Result.flatMap(readQuoted(text), ({ value, rest }) =>
			stripComment(rest) === ""
				? Result.succeed(value)
				: Result.fail("Unexpected content after a quoted scalar"),
		)
	}
	if (text.startsWith("[") || text.startsWith("{")) return Result.succeed("object")
	if (/^[&*!|>%@`]/.test(text)) return Result.fail(`Unsupported YAML syntax: ${truncate(text, 40)}`)
	const plain = stripComment(text)
	return /:(\s|$)/.test(plain)
		? Result.fail("Nested mappings are not allowed in compact mappings")
		: Result.succeed(resolvePlain(plain))
}

interface Keyed {
	readonly key: string
	readonly rest: string
}

/** Reads `key:` at the start of `line`; `undefined` when the line is not a mapping entry. */
const readKey = (line: string): Parsed<Keyed | undefined> => {
	if (isQuote(line)) {
		return Result.map(readQuoted(line), ({ value, rest }) => {
			const colon = /^\s*:(\s|$)/.exec(rest)
			return colon === null ? undefined : { key: value, rest: rest.slice(colon[0].length) }
		})
	}
	const colon = /:(\s|$)/.exec(line)
	if (colon === null) return Result.succeed(undefined)
	const key = line.slice(0, colon.index).trim()
	if (/^[&*!|>%@`[\]{},#]/.test(key) || /^[-?:]\s/.test(key)) {
		return Result.fail(`Plain value cannot start with reserved character ${key[0]}`)
	}
	const resolved = resolvePlain(key)
	return Result.succeed({
		key: resolved === null ? "" : String(resolved),
		rest: line.slice(colon.index + 1),
	})
}

const readFlowValue = (text: string): Parsed<{ readonly value: YamlValue; readonly after: string }> => {
	if (isQuote(text)) return Result.map(readQuoted(text), ({ value, rest }) => ({ value, after: rest }))
	const comma = text.indexOf(",")
	const end = comma === -1 ? text.length : comma
	return Result.succeed({ value: resolvePlain(text.slice(0, end).trim()), after: text.slice(end) })
}

const parseFlowEntries = (rest: string, entries: ReadonlyArray<Entry>): Parsed<ReadonlyArray<Entry>> =>
	Result.gen(function* () {
		const trimmed = rest.trimStart()
		if (trimmed === "") return entries
		const keyed = yield* readKey(trimmed.replace(/^([^"',]*?):(?=[^\s])/, "$1: "))
		if (keyed === undefined) return yield* Result.fail("Expected a key in the flow mapping")
		const { value, after } = yield* readFlowValue(keyed.rest.trimStart())
		const tail = after.trimStart()
		if (tail !== "" && !tail.startsWith(",")) return yield* Result.fail("Expected , in the flow mapping")
		return yield* parseFlowEntries(tail.slice(1), [...entries, { key: keyed.key, value }])
	})

const parseFlowMapping = (text: string): Parsed<ReadonlyArray<Entry>> => {
	const body = text.trim()
	return body.endsWith("}")
		? parseFlowEntries(body.slice(1, -1), [])
		: Result.fail("Unterminated flow mapping")
}

const indentOf = (line: string) => /^[ \t]*/.exec(line)?.[0].length ?? 0

// A key with nothing after the colon takes its value from the more-indented lines below it.
const readNestedValue = (nested: ReadonlyArray<string>): Parsed<YamlValue> =>
	Result.gen(function* () {
		const first = nested[0]?.trim() ?? ""
		if (first.startsWith("- ") || (yield* readKey(first)) !== undefined) return "object" as const
		return yield* readValue(nested.map((line) => line.trim()).join(" "))
	})

const parseBlockMapping = (lines: ReadonlyArray<string>): Parsed<ReadonlyArray<Entry>> => {
	const baseIndent = indentOf(lines[0] ?? "")
	const step = (index: number, entries: ReadonlyArray<Entry>): Parsed<ReadonlyArray<Entry>> =>
		Result.gen(function* () {
			const line = lines[index]
			if (line === undefined) return entries
			if (indentOf(line) !== baseIndent) return yield* Result.fail("Bad indentation of a mapping entry")
			const keyed = yield* readKey(line.trim())
			if (keyed === undefined)
				return yield* Result.fail("Implicit map keys need to be followed by map values")
			const end = lines.slice(index + 1).findIndex((next) => indentOf(next) <= baseIndent)
			const nested = lines.slice(index + 1, end === -1 ? lines.length : index + 1 + end)
			const inline = stripComment(keyed.rest) === "" ? "" : keyed.rest
			if (inline !== "" && nested.length > 0)
				return yield* Result.fail("Bad indentation of a mapping entry")
			const value = nested.length === 0 ? yield* readValue(inline) : yield* readNestedValue(nested)
			return yield* step(index + 1 + nested.length, [...entries, { key: keyed.key, value }])
		})
	return step(0, [])
}

const parseDocument = (text: string): Parsed<Document> =>
	Result.gen(function* () {
		const lines = text
			.split(/\r?\n/)
			.map((line) => line.replace(/\r$/, ""))
			.filter((line) => line.trim() !== "" && !line.trim().startsWith("#"))
		const first = lines[0]?.trim()
		if (first === undefined) return { _tag: "Empty" } as const
		if (first.startsWith("{")) {
			return {
				_tag: "Map",
				entries: yield* parseFlowMapping(lines.map(stripComment).join(" ")),
			} as const
		}
		if (first.startsWith("- ") || first === "-" || first.startsWith("["))
			return { _tag: "Other" } as const
		if (lines.length === 1 && (yield* readKey(first)) === undefined) {
			yield* readValue(first)
			return { _tag: "Other" } as const
		}
		return { _tag: "Map", entries: yield* parseBlockMapping(lines) } as const
	})

const typeName = (value: YamlValue) => (value === null || value === "object" ? "object" : typeof value)

const validateReleases = (
	entries: ReadonlyArray<Entry>,
	contents: string,
): Result.Result<ReadonlyArray<Release>, string> => {
	const invalid = entries.flatMap((entry): ReadonlyArray<string> => {
		if (entry.key.trim() === "") {
			return [
				`could not parse changeset - invalid package name in frontmatter.\nExpected a non-empty string for package name, but got: ${JSON.stringify(entry.key)}\nChangeset contents:\n${truncate(contents)}`,
			]
		}
		if (typeof entry.value !== "string" || entry.value === "object") {
			return [
				`could not parse changeset - invalid release type for package "${entry.key}".\nExpected a string for release type, but got: ${typeName(entry.value)}\nChangeset contents:\n${truncate(contents)}`,
			]
		}
		if (!validVersionTypes.includes(entry.value)) {
			return [
				`could not parse changeset - invalid version type ${JSON.stringify(entry.value)} for package "${entry.key}".\nValid version types are: ${validVersionTypes.join(", ")}\nChangeset contents:\n${truncate(contents)}`,
			]
		}
		return []
	})
	const [first] = invalid
	if (first !== undefined) return Result.fail(first)
	return Result.succeed(
		entries.flatMap((entry) =>
			entry.value === "major" ||
			entry.value === "minor" ||
			entry.value === "patch" ||
			entry.value === "none"
				? [{ name: entry.key, type: entry.value }]
				: [],
		),
	)
}

const readDocument = (yaml: string): Parsed<Document> =>
	Result.flatMap(parseDocument(yaml), (document) => {
		if (document._tag !== "Map") return Result.succeed<Document>(document)
		const keys = document.entries.map((entry) => entry.key)
		return new Set(keys).size === keys.length
			? Result.succeed<Document>(document)
			: Result.fail("Map keys must be unique")
	})

/** Parses one changeset file; the failure is the message changesets would print. */
export const parseChangesetFile = (contents: string): Result.Result<Changeset, string> => {
	const trimmedContents = contents.trim()
	if (!trimmedContents) {
		return Result.fail(
			`could not parse changeset - file is empty.\nChangesets must have frontmatter with package names and version types.\nExample:\n${EXAMPLE_FORMAT}\n\nYour changeset summary here.`,
		)
	}
	const split = splitFrontmatter(contents)
	if (split === undefined) {
		return Result.fail(
			`could not parse changeset - missing or invalid frontmatter.\nChangesets must start with frontmatter delimited by "---".\nExample:\n${EXAMPLE_FORMAT}\n\nYour changeset summary here.\nReceived content:\n${truncate(trimmedContents)}`,
		)
	}
	const { releases: roughReleases, summary: roughSummary } = split
	const summary = roughSummary.trim()
	const document = readDocument(roughReleases)
	if (Result.isFailure(document)) {
		return Result.fail(
			`could not parse changeset - invalid YAML in frontmatter.\nThe frontmatter between the "---" delimiters must be valid YAML.\nYAML error: ${document.failure}\nFrontmatter content:\n${roughReleases}`,
		)
	}
	if (document.success._tag === "Other") {
		return Result.fail(
			`could not parse changeset - frontmatter must be an object mapping package names to version types.\nExpected format:\n${EXAMPLE_FORMAT}\nReceived:\n${roughReleases}`,
		)
	}
	const entries = document.success._tag === "Empty" ? [] : document.success.entries
	return Result.map(validateReleases(entries, contents), (releases) => ({ releases, summary }))
}

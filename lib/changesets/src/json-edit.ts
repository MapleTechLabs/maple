/**
 * Formatting-preserving `package.json` edits, as `@changesets/apply-release-plan` does with
 * jsonc-parser: each edit replaces only the text of an existing value with `JSON.stringify(value)`.
 */
import { Result } from "effect"

export interface JsonEdit {
	readonly keys: ReadonlyArray<string>
	readonly value: string
}

interface Node {
	readonly offset: number
	readonly length: number
	readonly properties: ReadonlyArray<{ readonly key: string; readonly node: Node }> | undefined
}

type Parsed<A> = Result.Result<A, string>
interface Step<A> {
	readonly value: A
	readonly end: number
}

const skipWhitespace = (text: string, at: number): number => {
	const match = /^[ \t\n\r]*/.exec(text.slice(at))
	return at + (match?.[0].length ?? 0)
}

const stringPattern = /^"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/
const literalPattern = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?)/

const parseString = (text: string, at: number): Parsed<Step<string>> => {
	const match = stringPattern.exec(text.slice(at))
	return match === null
		? Result.fail(`Invalid string at offset ${at}`)
		: Result.succeed({ value: JSON.parse(match[0]), end: at + match[0].length })
}

const parseMembers = <A>(
	text: string,
	at: number,
	close: string,
	member: (at: number) => Parsed<Step<A>>,
	members: ReadonlyArray<A>,
): Parsed<Step<ReadonlyArray<A>>> =>
	Result.gen(function* () {
		const parsed = yield* member(skipWhitespace(text, at))
		const next = skipWhitespace(text, parsed.end)
		const all = [...members, parsed.value]
		if (text[next] === ",") return yield* parseMembers(text, next + 1, close, member, all)
		if (text[next] === close) return { value: all, end: next + 1 }
		return yield* Result.fail(`Expected "," or "${close}" at offset ${next}`)
	})

const parseValue = (text: string, at: number): Parsed<Node> =>
	Result.gen(function* () {
		const char = text[at]
		if (char === "{") {
			const first = skipWhitespace(text, at + 1)
			if (text[first] === "}") return { offset: at, length: first + 1 - at, properties: [] }
			const members = yield* parseMembers(text, first, "}", (start) => parseProperty(text, start), [])
			return { offset: at, length: members.end - at, properties: members.value }
		}
		if (char === "[") {
			const first = skipWhitespace(text, at + 1)
			if (text[first] === "]") return { offset: at, length: first + 1 - at, properties: undefined }
			const items = yield* parseMembers(text, first, "]", (start) => parseItem(text, start), [])
			return { offset: at, length: items.end - at, properties: undefined }
		}
		if (char === '"') {
			const string = yield* parseString(text, at)
			return { offset: at, length: string.end - at, properties: undefined }
		}
		const literal = literalPattern.exec(text.slice(at))
		if (literal === null) return yield* Result.fail(`Unexpected token at offset ${at}`)
		return { offset: at, length: literal[0].length, properties: undefined }
	})

const parseItem = (text: string, at: number): Parsed<Step<Node>> =>
	Result.map(parseValue(text, at), (node) => ({ value: node, end: node.offset + node.length }))

const parseProperty = (
	text: string,
	at: number,
): Parsed<Step<{ readonly key: string; readonly node: Node }>> =>
	Result.gen(function* () {
		const key = yield* parseString(text, at)
		const colon = skipWhitespace(text, key.end)
		if (text[colon] !== ":") return yield* Result.fail(`Expected ":" at offset ${colon}`)
		const node = yield* parseValue(text, skipWhitespace(text, colon + 1))
		return { value: { key: key.value, node }, end: node.offset + node.length }
	})

const parseDocument = (text: string): Parsed<Node> =>
	Result.gen(function* () {
		const root = yield* parseValue(text, skipWhitespace(text, 0))
		const end = skipWhitespace(text, root.offset + root.length)
		if (end !== text.length) return yield* Result.fail(`Unexpected content at offset ${end}`)
		return root
	})

const valueNode = (root: Node, keys: ReadonlyArray<string>): Node | undefined =>
	keys.reduce<Node | undefined>(
		(node, key) => node?.properties?.find((property) => property.key === key)?.node,
		root,
	)

/** Applies every edit to `json`; fails when the JSON is invalid or a key path is missing. */
export const editJson = (json: string, edits: ReadonlyArray<JsonEdit>): Parsed<string> =>
	Result.gen(function* () {
		const root = yield* parseDocument(json)
		const located = yield* Result.all(
			edits.map((edit) => {
				const node = valueNode(root, edit.keys)
				return node === undefined
					? Result.fail(`Key path "${edit.keys.join(".")}" not found in JSON`)
					: Result.succeed({ node, content: JSON.stringify(edit.value) })
			}),
		)
		return located
			.toSorted((a, b) => b.node.offset - a.node.offset)
			.reduce(
				(text, { node, content }) =>
					text.slice(0, node.offset) + content + text.slice(node.offset + node.length),
				json,
			)
	})

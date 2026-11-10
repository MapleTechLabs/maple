import { Array as Arr, String as Str } from "effect"
import { describe, expect, it } from "vitest"
import { APP_DOCUMENT_HEADERS, ASSET_HEADER_RULES, documentHeaders } from "./document-headers"

interface Rule {
	readonly pattern: string
	readonly lines: ReadonlyArray<string>
}

const parseRules = (source: string): ReadonlyArray<Rule> =>
	Arr.reduce(
		Arr.filter(Str.split("\n")(source), (line) => line.length > 0),
		Arr.empty<Rule>(),
		(rules, line) => {
			if (!Str.startsWith(" ")(line)) return [...rules, { pattern: line, lines: [] }]
			const last = Arr.last(rules)
			if (last._tag === "None") return rules
			return [
				...Arr.dropRight(rules, 1),
				{ pattern: last.value.pattern, lines: [...last.value.lines, Str.trim(line)] },
			]
		},
	)

// A splat spans any characters.
const matches = (pattern: string, pathname: string): boolean =>
	new RegExp(`^${Str.replace(/\*/g, ".*")(Str.replace(/[.+?^${}()|[\]\\]/g, "\\$&")(pattern))}$`).test(
		pathname,
	)

/**
 * What the assets layer sends for a path, by its documented `_headers` semantics: a request
 * inherits every matching rule in file order, `! Name` detaches, and a header attached by
 * two rules is appended (comma-joined), not replaced.
 */
const assetHeadersFor = (pathname: string): Headers => {
	const headers = new Headers()
	const attached = new Set<string>()
	Arr.forEach(
		Arr.filter(parseRules(ASSET_HEADER_RULES), (rule) => matches(rule.pattern, pathname)),
		(rule) => {
			Arr.forEach(rule.lines, (line) => {
				if (Str.startsWith("! ")(line)) headers.delete(Str.slice(2)(line))
			})
			Arr.forEach(rule.lines, (line) => {
				if (Str.startsWith("! ")(line)) return
				const [name, ...rest] = Str.split(":")(line)
				const value = Str.trim(Arr.join(rest, ":"))
				if (attached.has(Str.toLowerCase(name))) headers.append(name, value)
				else headers.set(name, value)
				attached.add(Str.toLowerCase(name))
			})
		},
	)
	return headers
}

const securityHeadersFor = (pathname: string): ReadonlyArray<readonly [string, string | null]> => {
	const headers = assetHeadersFor(pathname)
	return Arr.map(APP_DOCUMENT_HEADERS, ([name]) => [name, headers.get(name)])
}

const expectedFor = (pathname: string): ReadonlyArray<readonly [string, string | null]> => {
	const wanted = new Map(documentHeaders(pathname))
	return Arr.map(APP_DOCUMENT_HEADERS, ([name]) => [name, wanted.get(name) ?? null])
}

describe("ASSET_HEADER_RULES", () => {
	it("sends a document served by the assets layer the headers the Worker would set", () => {
		const paths = ["/", "/traces", "/alerts/rules/r1", "/share", "/share/tok_123", "/share/tok_123/embed"]
		expect(Arr.map(paths, (path) => [path, securityHeadersFor(path)])).toEqual(
			Arr.map(paths, (path) => [path, expectedFor(path)]),
		)
	})

	it("keeps a share page frameable although the app rule matches it too", () => {
		expect(assetHeadersFor("/share/tok_123").get("x-frame-options")).toBeNull()
		expect(assetHeadersFor("/traces").get("x-frame-options")).toBe("DENY")
	})

	it("caches hashed assets forever and the version file never", () => {
		expect(assetHeadersFor("/assets/index-abc123.js").get("cache-control")).toBe(
			"public, max-age=31536000, immutable",
		)
		expect(assetHeadersFor("/version.json").get("cache-control")).toBe("no-store, must-revalidate")
	})
})

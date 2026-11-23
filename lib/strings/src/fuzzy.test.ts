import { describe, expect, it } from "vitest"
import { Array as Arr } from "effect"
import { fuzzySearch, makeFuzzySearch, type FuzzyOptions } from "./fuzzy"

interface Page {
	readonly title: string
	readonly tags: string
}

const pages: ReadonlyArray<Page> = [
	{ title: "Overview", tags: "home" },
	{ title: "Services", tags: "apps" },
	{ title: "Service map", tags: "topology graph" },
	{ title: "Kubernetes Services", tags: "k8s" },
	{ title: "Logs", tags: "search" },
	{ title: "SLOs", tags: "objectives" },
	{ title: "Settings", tags: "ingest keys" },
]

const options: FuzzyOptions<Page> = {
	keys: [
		{ get: (page) => page.title, weight: 0.7 },
		{ get: (page) => page.tags, weight: 0.3 },
	],
	threshold: 0.35,
}
const titles = (query: string, opts = options) =>
	Arr.map(fuzzySearch(pages, query, opts), (match) => match.item.title)

describe("fuzzySearch", () => {
	it("ranks a whole-field match, then a prefix, then a later word's start, then mid-word", () => {
		// "Service map" is one edit from "services", so the typo fallback ranks it last.
		expect(titles("services")).toEqual(["Services", "Kubernetes Services", "Service map"])
		expect(titles("serv").slice(0, 3)).toEqual(["Services", "Service map", "Kubernetes Services"])
		expect(titles("map")[0]).toBe("Service map")
		expect(titles("vices").slice(0, 2)).toEqual(["Services", "Kubernetes Services"])
	})

	it("forgives a typo within the budget, a swapped pair counting as one edit", () => {
		expect(titles("srevices")[0]).toBe("Services")
		expect(titles("lgos")[0]).toBe("Logs")
		expect(titles("setings")).toEqual(["Settings"])
		// Four edits in eight letters is past a 0.35 budget.
		expect(titles("sxxxxces")).toEqual([])
	})

	it("scores swapped first letters as a word-start typo, not a mid-word one", () => {
		// "onde" is one swap from "node" and one deletion from the "ode" inside "code".
		const search = makeFuzzySearch([{ title: "Code review" }, { title: "Node.js" }], {
			keys: [{ get: (item) => item.title, weight: 1 }],
			threshold: 0.3,
		})
		expect(Arr.map(search("onde"), (match) => match.item.title)).toEqual(["Node.js", "Code review"])
	})

	it("ranks a match in a lighter key below the same match in a heavier one", () => {
		const both = [
			{ title: "Keys", tags: "ingest" },
			{ title: "Ingest", tags: "pipeline" },
		]
		const search = makeFuzzySearch(both, options)
		expect(Arr.map(search("ingest"), (match) => match.item.title)).toEqual(["Ingest", "Keys"])
	})

	it("matches every word of a multi-word query at word starts, in any order", () => {
		expect(titles("map service")[0]).toBe("Service map")
	})

	it("keeps input order between equal matches, caps at the limit, and ignores short queries", () => {
		const twins = [
			{ title: "Install", tags: "" },
			{ title: "Install", tags: "" },
			{ title: "Install", tags: "" },
		]
		const search = makeFuzzySearch(twins, { ...options, minQueryLength: 3 })
		expect(Arr.map(search("install", 2), (match) => match.refIndex)).toEqual([0, 1])
		expect(search("in")).toEqual([])
		expect(titles("   ")).toEqual([])
	})

	it("matches a key with several values on its best one", () => {
		const search = makeFuzzySearch([{ names: ["betamax"] }, { names: ["alpha", "beta"] }], {
			keys: [{ get: (item) => item.names, weight: 1 }],
			threshold: 0.3,
		})
		// The second item's exact "beta" beats the first's prefix, despite coming later.
		expect(Arr.map(search("beta"), (match) => match.refIndex)).toEqual([1, 0])
	})
})

describe("fuzzySearch edge cases", () => {
	const one = (fields: ReadonlyArray<string>, threshold = 0.3) =>
		makeFuzzySearch(fields, { keys: [{ get: (field) => field, weight: 1 }], threshold })

	it("matches a field shorter than the query only while the length gap fits the typo budget", () => {
		// Five letters allow one edit: one extra letter still matches "logs", two do not.
		expect(Arr.map(one(["logs"])("logsx"), (match) => match.item)).toEqual(["logs"])
		expect(one(["logs"])("logsxx")).toEqual([])
		expect(one(["ab"])("abcdefgh")).toEqual([])
	})

	it("keeps a word-start alignment when a deletion ties with a substitution", () => {
		// Both are one edit at a word start ("logs" by deleting the x, "blogs" by substituting it),
		// so input order decides; a lost word start would sink "a logs" below "blogs z".
		const search = one(["a logs", "blogs z"])
		expect(Arr.map(search("xlogs"), (match) => match.item)).toEqual(["a logs", "blogs z"])
	})

	it("ranks a higher match kind above a lower one whatever the word counts and other keys", () => {
		const long = Arr.join(
			Arr.makeBy(20, () => "word"),
			" ",
		)
		const rows = [
			{ heading: `Services ${long}`, title: "Zzz" },
			{ heading: "A services", title: "B services" },
			{ heading: "Services", title: "Services overview" },
			{ heading: `A services ${long}`, title: "Zzz" },
		]
		const search = makeFuzzySearch(rows, {
			keys: [
				{ get: (row) => row.heading, weight: 0.6 },
				{ get: (row) => row.title, weight: 0.4 },
			],
			threshold: 0.3,
		})
		// Exact, then prefix, then word start: within each kind, fewer words and more keys win.
		expect(Arr.map(search("services"), (match) => match.refIndex)).toEqual([2, 0, 1, 3])
	})
})

import { Array as Arr, Order, String as Str } from "effect"

/** Verbs every other tool starts with: sharing one says nothing about which tool was meant. */
const VERBS: ReadonlySet<string> = new Set(["get", "list", "find", "search", "show", "fetch", "v2"])

const MAX_SUGGESTIONS = 3

/** `GET /v2/uptime_monitors` -> `["uptime", "monitor"]`: lower-case words, plurals folded. */
const words = (name: string): ReadonlyArray<string> =>
	Arr.map(
		Arr.filter(Str.split(/[^a-z0-9]+/)(Str.toLowerCase(name)), (word) => word.length > 1),
		(word) => (word.length > 3 && Str.endsWith("s")(word) ? Str.slice(0, -1)(word) : word),
	)

const editDistance = (a: string, b: string): number => {
	const previous = Arr.makeBy(b.length + 1, (index) => index)
	for (let i = 1; i <= a.length; i++) {
		let diagonal = previous[0] ?? 0
		previous[0] = i
		for (let j = 1; j <= b.length; j++) {
			const above = previous[j] ?? 0
			const left = previous[j - 1] ?? 0
			previous[j] = Math.min(above + 1, left + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1))
			diagonal = above
		}
	}
	return previous[b.length] ?? 0
}

interface Scored {
	readonly name: string
	readonly shared: number
	readonly distance: number
}

const byRelevance = Order.combine(
	Order.mapInput(Order.flip(Order.Number), (scored: Scored) => scored.shared),
	Order.mapInput(Order.Number, (scored: Scored) => scored.distance),
)

/**
 * The tools a caller most likely meant by a name that does not exist: shared words first
 * (`uptime_monitors` -> `list_uptime_monitors`), then close spellings (`serch_traces`).
 */
export const suggestToolNames = (name: string, available: ReadonlyArray<string>): ReadonlyArray<string> => {
	const asked = Arr.filter(words(name), (word) => !VERBS.has(word))
	const lower = Str.toLowerCase(name)
	const scored = Arr.flatMap(available, (candidate): ReadonlyArray<Scored> => {
		const candidateWords = words(candidate)
		const shared = Arr.filter(asked, (word) => candidateWords.includes(word)).length
		const distance = editDistance(lower, candidate)
		const close = distance <= Math.max(2, Math.floor(candidate.length / 4))
		return shared > 0 || close ? [{ name: candidate, shared, distance }] : []
	})
	return Arr.map(Arr.take(Arr.sort(scored, byRelevance), MAX_SUGGESTIONS), (scored) => scored.name)
}

/** What a model reads for an unknown tool name: the likely tools, and where the full list is. */
export const unknownToolMessage = (name: string, available: ReadonlyArray<string>): string => {
	const suggestions = suggestToolNames(name, available)
	const listed = Arr.map(suggestions, (suggestion) => `\`${suggestion}\``)
	return suggestions.length === 0
		? `Unknown tool \`${name}\`. Call tools/list to see the available tools.`
		: `Unknown tool \`${name}\`. Did you mean ${Arr.join(listed, ", ")}? tools/list has every tool.`
}

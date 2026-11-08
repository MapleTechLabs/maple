import { Array as Arr, Order, String as Str } from "effect"

const MAX_SUGGESTIONS = 3

/** `Organization_Memberships` -> `["organization", "membership"]`: lower-case words, plurals folded. */
export const words = (text: string): ReadonlyArray<string> =>
	Arr.map(
		Arr.filter(Str.split(/[^a-z0-9]+/)(Str.toLowerCase(text)), (word) => word.length > 1),
		(word) =>
			word.length > 3 && Str.endsWith("s")(word) && !Str.endsWith("ss")(word)
				? Str.slice(0, -1)(word)
				: word,
	)

export const editDistance = (a: string, b: string): number => {
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

/** The names a caller most likely meant: shared words first, then close spellings. */
export const suggestNames = (asked: string, available: ReadonlyArray<string>): ReadonlyArray<string> => {
	const askedWords = words(asked)
	const lower = Str.toLowerCase(asked)
	const scored = Arr.flatMap(available, (candidate): ReadonlyArray<Scored> => {
		const candidateWords = words(candidate)
		const shared = Arr.filter(askedWords, (word) => candidateWords.includes(word)).length
		const distance = editDistance(lower, Str.toLowerCase(candidate))
		const close = distance <= Math.max(2, Math.floor(candidate.length / 4))
		return shared > 0 || close ? [{ name: candidate, shared, distance }] : []
	})
	return Arr.map(Arr.take(Arr.sort(scored, byRelevance), MAX_SUGGESTIONS), (scored) => scored.name)
}

/** "Did you mean `a` or `b`?" or the empty string. */
export const didYouMean = (asked: string, available: ReadonlyArray<string>): string => {
	const suggestions = suggestNames(asked, available)
	return suggestions.length === 0
		? ""
		: ` Did you mean ${Arr.join(
				Arr.map(suggestions, (s) => `\`${s}\``),
				" or ",
			)}?`
}

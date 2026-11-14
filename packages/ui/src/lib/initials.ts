import { Array as Arr, String as Str } from "effect"
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** First grapheme cluster, so "🦊 Fox" and "👩🏽‍💻 Priya" keep their emoji whole. */
const firstGrapheme = (word: string): string =>
	segmenter.segment(word)[Symbol.iterator]().next().value?.segment ?? ""

/**
 * Up to two initials from the first and last word of a display name, or of the
 * local part of an email. Empty input returns `fallback`.
 */
export function initialsFrom(name: string | null | undefined, fallback = "?"): string {
	const trimmed = Str.trim(name ?? "")
	if (trimmed === "") return fallback
	const base =
		Str.includes("@")(trimmed) && !Str.includes(" ")(trimmed)
			? Str.split("@")(trimmed)[0] || trimmed
			: trimmed
	const words = Arr.filter(Str.split(/[\s._-]+/)(base), (word) => word !== "")
	const [firstWord, ...rest] = words
	if (firstWord === undefined) return fallback
	const first = firstGrapheme(firstWord)
	const lastWord = rest.at(-1)
	const last = lastWord === undefined ? "" : firstGrapheme(lastWord)
	return Str.toLocaleUpperCase()(`${first}${last}`)
}

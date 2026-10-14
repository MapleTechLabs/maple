const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** First grapheme cluster, so "🦊 Fox" and "👩🏽‍💻 Priya" keep their emoji whole. */
const firstGrapheme = (word: string): string =>
	segmenter.segment(word)[Symbol.iterator]().next().value?.segment ?? ""

/**
 * Up to two initials from the first and last word of a display name, or of the
 * local part of an email. Empty input returns `fallback`.
 */
export function initialsFrom(name: string | null | undefined, fallback = "?"): string {
	const trimmed = (name ?? "").trim()
	if (trimmed === "") return fallback
	const base = trimmed.includes("@") && !trimmed.includes(" ") ? trimmed.split("@")[0] || trimmed : trimmed
	const words = base.split(/[\s._-]+/).filter((word) => word !== "")
	if (words.length === 0) return fallback
	const first = firstGrapheme(words[0])
	const last = words.length > 1 ? firstGrapheme(words[words.length - 1]) : ""
	return `${first}${last}`.toLocaleUpperCase()
}

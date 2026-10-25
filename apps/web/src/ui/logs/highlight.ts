import type { Html, HtmlBuilder } from "foldkit/html"
import { rowClass } from "./styles"

const MAX_MATCHES = 40

/**
 * Occurrences of `query` in `text` as alternating plain/match segments: one case-insensitive
 * substring, like the backend's `Body ILIKE`.
 */
export const splitOnMatches = (
	text: string,
	query: string,
): ReadonlyArray<{ text: string; match: boolean }> => {
	const needle = query.trim().toLowerCase()
	if (needle === "") return [{ text, match: false }]
	const haystack = text.toLowerCase()
	const segments: Array<{ text: string; match: boolean }> = []
	const step = (cursor: number, found: number): number => {
		if (found >= MAX_MATCHES) return cursor
		const at = haystack.indexOf(needle, cursor)
		if (at === -1) return cursor
		if (at > cursor) segments.push({ text: text.slice(cursor, at), match: false })
		segments.push({ text: text.slice(at, at + needle.length), match: true })
		return step(at + needle.length, found + 1)
	}
	const cursor = step(0, 0)
	if (segments.length === 0) return [{ text, match: false }]
	if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false })
	return segments
}

/** `<HighlightedText>`: the text with every match of the active search marked. */
export const highlightedText = <Message>(
	h: HtmlBuilder<Message>,
	text: string,
	query: string | undefined,
): ReadonlyArray<Html | string> =>
	query === undefined || query === ""
		? [text]
		: splitOnMatches(text, query).map((segment) =>
				segment.match
					? h.mark(
							[
								rowClass(
									h,
									"rounded-xs bg-primary/30 px-px text-foreground [text-decoration:inherit]",
								),
							],
							[segment.text],
						)
					: segment.text,
			)

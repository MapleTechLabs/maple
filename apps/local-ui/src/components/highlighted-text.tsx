// Ported from apps/web/src/components/logs/highlighted-text.tsx: marks every
// occurrence of the active log search in a row, mirroring the server predicate
// (one case-insensitive substring), so a highlight is never one the query did
// not cause.

import { Fragment, memo, useMemo } from "react"

const MAX_MATCHES = 40

/** Occurrences of `query` inside `text`, as alternating plain/match segments. */
export function splitOnMatches(text: string, query: string): ReadonlyArray<{ text: string; match: boolean }> {
	const needle = query.trim().toLowerCase()
	if (needle === "") return [{ text, match: false }]

	const haystack = text.toLowerCase()
	const segments: { text: string; match: boolean }[] = []
	let cursor = 0
	// A one-character query against a long body would otherwise split the line
	// into thousands of nodes, on every row of a virtualized stream.
	for (let found = 0; found < MAX_MATCHES; found++) {
		const at = haystack.indexOf(needle, cursor)
		if (at === -1) break
		if (at > cursor) segments.push({ text: text.slice(cursor, at), match: false })
		segments.push({ text: text.slice(at, at + needle.length), match: true })
		cursor = at + needle.length
	}
	if (segments.length === 0) return [{ text, match: false }]
	if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false })
	return segments
}

export const HighlightedText = memo(function HighlightedText({
	text,
	query,
}: {
	text: string
	query?: string
}) {
	const segments = useMemo(() => (query ? splitOnMatches(text, query) : undefined), [text, query])
	if (!segments) return text
	return segments.map((segment, index) =>
		segment.match ? (
			<mark
				key={index}
				className="rounded-[2px] bg-primary/30 px-px text-foreground [text-decoration:inherit]"
			>
				{segment.text}
			</mark>
		) : (
			<Fragment key={index}>{segment.text}</Fragment>
		),
	)
})

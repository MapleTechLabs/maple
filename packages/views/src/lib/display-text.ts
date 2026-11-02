import { trySync } from "@maple/ui/lib/try-sync"
import { Option, Schema } from "effect"

// Log bodies and attribute values can be megabytes, and views rerun on every message. These keep
// what a view parses and builds bounded, whatever the size of the value it shows.

/** Past this many characters a view shows the head; copy actions still carry the whole value. */
export const DISPLAY_MAX_CHARS = 200_000

/** A collapsed preview never builds more than this, whatever its line count. */
export const PREVIEW_MAX_CHARS = 2_000

/** A list row shows one truncated line; laying out a megabyte line to show 100 characters froze it. */
export const ROW_LINE_CHARS = 1_000

/** A wrapped list row shows a few screens at most; the detail sheet has the rest. */
export const ROW_WRAPPED_CHARS = 10_000

/** How much context a cut window keeps before the search match it opens on. */
const MATCH_LEAD_CHARS = 200

/** Only values this long are worth caching; shorter ones recompute faster than a lookup costs. */
const MEMO_MIN_CHARS = 10_000
const MEMO_CAPACITY = 4

/** `compute` with a tiny LRU over long inputs, so rerendering one big value does the work once. */
export const memoizeByText = <A extends {}>(compute: (input: string) => A): ((input: string) => A) => {
	const cache = new Map<string, A>()
	return (input) => {
		if (input.length < MEMO_MIN_CHARS) return compute(input)
		const hit = cache.get(input)
		if (hit !== undefined) {
			cache.delete(input)
			cache.set(input, hit)
			return hit
		}
		const value = compute(input)
		cache.set(input, value)
		const oldest = cache.keys().next()
		if (cache.size > MEMO_CAPACITY && !oldest.done) cache.delete(oldest.value)
		return value
	}
}

/** `text` cut to `limit` characters, and how many were left out. */
export const capForDisplay = (
	text: string,
	limit: number = DISPLAY_MAX_CHARS,
): { readonly shown: string; readonly omitted: number } =>
	text.length <= limit
		? { shown: text, omitted: 0 }
		: { shown: text.slice(0, limit), omitted: text.length - limit }

/** At most `limit` characters of `text`, opening just before the first `query` match so it stays visible. */
export const textWindow = (text: string, query: string | undefined, limit: number): string => {
	if (text.length <= limit) return text
	const needle = query?.trim().toLowerCase() ?? ""
	const hit = needle === "" ? -1 : text.toLowerCase().indexOf(needle)
	const at = hit === -1 ? 0 : Math.max(0, hit - MATCH_LEAD_CHARS)
	return `${at > 0 ? "…" : ""}${text.slice(at, at + limit)}${at + limit < text.length ? "…" : ""}`
}

/** The first `count` lines of `text`. */
export const headLines = (text: string, count: number): string => text.split("\n", count).join("\n")

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

/** An object or array body, else `None`. */
export const tryParseJson = (value: string): Option.Option<unknown> => {
	const trimmed = value.trimStart()
	return trimmed[0] !== "{" && trimmed[0] !== "[" ? Option.none() : decodeJson(value)
}

/** A JSON object or array re-indented with two spaces; none for anything else. */
export const prettyJson: (value: string) => Option.Option<string> = memoizeByText((value) =>
	// A pathologically deep value parses but overflows the stack re-indenting; it then shows as text.
	Option.flatMap(tryParseJson(value), (parsed) => trySync(() => JSON.stringify(parsed, null, 2))),
)

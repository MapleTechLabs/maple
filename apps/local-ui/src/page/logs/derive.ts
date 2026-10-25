import { stripAnsi } from "@maple/ui/components/logs/strip-ansi"
import { type ChipTone, pickImportantAttributes } from "@maple/ui/lib/log-attributes"
import { ROW_LINE_CHARS, tryParseJson } from "@maple/web/lib/display-text"
import { Option } from "effect"
import type { LocalLog } from "./model"

// The pure parts of `LogRow` and `LogAttributeChip`.

const VISIBLE_CHIPS = 3
const MAX_VALUE_CHARS = 24
export { severityLabel } from "../kit/log-sheet/parts"

export interface RowChip {
	readonly key: string
	readonly value: string
	readonly tone: ChipTone
	readonly displayKey: string
	readonly displayValue: string
}

/** Shortens an attribute key for a chip. */
const shortKey = (key: string): string => {
	if (key === "http.status_code" || key === "http.response.status_code") return "status"
	if (key === "http.method" || key === "http.request.method") return "method"
	if (key === "http.url" || key === "url.full") return "url"
	if (key === "http.route" || key === "url.path") return "path"
	return key
}

const truncateValue = (value: string): string =>
	value.length <= MAX_VALUE_CHARS ? value : `${value.slice(0, MAX_VALUE_CHARS - 1)}…`

/** Only chips that add to the message: log attributes whose value the body does not spell out. */
export const rowChips = (log: LocalLog): ReadonlyArray<RowChip> =>
	pickImportantAttributes({ ...log, logAttributes: { ...log.logAttributes }, resourceAttributes: { ...log.resourceAttributes } }, Number.POSITIVE_INFINITY)
		.filter((attr) => attr.source === "log" && !(attr.value.length >= 3 && log.body.includes(attr.value)))
		.slice(0, VISIBLE_CHIPS)
		.map((attr) => ({
			key: attr.key,
			value: attr.value,
			tone: attr.tone,
			displayKey: shortKey(attr.key),
			displayValue: Option.isSome(tryParseJson(attr.value)) ? "{…}" : truncateValue(attr.value),
		}))

/** The row's one line: the first, or the first that matches the search; and how many are hidden. */
export const firstLineOf = (body: string, search: string | undefined): Readonly<{ text: string; hidden: number }> => {
	const lines = stripAnsi(body).split("\n")
	const needle = search?.toLowerCase()
	const match = needle ? lines.find((line) => line.toLowerCase().includes(needle)) : undefined
	const line = match ?? lines[0] ?? ""
	// A long line opens a little before the match so the highlighted term stays in view.
	const at = needle && line.length > ROW_LINE_CHARS ? Math.max(0, line.toLowerCase().indexOf(needle) - 200) : 0
	return { text: line.slice(at, at + ROW_LINE_CHARS), hidden: lines.length - 1 }
}

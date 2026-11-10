import { String as Str, Option } from "effect"

// Labels for relative time range shorthands ("15m", "24h", "1mo"), shared by the dashboard and Maple Local.

const UNIT_LABELS = new Map<string, readonly [string, string]>([
	["m", ["minute", "minutes"]],
	["h", ["hour", "hours"]],
	["d", ["day", "days"]],
	["w", ["week", "weeks"]],
	["mo", ["month", "months"]],
])

/** "15m" is "Last 15 minutes", "12mo" is "Last 1 year", "today" is "Today"; anything else is itself. */
export const presetLabel = (shorthand: string): string => {
	if (shorthand === "12mo") return "Last 1 year"
	const trimmed = Str.toLowerCase(Str.trim(shorthand))
	if (trimmed === "today") return "Today"
	const matched = Str.match(/^(\d+)(mo|m|h|d|w)$/)(trimmed)
	if (Option.isNone(matched)) return shorthand
	const match = matched.value
	const amount = Number.parseInt(match[1] ?? "0", 10)
	const [singular, plural] = UNIT_LABELS.get(match[2] ?? "") ?? [match[2] ?? "", match[2] ?? ""]
	return `Last ${amount} ${amount === 1 ? singular : plural}`
}

/** The span a preset names, for "vs previous …" copy: "1mo" is "month", "2w" is "2 weeks". */
export const presetSpanLabel = (shorthand: string): string => {
	const label = presetLabel(shorthand)
	if (label === "Today") return "day"
	if (!Str.startsWith("Last ")(label)) return label
	const span = Str.slice("Last ".length)(label)
	return Str.startsWith("1 ")(span) ? Str.slice(2)(span) : span
}

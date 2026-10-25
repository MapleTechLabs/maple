import { formatDuration } from "@maple/ui/lib/format"

// copied: the parsing and formatting half of packages/ui/src/components/filters/range-filter-section.tsx
// (the React module also holds the component).

export type RangeUnit = "ms" | "s" | "count" | "usd"

export const UNIT_WORDS = {
	ms: "milliseconds",
	s: "seconds",
	count: "count",
	usd: "US dollars",
} satisfies Record<RangeUnit, string>
export const UNIT_SUFFIX = { ms: "ms", s: "s", count: "", usd: "$" } satisfies Record<RangeUnit, string>

const UNIT_MS = new Map([
	["ms", 1],
	["s", 1000],
	["m", 60_000],
	["h", 3_600_000],
])

const COUNT_MULTIPLIERS = new Map([
	["k", 1_000],
	["m", 1_000_000],
	["b", 1_000_000_000],
])

/** A bare number in the control's unit, a suffixed duration, a scaled count or a dollar amount. */
export const parseRange = (text: string, unit: RangeUnit): number | undefined => {
	const trimmed = text
		.trim()
		.toLowerCase()
		.replace(/^\$\s*/, unit === "usd" ? "" : "$")
	if (trimmed === "") return undefined
	if (/^\d+(\.\d+)?$/.test(trimmed)) {
		const bare = Number(trimmed)
		if (!Number.isFinite(bare) || bare < 0) return undefined
		return unit === "count" ? Math.round(bare) : bare
	}
	if (unit === "usd") return undefined
	if (unit === "count") {
		const scaled = /^(\d+(?:\.\d+)?)\s*([kmb])$/.exec(trimmed)
		if (scaled === null) return undefined
		return Math.round(Number(scaled[1]) * (COUNT_MULTIPLIERS.get(scaled[2] ?? "") ?? 1))
	}
	if (!/^(\d+(\.\d+)?\s*(ms|s|m|h)\s*)+$/.test(trimmed)) return undefined
	const totalMs = [...trimmed.matchAll(/(\d+(?:\.\d+)?)\s*(ms|s|m|h)/g)].reduce(
		(sum, [, amount, suffix]) => sum + Number(amount) * (UNIT_MS.get(suffix ?? "") ?? 0),
		0,
	)
	return unit === "ms" ? totalMs : totalMs / 1000
}

/** "120k", "1.5M", "2B", and the bare number under a thousand. */
export const formatCount = (value: number): string => {
	const scaled = (divisor: number, suffix: string) => {
		const n = value / divisor
		return `${Number.isInteger(n) ? n : n.toFixed(1)}${suffix}`
	}
	if (value >= 1_000_000_000) return scaled(1_000_000_000, "B")
	if (value >= 1_000_000) return scaled(1_000_000, "M")
	if (value >= 1_000) return scaled(1_000, "k")
	return String(value)
}

/** "$0.50"; sub-cent amounts keep the digits that make them non-zero. */
export const formatUsd = (value: number): string =>
	value > 0 && value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`

export const formatSeconds = (seconds: number): string => {
	if (seconds < 60) return `${Math.round(seconds * 10) / 10}s`
	if (seconds < 3600) {
		const minutes = Math.floor(seconds / 60)
		const rest = Math.round(seconds % 60)
		return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`
	}
	const hours = Math.floor(seconds / 3600)
	const restMinutes = Math.round((seconds % 3600) / 60)
	return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`
}

/** Always carries its unit: badges, ticks and readouts. */
export const formatValue = (value: number, unit: RangeUnit): string => {
	switch (unit) {
		case "ms":
			return formatDuration(value)
		case "s":
			return formatSeconds(value)
		case "count":
			return formatCount(value)
		case "usd":
			return formatUsd(value)
	}
}

/** For input fields: bare inside the unit's natural range, human once that reads the same. */
export const formatCompact = (value: number | undefined, unit: RangeUnit): string => {
	if (value === undefined) return ""
	if (unit === "usd") return String(value)
	const threshold = unit === "ms" ? 1000 : unit === "s" ? 60 : 1000
	if (value < threshold) return String(value)
	const human = formatValue(value, unit)
	return parseRange(human, unit) === value ? human : String(value)
}

export const formatRange = (min: number | undefined, max: number | undefined, unit: RangeUnit): string => {
	if (min !== undefined && max !== undefined) return `${formatValue(min, unit)} – ${formatValue(max, unit)}`
	if (min !== undefined) return `≥ ${formatValue(min, unit)}`
	return `≤ ${formatValue(max ?? 0, unit)}`
}

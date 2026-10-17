import { formatDuration } from "@maple/ui/lib/format"

// copied: the parsing and formatting half of packages/ui/src/components/filters/range-filter-section.tsx
// (the React module also holds the component). Only the duration units a ported page uses.

export type RangeUnit = "ms" | "s"

export const UNIT_WORDS = { ms: "milliseconds", s: "seconds" } satisfies Record<RangeUnit, string>
export const UNIT_SUFFIX = { ms: "ms", s: "s" } satisfies Record<RangeUnit, string>

const UNIT_MS = new Map([
	["ms", 1],
	["s", 1000],
	["m", 60_000],
	["h", 3_600_000],
])

/** A bare number in the control's unit, or a suffixed duration ("90s", "1h 30m"). Blank is unbounded. */
export const parseRange = (text: string, unit: RangeUnit): number | undefined => {
	const trimmed = text
		.trim()
		.toLowerCase()
		.replace(/^\$\s*/, "$")
	if (trimmed === "") return undefined
	if (/^\d+(\.\d+)?$/.test(trimmed)) {
		const bare = Number(trimmed)
		return !Number.isFinite(bare) || bare < 0 ? undefined : bare
	}
	if (!/^(\d+(\.\d+)?\s*(ms|s|m|h)\s*)+$/.test(trimmed)) return undefined
	const totalMs = [...trimmed.matchAll(/(\d+(?:\.\d+)?)\s*(ms|s|m|h)/g)].reduce(
		(sum, [, amount, suffix]) => sum + Number(amount) * (UNIT_MS.get(suffix ?? "") ?? 0),
		0,
	)
	return unit === "ms" ? totalMs : totalMs / 1000
}

const formatSeconds = (seconds: number): string => {
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

export const formatValue = (value: number, unit: RangeUnit): string =>
	unit === "ms" ? formatDuration(value) : formatSeconds(value)

/** For input fields: bare inside the unit's natural range, human once that reads the same. */
export const formatCompact = (value: number | undefined, unit: RangeUnit): string => {
	if (value === undefined) return ""
	const threshold = unit === "ms" ? 1000 : 60
	if (value < threshold) return String(value)
	const human = formatValue(value, unit)
	return parseRange(human, unit) === value ? human : String(value)
}

export const formatRange = (min: number | undefined, max: number | undefined, unit: RangeUnit): string => {
	if (min !== undefined && max !== undefined) return `${formatValue(min, unit)} – ${formatValue(max, unit)}`
	if (min !== undefined) return `≥ ${formatValue(min, unit)}`
	return `≤ ${formatValue(max ?? 0, unit)}`
}

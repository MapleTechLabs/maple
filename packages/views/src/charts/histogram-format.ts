import { formatNumber, formatValueByUnit } from "@maple/ui/lib/format"

// Copied from packages/ui/src/components/charts/histogram/query-builder-histogram-chart.tsx (a React
// module). Shared by the definition (tick labels) and the view (tooltip heading).

/** Index of the dash separating a bin label's two bounds, or -1 ("-50--20" -> 3). */
const splitBoundsAt = (name: string): number => {
	for (let index = 1; index < name.length; index += 1) {
		if (name[index] !== "-") continue
		const previous = name[index - 1]
		if (previous === "-" || previous === "e" || previous === "E") continue
		return index
	}
	return -1
}

/** The lower bound of a bin label, for an axis tick that has room for one number. */
export const binLowerBoundLabel = (name: string): string => {
	const separator = splitBoundsAt(name)
	return separator === -1 ? name : name.slice(0, separator)
}

export const formatBound = (value: number, unit: string | null): string =>
	unit?.startsWith("duration_") ? formatValueByUnit(value, unit) : formatNumber(value)

/** `formatInterval` of the histogram spike. */
export const formatInterval = (from: number, to: number): string =>
	`${formatNumber(from)} – ${formatNumber(to)}`

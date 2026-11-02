// OTel metric units are UCUM codes (`By`, `s`, `1`, `{request}`); the chart formatter
// (`formatValueByUnit` in @maple/ui/lib/format) has its own unit vocabulary.

/** A dimensionless `1` is a ratio when the metric name says so (`system.cpu.utilization`). */
export const isRatioMetricName = (metricName: string): boolean =>
	/utiliz|ratio|percent|usage$/i.test(metricName)

// docker_stats reports these with unit `1` but as 0..100 (packages/query-engine/src/ch/queries/containers.ts).
const PERCENT_100_METRICS = new Set(["container.cpu.utilization", "container.memory.percent"])

const DIRECT = new Map([
	["ns", "duration_ns"],
	["us", "duration_us"],
	["ms", "duration_ms"],
	["s", "duration_s"],
	["By", "bytes"],
	["by", "bytes"],
	["bytes", "bytes"],
	["%", "percent_100"],
])

/**
 * The chart formatter's unit for an OTel unit, or `undefined` for a plain number.
 * Scaled byte units (`KiBy`, `MiBy`) and `By/s` stay plain: the formatter has no unit that
 * reads their values right. A dimensionless count per second (`1/s`, `{request}/s`) is a rate.
 */
export const chartUnitFromOtel = (unit: string, metricName = ""): string | undefined => {
	const trimmed = unit.trim()
	if (trimmed === "1")
		return PERCENT_100_METRICS.has(metricName)
			? "percent_100"
			: isRatioMetricName(metricName)
				? "percent"
				: undefined
	if (/^(1|\{[^}]+\})\/s$/.test(trimmed)) return "requests_per_sec"
	return DIRECT.get(trimmed)
}

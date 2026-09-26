// OTel metric units are UCUM codes (`By`, `s`, `1`, `{request}`). These map
// them to words a reader recognizes and to the shared chart formatter's units.

import { Schema } from "effect"

export const MetricTypeSchema = Schema.Literals(["sum", "gauge", "histogram", "exponential_histogram"])
export type MetricType = Schema.Schema.Type<typeof MetricTypeSchema>
export const isMetricType = Schema.is(MetricTypeSchema)

const UNIT_WORDS: Record<string, string> = {
	By: "bytes",
	KBy: "kilobytes",
	MBy: "megabytes",
	GBy: "gigabytes",
	KiBy: "KiB",
	MiBy: "MiB",
	GiBy: "GiB",
	"By/s": "bytes/s",
	bit: "bits",
	"bit/s": "bits/s",
	s: "seconds",
	ms: "ms",
	us: "µs",
	ns: "ns",
	min: "minutes",
	h: "hours",
	Cel: "°C",
	Hz: "Hz",
	"%": "%",
}

/** A dimensionless `1` is a ratio: a percentage when the name says so, otherwise a plain count. */
function isRatioName(metricName: string): boolean {
	return /utiliz|ratio|percent|usage$/i.test(metricName)
}

/**
 * Human label for a UCUM unit, or `""` when there is nothing worth showing.
 * Annotations lose their braces (`{request}` reads as `requests`).
 */
export function humanizeUnit(unit: string, metricName = ""): string {
	const trimmed = unit.trim()
	if (trimmed === "" || trimmed === "1") return trimmed === "1" && isRatioName(metricName) ? "%" : ""
	const known = UNIT_WORDS[trimmed]
	if (known) return known
	const annotation = trimmed.match(/^\{(.+)\}$/)
	if (annotation) return annotation[1].endsWith("s") ? annotation[1] : `${annotation[1]}s`
	return trimmed.replace(/[{}]/g, "")
}

/** The shared chart formatter's unit for an OTel unit, when one fits. */
export function chartUnitFromOtel(unit: string, metricName = ""): string | undefined {
	switch (unit.trim()) {
		case "ns":
			return "duration_ns"
		case "us":
			return "duration_us"
		case "ms":
			return "duration_ms"
		case "s":
			return "duration_s"
		case "By":
			return "bytes"
		case "%":
			return "percent_100"
		case "1":
			return isRatioName(metricName) ? "percent" : undefined
		default:
			return undefined
	}
}

/** Monotonic sums are counters: a reader wants their rate, never their running total. */
export function isCounter(entry: { metricType: string; isMonotonic: boolean }): boolean {
	return entry.metricType === "sum" && entry.isMonotonic
}

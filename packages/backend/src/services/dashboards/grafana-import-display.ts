// Grafana field config (unit, thresholds, min/max, legend) to Maple widget display. Pure.
import { Array as Arr, String as Str } from "effect"
import { asArray, asFiniteNumber, asRecord, asString, type UnknownRecord } from "./dashboard-import-shared"

/** The Maple chart a Grafana panel lands on; `line` and `bar` are both `visualization: "chart"`. */
export type GrafanaTarget = "line" | "bar" | "stat" | "gauge" | "table" | "pie" | "heatmap" | "histogram"

const UNITS: ReadonlyMap<string, { readonly unit: string; readonly suffix?: string }> = new Map([
	["s", { unit: "duration_s" }],
	["ms", { unit: "duration_ms" }],
	["µs", { unit: "duration_us" }],
	["us", { unit: "duration_us" }],
	["ns", { unit: "duration_ns" }],
	["bytes", { unit: "bytes" }],
	["decbytes", { unit: "bytes" }],
	// Grafana's `percent` is already 0 to 100; its `percentunit` is the 0 to 1 fraction.
	["percent", { unit: "percent_100" }],
	["percentunit", { unit: "percent" }],
	["reqps", { unit: "requests_per_sec" }],
	["ops", { unit: "short", suffix: " ops/s" }],
	["short", { unit: "short" }],
	["none", { unit: "none" }],
])

// Grafana's named palette, base shades. `dark-`, `light-` and similar prefixes map to the base.
const NAMED_COLORS: ReadonlyMap<string, string> = new Map([
	["green", "#73BF69"],
	["red", "#F2495C"],
	["yellow", "#FADE2A"],
	["orange", "#FF9830"],
	["blue", "#5794F2"],
	["purple", "#B877D9"],
	["text", "#CCCCDC"],
])

function grafanaColor(color: string): string {
	const base = Str.replace(/^(super-light|semi-dark|light|dark)-/u, "")(color)
	return NAMED_COLORS.get(base) ?? color
}

function fieldDefaults(panel: UnknownRecord): UnknownRecord | null {
	return asRecord(asRecord(panel.fieldConfig)?.defaults)
}

/** The display unit (and suffix, for units Maple spells differently), or a warning. */
function unitDisplay(panel: UnknownRecord, title: string, warnings: string[]): UnknownRecord {
	// Field config first; the old graph and singlestat panels kept it on `yaxes[0].format` / `format`.
	const unit =
		asString(fieldDefaults(panel)?.unit) ??
		asString(asRecord(asArray(panel.yaxes)[0])?.format) ??
		asString(panel.format)
	if (unit === undefined) return {}
	const known = UNITS.get(unit)
	if (known === undefined) {
		warnings.push(
			`Panel "${title}" uses the Grafana unit "${unit}", which Maple has no match for; it shows plain numbers.`,
		)
		return {}
	}
	return { unit: known.unit, ...(known.suffix === undefined ? undefined : { suffix: known.suffix }) }
}

/** Absolute threshold steps; the base step (value null) is the default colour, so it is dropped. */
function thresholds(panel: UnknownRecord, title: string, warnings: string[]) {
	const config = asRecord(fieldDefaults(panel)?.thresholds)
	if (config === null) return undefined
	if (config.mode === "percentage") {
		warnings.push(
			`Panel "${title}" has percentage thresholds, which Maple does not support; they were dropped.`,
		)
		return undefined
	}
	const steps = Arr.flatMap(asArray(config.steps), (step) => {
		const record = asRecord(step)
		const value = asFiniteNumber(record?.value)
		const color = asString(record?.color)
		return value === undefined || color === undefined ? [] : [{ value, color: grafanaColor(color) }]
	})
	return steps.length > 0 ? steps : undefined
}

/** `line` or `bar`, and whether series stack, from the timeseries or old graph panel options. */
export function chartStyle(panel: UnknownRecord): {
	readonly target: "line" | "bar"
	readonly stacked: boolean
	/** Grafana normalized the stack to 100%, which Maple does not draw. */
	readonly percent: boolean
} {
	if (panel.type === "graph") {
		return {
			target: panel.bars === true && panel.lines !== true ? "bar" : "line",
			stacked: panel.stack === true,
			percent: panel.stack === true && panel.percentage === true,
		}
	}
	const custom = asRecord(fieldDefaults(panel)?.custom)
	const stacking = asString(asRecord(custom?.stacking)?.mode)
	return {
		target: custom?.drawStyle === "bars" ? "bar" : "line",
		stacked: stacking === "normal" || stacking === "percent",
		percent: stacking === "percent",
	}
}

function legend(panel: UnknownRecord): "visible" | "hidden" | "right" {
	const options = asRecord(asRecord(panel.options)?.legend) ?? asRecord(panel.legend)
	if (options?.showLegend === false || options?.show === false || options?.displayMode === "hidden")
		return "hidden"
	return options?.placement === "right" || options?.rightSide === true ? "right" : "visible"
}

/** The widget's `display`: title, unit, thresholds and the chart options the target draws. */
export function grafanaDisplay(args: {
	panel: UnknownRecord
	target: GrafanaTarget
	title: string
	description: string | undefined
	warnings: string[]
}): UnknownRecord {
	const { panel, target, title, warnings } = args
	const defaults = fieldDefaults(panel)
	const min = asFiniteNumber(defaults?.min)
	const max = asFiniteNumber(defaults?.max)
	const steps = target === "table" || target === "pie" ? undefined : thresholds(panel, title, warnings)
	const base: UnknownRecord = {
		title,
		...(args.description === undefined ? undefined : { description: args.description }),
		...unitDisplay(panel, title, warnings),
		...(steps === undefined ? undefined : { thresholds: steps }),
	}
	switch (target) {
		case "line":
		case "bar": {
			const { stacked, percent } = chartStyle(panel)
			if (percent) {
				warnings.push(
					`Panel "${title}" stacked its series as percentages of the total; Maple stacks the raw values.`,
				)
			}
			const custom = asRecord(defaults?.custom)
			return {
				...base,
				chartId: target === "bar" ? "query-builder-bar" : "query-builder-line",
				chartPresentation: { legend: legend(panel), seriesStats: target === "line" && !stacked },
				stacked,
				curveType: custom?.lineInterpolation === "smooth" ? "monotone" : "linear",
				...(min === undefined && max === undefined
					? undefined
					: {
							yAxis: {
								...(min === undefined ? undefined : { min }),
								...(max === undefined ? undefined : { max }),
							},
						}),
			}
		}
		case "gauge":
			return {
				...base,
				gauge: {
					...(min === undefined ? undefined : { min }),
					...(max === undefined ? undefined : { max }),
					...(panel.type === "bargauge" ? { style: "bar" } : undefined),
				},
			}
		case "pie":
			return { ...base, chartId: "query-builder-pie" }
		case "heatmap":
			return { ...base, chartId: "query-builder-heatmap" }
		case "histogram":
			return { ...base, chartId: "query-builder-histogram" }
		case "stat":
		case "table":
			return base
	}
}

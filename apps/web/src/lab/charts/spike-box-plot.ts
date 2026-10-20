import { formatLatency, formatNumber } from "@maple/ui/lib/format"
import { type BoxDatum, boxY, type ChartPoint, type ChartValue, defineChart } from "@tanstack/charts"
import { scaleBand } from "@tanstack/charts-scales/band"
import { scaleLog } from "d3-scale"
import { Option } from "effect"
import { ChartTooltip } from "../../charts/chart-spec"
import type { BuiltChart } from "../../charts/definitions/built-chart"
import { cursorTooltip } from "../../charts/definitions/plot-constants"
import type { SpikeSpec } from "./spike-spec"

// `BoxPlotSpike`, definition half: Tukey boxes over a
// seeded log-normal sample per operation, on a log y scale. Code copied, constants unchanged.

interface BoxPlotRow {
	readonly operation: string
	readonly durationMs: number
}

type Datum = BoxDatum<BoxPlotRow, ChartValue>

const OPERATIONS: ReadonlyArray<{ name: string; medianMs: number; sigma: number }> = [
	{ name: "GET /api/traces", medianMs: 8, sigma: 0.45 },
	{ name: "GET /api/spans", medianMs: 21, sigma: 0.6 },
	{ name: "POST /v1/traces", medianMs: 5.5, sigma: 0.35 },
	{ name: "GET /api/services", medianMs: 46, sigma: 0.5 },
	{ name: "POST /api/query", medianMs: 190, sigma: 0.75 },
	{ name: "GET /api/dashboards", medianMs: 62, sigma: 0.55 },
	{ name: "pg.select alert_rules", medianMs: 2.4, sigma: 0.4 },
	{ name: "clickhouse.spans_scan", medianMs: 540, sigma: 0.85 },
]

const SAMPLES_PER_OPERATION = 120

/** `makeRandom`: an LCG, the same sequence for the same seed. */
const nextState = (state: number): number => (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0

/** `makeRows`: two uniforms per sample through Box-Muller, in operation order. */
const makeRows = (): ReadonlyArray<BoxPlotRow> =>
	OPERATIONS.flatMap((operation) => Array.from({ length: SAMPLES_PER_OPERATION }, () => operation)).reduce<{
		state: number
		rows: ReadonlyArray<BoxPlotRow>
	}>(
		(acc, operation) => {
			const s1 = nextState(acc.state)
			const s2 = nextState(s1)
			const u1 = Math.max(1e-9, s1 / 0x1_0000_0000)
			const u2 = s2 / 0x1_0000_0000
			const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
			const durationMs = Math.max(
				0.2,
				Math.round(operation.medianMs * Math.exp(operation.sigma * normal) * 10) / 10,
			)
			return { state: s2, rows: [...acc.rows, { operation: operation.name, durationMs }] }
		},
		{ state: 0xb0c5_1234 >>> 0, rows: [] },
	).rows

/** The box or outlier under the pointer: its summary rows, the median emphasised. */
const tooltipOf = (
	points: ReadonlyArray<ChartPoint<Datum, ChartValue, number>>,
): Option.Option<ChartTooltip> =>
	Option.map(Option.fromNullishOr(points[0]?.datum), (datum) => {
		const row = (label: string, value: string) => ({ label, color: "", dashed: false, value })
		return ChartTooltip.Bucket({
			heading: String(datum.category),
			...(datum.kind === "outlier" ? undefined : { highlighted: "Median" }),
			rows:
				datum.kind === "outlier"
					? [row("Outlier", formatLatency(datum.value))]
					: [
							row("Max (whisker)", formatLatency(datum.whiskerHigh)),
							row("Q3", formatLatency(datum.q3)),
							row("Median", formatLatency(datum.median)),
							row("Q1", formatLatency(datum.q1)),
							row("Min (whisker)", formatLatency(datum.whiskerLow)),
							row("Samples", formatNumber(datum.count)),
						],
		})
	})

export const buildBoxPlotSpike = (spec: SpikeSpec): BuiltChart<Datum, ChartValue, number> => {
	const rows = makeRows()
	const color = spec.colors["--chart-1"] ?? ""
	const durations = rows.map((row) => row.durationMs)
	const definition = defineChart({
		marks: [
			boxY(rows, {
				x: (row: BoxPlotRow) => row.operation,
				y: (row: BoxPlotRow) => row.durationMs,
				fill: color,
				fillOpacity: 0.35,
				stroke: color,
				strokeWidth: 1.5,
				inset: 2,
				r: 2.5,
			}),
		],
		scales: {
			x: {
				scale: scaleBand<string>(
					OPERATIONS.map((operation) => operation.name),
					[0, 1],
				).paddingInner(0.55),
				axis: {
					line: false,
					ticks: { size: 0, padding: 8 },
					tickLabels: { rotate: -30, anchor: "end", fontSize: 10 },
				},
			},
			y: {
				scale: scaleLog().domain([Math.min(...durations) * 0.85, Math.max(0, ...durations) * 1.2]),
				grid: true,
				axis: { line: false, ticks: { size: 0, padding: 6, format: formatLatency } },
			},
		},
		focus: "nearest",
		focusRing: false,
		tooltip: cursorTooltip("pointer"),
	})
	return { definition, focusKeyOf: (point) => String(point.datum.category), tooltipOf }
}

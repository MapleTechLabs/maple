import { createSequentialColorScale } from "@maple/ui/components/plot/color-scale"
import { formatDuration, formatNumber } from "@maple/ui/lib/format"
import { type ChartPoint, type ChartValue, defineChart } from "@tanstack/charts"
import { colorGradientLegend } from "@tanstack/charts/legend"
import { type HexbinDatum, hexbin } from "@tanstack/charts/spatial/hexbin"
import { tooltip } from "@tanstack/charts/tooltip"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { scaleLog } from "d3-scale"
import { Option } from "effect"
import { ChartTooltip } from "../../charts/chart-spec"
import type { BuiltChart } from "../../charts/definitions/built-chart"
import type { SpikeSpec } from "./spike-spec"
import { RAMP_TOKENS } from "./spike-timeseries-tokens"

// `TraceScatterSpike`, definition half: 5,000
// seeded spans hex-binned by screen-space density. Code copied, constants unchanged.

interface ScatterRow {
	readonly startMs: number
	readonly durationMs: number
}

const SPAN_COUNT = 5_000
const WINDOW_MS = 30 * 60 * 1000
const WINDOW_END_MS = Date.UTC(2026, 7, 17, 14, 0)
const WINDOW_START_MS = WINDOW_END_MS - WINDOW_MS
const DURATION_DOMAIN: readonly [number, number] = [0.4, 10_000]
const DENSITY_DOMAIN: readonly [number, number] = [1, 90]
const BIN_WIDTH_PX = 13
const EDGE_PAD_FRACTION = 0.016

const OUTPUTS = {
	count: { reduce: "count" },
	slowestMs: { value: (row: ScatterRow) => row.durationMs, reduce: "max" },
} as const
type Bin = HexbinDatum<ScatterRow, typeof OUTPUTS>

const nextState = (state: number): number => (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0

/** `makeSpans`: four uniforms per span (jitter, two Box-Muller, the mode roll), in order. */
const makeSpans = (): ReadonlyArray<ScatterRow> => {
	const burstStart = WINDOW_START_MS + WINDOW_MS * 0.62
	const burstEnd = burstStart + 3 * 60 * 1000
	return Array.from({ length: SPAN_COUNT }, (_, index) => index).reduce<{
		state: number
		rows: Array<ScatterRow>
	}>(
		(acc, index) => {
			const s1 = nextState(acc.state)
			const s2 = nextState(s1)
			const s3 = nextState(s2)
			const s4 = nextState(s3)
			const uniform = (state: number) => state / 0x1_0000_0000
			const phase = (index / SPAN_COUNT) * Math.PI * 4
			const jitter = (uniform(s1) - 0.5) * 0.04
			const position = Math.min(
				0.9999,
				Math.max(0, index / SPAN_COUNT + 0.03 * Math.sin(phase) + jitter),
			)
			const startMs = WINDOW_START_MS + position * WINDOW_MS
			const u1 = Math.max(1e-9, uniform(s2))
			const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * uniform(s3))
			const roll = uniform(s4)
			const durationMs =
				startMs >= burstStart && startMs <= burstEnd && roll < 0.28
					? 900 * Math.exp(0.45 * normal)
					: roll < 0.05
						? 320 * Math.exp(0.7 * normal)
						: roll < 0.22
							? 70 * Math.exp(0.5 * normal)
							: 12 * Math.exp(0.55 * normal)
			acc.rows.push({ startMs, durationMs: Math.min(9_500, Math.max(0.4, durationMs)) })
			return { state: s4, rows: acc.rows }
		},
		{ state: 0x5eed_1234 >>> 0, rows: [] },
	).rows
}

const padTimeDomain = (min: number, max: number): readonly [number, number] => {
	const pad = (max - min) * EDGE_PAD_FRACTION
	return [min - pad, max + pad]
}

const timeDomainOf = (rows: ReadonlyArray<ScatterRow>): readonly [number, number] => {
	const starts = rows.map((row) => row.startMs).filter((value) => Number.isFinite(value))
	const min = Math.min(...starts)
	const max = Math.max(...starts)
	return !Number.isFinite(min) || !Number.isFinite(max) || min === max
		? padTimeDomain(WINDOW_START_MS, WINDOW_END_MS)
		: padTimeDomain(min, max)
}

const clockOf = (ms: number, withSeconds: boolean): string =>
	new Date(ms).toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		...(withSeconds ? { second: "2-digit" } : undefined),
	})

export const buildTraceScatterSpike = (spec: SpikeSpec) => {
	const rows = makeSpans()
	const colorScale = createSequentialColorScale({
		stops: RAMP_TOKENS.blues.map(([token]) => spec.colors[token] ?? ""),
		domain: DENSITY_DOMAIN,
		scaleType: "log",
	})
	const timeDomain = timeDomainOf(rows)
	const marks = [
		hexbin(rows, {
			x: (row: ScatterRow) => row.startMs,
			y: (row: ScatterRow) => row.durationMs,
			binWidth: BIN_WIDTH_PX,
			outputs: OUTPUTS,
			color: (bin) => bin.count,
			strokeWidth: 0,
		}),
	] as const
	const definition = defineChart({
		clip: true,
		marks,
		scales: {
			x: {
				scale: scaleLinear([timeDomain[0], timeDomain[1]], [0, 1]),
				grid: false,
				axis: { ticks: { count: 6, format: (value: number) => clockOf(value, false) } },
			},
			y: {
				scale: scaleLog().domain([...DURATION_DOMAIN]),
				grid: true,
				axis: { line: false, ticks: { padding: 10, format: formatDuration } },
			},
		},
		color: {
			scale: colorScale,
			legend: colorGradientLegend({
				label: "Spans per bin",
				placement: "bottom",
				format: (value) => formatNumber(Math.round(value)),
			}),
		},
		focus: "nearest",
		focusRing: true,
		tooltip: { use: tooltip, className: "maple-plot-tooltip" },
	})
	const built: BuiltChart<Bin, ChartValue, ChartValue> = {
		definition,
		focusKeyOf: (point) => `${point.datum.x}:${point.datum.y}`,
		// Packed for the lab's body: the clock, then the count with its swatch and the reading.
		tooltipOf: (points: ReadonlyArray<ChartPoint<Bin, ChartValue, ChartValue>>) =>
			Option.map(Option.fromNullishOr(points[0]?.datum), (bin) =>
				ChartTooltip.Bucket({
					heading: clockOf(bin.x, true),
					rows: [
						{
							label: `${formatNumber(bin.count)} spans`,
							color: colorScale(bin.count),
							dashed: false,
							value: `~${formatDuration(bin.y)} · slowest ${formatDuration(bin.slowestMs)}`,
						},
					],
				}),
			),
	}
	return built
}

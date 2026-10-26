import { focusCrosshair } from "@maple/ui/components/plot/plot-focus"
import { DASHED_Y_GRID } from "@maple/ui/components/plot/plot-grid"
import { bucketTimeScale } from "@maple/ui/components/plot/plot-scales"
import { formatBucketLabel } from "@maple/ui/lib/format"
import { formatSignalValue } from "@maple/web-data/alerts/form-utils"
import { GHOST_KEY, SINGLE_KEY } from "@maple/web-data/alerts/chart-series"
import { areaY, d3Curve, defineChart, lineY, rect, ruleY, type ChartValue } from "@tanstack/charts"
import { decorative } from "@tanstack/charts/mark/decorative"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { curveMonotoneX } from "d3-shape"
import { Option, Schema } from "effect"
import { AlertSignalType } from "@maple/domain/http"
import { ChartTooltip, type ChartSpec } from "../chart-spec"
import type { BuiltChart } from "./built-chart"
import { roundCapDasharray } from "./fixed-metric-axes"
import { cursorTooltip } from "./plot-constants"

// The alert rule chart's definition. The view half is `page/alerts/shared/rule-chart.ts`.

type AlertRuleSpec = Extract<ChartSpec, { readonly _tag: "AlertRule" }>
type SignalPoint = Record<string, unknown> & { t: number; at: Date }
type Band = Readonly<{ x1: number; x2: number }>

const PLOT_RIGHT = 12
const Y_AXIS_WIDTH = 72
const isSignalType = Schema.is(AlertSignalType)

const num = (value: unknown): number => {
	const parsed = typeof value === "number" ? value : Number(value)
	return Number.isFinite(parsed) ? parsed : 0
}
const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value)

export const buildAlertRule = (spec: AlertRuleSpec): BuiltChart<SignalPoint, ChartValue, number> => {
	const signalType: AlertSignalType = isSignalType(spec.signalType) ? spec.signalType : "builder_query"
	const color = (key: string) => spec.colors[key] ?? spec.colors.border ?? ""
	const palette = {
		signal: color("signal"),
		destructive: color("destructive"),
		warn: color("warn"),
		muted: color("muted"),
	}
	const chrome = { border: color("border"), background: color("background") }
	const yDomain: [number, number] = [0, spec.yMax]
	const breachAbove = spec.comparator === "gt" || spec.comparator === "gte"
	const breachBelow = spec.comparator === "lt" || spec.comparator === "lte"
	const splitOffset = clamp01((yDomain[1] - spec.threshold) / (yDomain[1] - yDomain[0] || 1))
	const axisContext = {
		rangeMs: spec.domainMax - spec.domainMin,
		bucketSeconds: spec.bucketSeconds ?? undefined,
		timeZone: spec.timeZone,
	}
	const formatTime = (value: number, mode: "tick" | "tooltip") =>
		formatBucketLabel(new Date(value).toISOString(), axisContext, mode)
	const points: Array<SignalPoint> = spec.rows.map((row) => ({
		...row,
		t: num(row.t),
		at: new Date(num(row.t)),
	}))
	const at = (point: SignalPoint) => point.at
	const valueOf = (key: string) => (point: SignalPoint) => {
		const value = point[key]
		return typeof value === "number" ? value : null
	}
	const curve = d3Curve(curveMonotoneX)
	const gradientId = spec.gradientId

	const signalGradient = {
		id: gradientId,
		x1: 0,
		y1: 0,
		x2: 0,
		y2: 1,
		stops: breachAbove
			? [
					{ offset: 0, color: palette.destructive, opacity: 0.32 },
					{ offset: splitOffset, color: palette.destructive, opacity: 0.08 },
					{ offset: splitOffset, color: palette.signal, opacity: 0.12 },
					{ offset: 1, color: palette.signal, opacity: 0.02 },
				]
			: breachBelow
				? [
						{ offset: 0, color: palette.signal, opacity: 0.12 },
						{ offset: splitOffset, color: palette.signal, opacity: 0.05 },
						{ offset: splitOffset, color: palette.destructive, opacity: 0.08 },
						{ offset: 1, color: palette.destructive, opacity: 0.3 },
					]
				: [
						{ offset: 0.05, color: palette.signal, opacity: 0.45 },
						{ offset: 0.95, color: palette.signal, opacity: 0.04 },
					],
	}

	const band = (bands: ReadonlyArray<Band>, fill: string, fillOpacity: number, id: string) =>
		bands.length === 0
			? []
			: [
					decorative(
						rect(bands, {
							id,
							x1: (b: Band) => new Date(b.x1),
							x2: (b: Band) => new Date(b.x2),
							y1: () => yDomain[0],
							y2: () => yDomain[1],
							fill,
							fillOpacity,
							stroke: "none",
						}),
					),
				]

	const definition = defineChart({
		gradients: [signalGradient],
		marks: [
			...band(spec.bands.noData, palette.muted, 0.1, "no-data"),
			...band(spec.bands.incidentOpen, palette.destructive, 0.12, "incident-open"),
			...band(spec.bands.incidentClosed, palette.destructive, 0.06, "incident-closed"),
			...band(spec.bands.held, palette.muted, 0.16, "incident-held"),
			...band(spec.bands.wouldFire, palette.destructive, 0.08, "would-fire"),
			ruleY(
				spec.thresholdUpper != null
					? [{ value: spec.threshold }, { value: spec.thresholdUpper }]
					: [{ value: spec.threshold }],
				{
					y: (entry: { value: number }) => entry.value,
					stroke: spec.criticalThreshold != null ? palette.warn : palette.destructive,
					strokeOpacity: 1,
					strokeWidth: 1.5,
					strokeDasharray: "6 4",
				},
			),
			...(spec.criticalThreshold != null
				? [
						ruleY([{ value: spec.criticalThreshold }], {
							y: (entry: { value: number }) => entry.value,
							stroke: palette.destructive,
							strokeOpacity: 1,
							strokeWidth: 1.5,
							strokeDasharray: "6 4",
						}),
					]
				: []),
			...(spec.hasGhost
				? [
						lineY(points, {
							id: GHOST_KEY,
							x: at,
							y: valueOf(GHOST_KEY),
							stroke: palette.muted,
							strokeWidth: 1.5,
							strokeDasharray: roundCapDasharray(5, 3, 1.5),
							curve,
						}),
					]
				: []),
			...(spec.isMultiSeries
				? spec.seriesKeys.map((key) =>
						lineY(points, {
							id: key,
							x: at,
							y: valueOf(key),
							stroke: color(key),
							strokeWidth: 1.5,
							curve,
						}),
					)
				: [
						areaY(points, {
							id: `${SINGLE_KEY}-band`,
							x: at,
							y: valueOf(SINGLE_KEY),
							y1: () => yDomain[0],
							fill: `url(#${gradientId})`,
							stroke: "none",
							curve,
						}),
						lineY(points, {
							id: SINGLE_KEY,
							x: at,
							y: valueOf(SINGLE_KEY),
							stroke: palette.signal,
							strokeWidth: 2,
							curve,
						}),
					]),
			focusCrosshair(chrome),
		],
		scales: {
			x: {
				scale: bucketTimeScale([new Date(spec.domainMin), new Date(spec.domainMax)], spec.timeZone),
				axis: {
					line: false,
					ticks: {
						size: 0,
						padding: 8,
						format: (value: Date) => formatTime(value.getTime(), "tick"),
					},
					tickLabels: { thin: { minGap: 12 } },
				},
			},
			y: {
				grid: DASHED_Y_GRID,
				scale: scaleLinear().domain(yDomain),
				axis: {
					line: false,
					ticks: {
						size: 0,
						padding: 8,
						format: (value: number) => (value === 0 ? "0" : formatSignalValue(signalType, value)),
					},
				},
			},
		},
		margin: { top: 8, right: PLOT_RIGHT, left: Y_AXIS_WIDTH },
		focus: "group-x",
		focusRing: false,
		tooltip: cursorTooltip<SignalPoint>("pointer"),
	})

	const metaByT = new Map(spec.meta.map((entry) => [entry.t, entry]))
	const tooltipKeys = [
		...(spec.isMultiSeries ? spec.seriesKeys : [SINGLE_KEY]),
		...(spec.hasGhost ? [GHOST_KEY] : []),
	]
	const tooltipOf = (
		focused: ReadonlyArray<{ readonly datum: SignalPoint }>,
	): Option.Option<ChartTooltip> =>
		Option.map(Option.fromNullishOr(focused[0]), ({ datum }) => {
			const t = num(datum.t)
			const meta = metaByT.get(t)
			const extras = [
				meta != null ? `${meta.sampleCount} samples` : null,
				meta?.status === "skipped" ? "skipped" : null,
				meta?.provisional === true ? "in progress" : null,
			].filter((part) => part !== null)
			const label = formatTime(t, "tooltip")
			return ChartTooltip.Bucket({
				heading: extras.length > 0 ? `${label} · ${extras.join(" · ")}` : label,
				rows: tooltipKeys.flatMap((key) => {
					const value = datum[key]
					return typeof value !== "number"
						? []
						: [
								{
									label: spec.labels[key] ?? key,
									color:
										key === GHOST_KEY
											? palette.muted
											: spec.isMultiSeries
												? color(key)
												: palette.signal,
									dashed: key === GHOST_KEY,
									value: formatSignalValue(signalType, value),
								},
							]
				}),
			})
		})

	return { definition, focusKeyOf: (point) => String(num(point.datum.t)), tooltipOf }
}

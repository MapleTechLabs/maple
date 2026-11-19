// query_promql's model-facing text: per series its labels, summary stats and a few points.
import { Array as Arr, Option, Order, pipe, Record as Rec, String as Str } from "effect"
import type { PromqlSampleValue, PromqlSeries, QueryPromqlOutput } from "@maple/domain/mcp-outputs"
import { formatNumber, tableCell, truncate } from "./format"
import { doc, type DocBlock, type NextCall, type ToolDoc } from "./tool-doc"
import { MAX_POINTS } from "./promql-result"

type Output = typeof QueryPromqlOutput.Type
type Series = typeof PromqlSeries.Type

/** Series that also list sampled points, and how many points each. */
const DETAILED_SERIES = 5
const SAMPLED_POINTS = 6

export const formatSample = (value: typeof PromqlSampleValue.Type): string => {
	if (typeof value === "string") return value
	if (Number.isInteger(value)) return formatNumber(value)
	const abs = Math.abs(value)
	return abs >= 1000 ? formatNumber(Math.round(value * 100) / 100) : String(Number(value.toPrecision(4)))
}

/** `MM-DD HH:MM:SS`, UTC, with milliseconds when a step is finer than a second. */
const formatTime = (ms: number): string =>
	Str.replace("T", " ")(Str.slice(5, ms % 1000 === 0 ? 19 : 23)(new Date(ms).toISOString()))

/** A label value as Prometheus quotes it: backslash, double quote and newline escaped. */
const escapeLabelValue = (value: string): string =>
	pipe(value, Str.replace(/[\\"]/g, "\\$&"), Str.replace(/\n/g, "\\n"))

/** `name{k="v", ...}`, the way Prometheus prints a series. */
export const seriesName = (labels: Series["labels"]): string => {
	const name = labels.__name__ ?? ""
	const rest = Arr.sort(
		Arr.filter(Rec.toEntries(labels), ([key]) => key !== "__name__"),
		Order.mapInput(Order.String, ([key]: readonly [string, string]) => key),
	)
	const inner = Arr.join(
		Arr.map(rest, ([key, value]) => `${key}="${escapeLabelValue(value)}"`),
		", ",
	)
	return rest.length === 0 && name !== "" ? name : `${name}{${inner}}`
}

const stats = (series: Series) =>
	series.stats === undefined
		? { min: "-", avg: "-", max: "-" }
		: {
				min: formatSample(series.stats.min),
				avg: formatSample(series.stats.avg),
				max: formatSample(series.stats.max),
			}

const lastValue = (series: Series): string =>
	Option.match(Arr.last(series.points), { onNone: () => "-", onSome: (p) => formatSample(p.v) })

/** Evenly spaced points across the series, its last point included. */
const sampled = (series: Series): string => {
	const n = series.points.length
	const stride = Math.max(1, Math.ceil(n / SAMPLED_POINTS))
	const picked = Arr.filter(series.points, (_, i) => (n - 1 - i) % stride === 0)
	return Arr.join(
		Arr.map(Arr.takeRight(picked, SAMPLED_POINTS), (p) => `${formatTime(p.t)} ${formatSample(p.v)}`),
		", ",
	)
}

const matrixBlocks = (series: ReadonlyArray<Series>): ReadonlyArray<DocBlock> => [
	doc.table(
		["Series", "Points", "Min", "Avg", "Max", "Last"],
		Arr.map(series, (s) => {
			const { min, avg, max } = stats(s)
			return [
				truncate(seriesName(s.labels), 100),
				formatNumber(s.totalPoints),
				min,
				avg,
				max,
				lastValue(s),
			]
		}),
	),
	doc.list(
		Arr.map(
			Arr.take(series, DETAILED_SERIES),
			// Table cells are escaped by the renderer; list items are not.
			(s) => `${tableCell(seriesName(s.labels), 100)}: ${sampled(s)}`,
		),
	),
]

const bodyOf = (output: Output): ReadonlyArray<DocBlock> => {
	switch (output.resultType) {
		case "matrix":
			return output.series.length === 0 ? [] : matrixBlocks(output.series)
		case "vector":
			return output.series.length === 0
				? []
				: [
						doc.table(
							["Series", "Value"],
							Arr.map(output.series, (s) => [
								truncate(seriesName(s.labels), 100),
								lastValue(s),
							]),
						),
					]
		case "scalar":
			return [
				doc.fields([
					[
						"Value",
						Option.match(Arr.head(output.series), { onNone: () => "-", onSome: lastValue }),
					],
				]),
			]
		case "string":
			return [doc.fields([["Value", output.stringValue]])]
	}
}

/** Rerun with the series summed per service; only for expressions that yield instant vectors. */
const aggregateNext = (output: Output): NextCall | undefined =>
	output.resultType === "vector" || (output.resultType === "matrix" && !output.instant)
		? doc.next(
				"query_promql",
				{
					query: `sum by (job) (${output.query})`,
					start_time: output.timeRange.start,
					end_time: output.timeRange.end,
					...(output.instant ? { instant: true } : { step: stepText(output.stepSeconds) }),
				},
				"fewer series: one per service",
			)
		: undefined

/** A step the tool's own `step` parameter accepts: whole seconds, or ms below a second. */
const stepText = (seconds: number): string =>
	Number.isInteger(seconds) ? `${seconds}s` : `${Math.round(seconds * 1000)}ms`

export const renderPromqlOutput = (output: Output): ToolDoc => {
	const empty = output.resultType !== "string" && output.series.length === 0
	const clipped = Arr.some(output.series, (s) => s.totalPoints > s.points.length)
	const aggregate = aggregateNext(output)
	return {
		title: "PromQL Result",
		scope: [
			["Query", output.query],
			["Type", output.resultType],
			output.instant
				? ["At", output.timeRange.end]
				: ["Window", `${output.timeRange.start} to ${output.timeRange.end}`],
			["Step", output.instant ? undefined : stepText(output.stepSeconds)],
		],
		blocks: bodyOf(output),
		...(empty
			? {
					empty: {
						message: "No series matched this query in the window.",
						hints: [
							"Names are Prometheus-style: `http.server.request.duration` (s) is `http_server_request_duration_seconds_bucket`/`_count`/`_sum`, a monotonic sum ends in `_total`.",
							// An instant query reads only the 5 minutes before end_time; start_time cannot help it.
							output.instant
								? "Labels use underscores (`host_name`); `job` is the service name, as `namespace/name` when the service sets `service.namespace`. An instant query reads the 5 minutes before end_time: move end_time, or check names with list_metrics."
								: "Labels use underscores (`host_name`); `job` is the service name, as `namespace/name` when the service sets `service.namespace`. Widen start_time, or check names with list_metrics.",
						],
					},
				}
			: undefined),
		...(output.totalSeries > output.series.length
			? {
					truncation: {
						shown: output.series.length,
						total: output.totalSeries,
						noun: "series (highest peaks kept)",
					},
				}
			: undefined),
		...(clipped
			? {
					notices: [
						`Each series shows its last ${MAX_POINTS} points; a coarser step covers the whole window.`,
					],
				}
			: undefined),
		next: empty
			? [
					doc.next(
						"list_metrics",
						{ start_time: output.timeRange.start, end_time: output.timeRange.end },
						"find the metric's OTel name",
					),
				]
			: output.totalSeries > output.series.length && aggregate !== undefined
				? [aggregate]
				: [],
	}
}

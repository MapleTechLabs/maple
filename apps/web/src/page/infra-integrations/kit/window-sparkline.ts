import { toEpochMs } from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"

// A thin line sparkline placed on the time window: a few recent buckets sit at the right end,
// and a missing bucket (or a null value) breaks the line instead of being bridged.

export type SparkPoint = Readonly<{ bucket: string; value: number | null }>

export type SparkWindow = Readonly<{ startMs: number; endMs: number; bucketMs: number }>

const WIDTH = 100
const HEIGHT = 28
/** Keeps the stroke inside the box at the extremes. */
const PAD = 2

/** Each unbroken run of points as `[x, y]` in a 100 x 28 box, x by timestamp across the window. */
export const sparkSegments = (
	points: ReadonlyArray<SparkPoint>,
	window: SparkWindow,
): ReadonlyArray<ReadonlyArray<readonly [number, number]>> => {
	const span = window.endMs - window.startMs
	const placed = points
		.map((point) => ({ at: toEpochMs(point.bucket), value: point.value }))
		.filter((point) => Number.isFinite(point.at))
		.toSorted((a, b) => a.at - b.at)
	const values = placed.flatMap((point) =>
		point.value === null || !Number.isFinite(point.value) ? [] : [point.value],
	)
	if (span <= 0 || values.length === 0) return []
	const min = Math.min(...values)
	const max = Math.max(...values)
	const x = (at: number) => Math.min(Math.max(((at - window.startMs) / span) * WIDTH, 0), WIDTH)
	const y = (value: number) =>
		max === min ? HEIGHT / 2 : PAD + (1 - (value - min) / (max - min)) * (HEIGHT - PAD * 2)
	return placed
		.reduce<ReadonlyArray<ReadonlyArray<readonly [number, number]>>>((runs, point, index) => {
			if (point.value === null || !Number.isFinite(point.value)) return [...runs, []]
			const previous = placed[index - 1]
			const isGap = previous === undefined || point.at - previous.at > window.bucketMs * 1.5
			const xy: readonly [number, number] = [x(point.at), y(point.value)]
			const last = runs[runs.length - 1]
			return isGap || last === undefined ? [...runs, [xy]] : [...runs.slice(0, -1), [...last, xy]]
		}, [])
		.filter((run) => run.length > 0)
}

const pathOf = (runs: ReturnType<typeof sparkSegments>): string =>
	runs
		.map((run) =>
			// A lone point draws as a dot through the round cap.
			run.length === 1
				? `M${run[0]?.[0] ?? 0} ${run[0]?.[1] ?? 0} h0.01`
				: run.map(([px, py], index) => `${index === 0 ? "M" : "L"}${px} ${py}`).join(" "),
		)
		.join(" ")

export type WindowSparklineOptions = Readonly<{
	points: ReadonlyArray<SparkPoint>
	window: SparkWindow
	/** A CSS colour for the stroke; `currentColor` takes the class's text colour. */
	color: string
	className?: string
	label?: string
}>

export const windowSparkline = <M>(h: HtmlBuilder<M>, options: WindowSparklineOptions): Html =>
	h.svg(
		[
			h.Attribute("viewBox", `0 0 ${WIDTH} ${HEIGHT}`),
			h.Attribute("preserveAspectRatio", "none"),
			h.Attribute("fill", "none"),
			h.Attribute("class", cn("block h-7 w-full", options.className)),
			...(options.label === undefined
				? [h.Attribute("aria-hidden", "true")]
				: [h.Attribute("role", "img"), h.Attribute("aria-label", options.label)]),
		],
		[
			h.path([
				h.Attribute("d", pathOf(sparkSegments(options.points, options.window))),
				h.Attribute("stroke", options.color),
				h.Attribute("stroke-width", "1.5"),
				h.Attribute("stroke-linecap", "round"),
				h.Attribute("stroke-linejoin", "round"),
				h.Attribute("vector-effect", "non-scaling-stroke"),
			]),
		],
	)

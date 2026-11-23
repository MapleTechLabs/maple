import { formatBucketLabel } from "@maple/ui/lib/format"
import { toEpochMs } from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"
import { Array as Arr, Effect, Option, Queue, Schema, Stream } from "effect"
import { Mount, Submodel } from "foldkit"
import { Message, type Model } from "./chart"

// A sparkline: one small SVG drawn by `MountSparkline` (`spark-svg.ts`), with bklit's hover
// (sprung crosshair and dot, the series dimmed around a bright band). Embed it with `h.submodel`.

export interface SparklineInputs {
	readonly chartId: string
	readonly values: ReadonlyArray<number>
	/** Any CSS colour; a resolved literal or a `var()`. */
	readonly color: string
	readonly className?: string
	/** Changes with every fetched result; kept for callers, the values alone decide the redraw. */
	readonly revision: number
	/** The curve and fill opacity at the top and bottom (default `[0.3, 0]`). */
	readonly curve?: "linear" | "monotone"
	readonly fillOpacity?: readonly [start: number, end: number]
	/** Frame an empty series too, where the gradient sparkline draws nothing. */
	readonly isFramedWhenEmpty?: boolean
	/** Wipe in on first paint (default). Tables pass `false`: their rows remount on every filter. */
	readonly animatesEntrance?: boolean
}

const SPARKLINE_ATTRIBUTE = "data-sparkline"

const SparkData = Schema.Struct({
	values: Schema.Array(Schema.Number),
	color: Schema.String,
	curve: Schema.Literals(["linear", "monotone"]),
	fillStart: Schema.Number,
	fillEnd: Schema.Number,
	animatesEntrance: Schema.Boolean,
})
const SparkDataJson = Schema.fromJsonString(SparkData)
const encodeSparkData = Schema.encodeSync(SparkDataJson)
const decodeSparkData = Schema.decodeUnknownOption(SparkDataJson)

const SparklineMountMessage = Schema.Union([Message.CompletedMountChart, Message.ChangedChartFocus])
type SparklineMountMessage = typeof SparklineMountMessage.Type

/** The hovered point's index, read from the chart Model the sparkline's hover writes. */
export const hoveredIndex = (model: Model): Option.Option<number> =>
	Option.flatMap(model.activeKey, (key) => {
		const index = Number(key)
		return Number.isInteger(index) && index >= 0 ? Option.some(index) : Option.none()
	})

/**
 * When the hovered point was, as a terse axis-style label ("14:00", "Nov 21, 14:00"): the
 * range and bucket length come from the buckets themselves.
 */
export const hoveredPointLabel = (
	buckets: ReadonlyArray<string>,
	index: number,
	timeZone: string,
): Option.Option<string> =>
	Option.map(Arr.get(buckets, index), (bucket) => {
		const first = Option.getOrElse(Arr.head(buckets), () => bucket)
		const last = Option.getOrElse(Arr.last(buckets), () => bucket)
		const second = Option.getOrElse(Arr.get(buckets, 1), () => bucket)
		return formatBucketLabel(
			bucket,
			{
				rangeMs: toEpochMs(last) - toEpochMs(first),
				bucketSeconds: (toEpochMs(second) - toEpochMs(first)) / 1000,
				timeZone,
			},
			"tick",
		)
	})

/** Draws the element's `data-sparkline` and follows it (a MutationObserver picks up new data). */
export const MountSparkline = Mount.defineStream("MountSparkline", {
	messages: [Message.CompletedMountChart, Message.ChangedChartFocus],
	execute: ({ element }) =>
		Stream.callback<SparklineMountMessage>((queue) =>
			Effect.acquireRelease(
				Effect.promise(() => import("./spark-svg")).pipe(
					Effect.map(({ createSparkSvg }) => {
						const read = () => decodeSparkData(element.getAttribute(SPARKLINE_ATTRIBUTE))
						if (!(element instanceof HTMLElement)) return () => undefined
						return Option.match(read(), {
							onNone: () => () => undefined,
							onSome: (initial) => {
								const spark = createSparkSvg(element, initial, (index) =>
									Queue.offerUnsafe(
										queue,
										Message.ChangedChartFocus({
											maybeKey: Option.map(Option.fromNullishOr(index), String),
										}),
									),
								)
								const observer = new MutationObserver(() => Option.map(read(), spark.update))
								observer.observe(element, {
									attributes: true,
									attributeFilter: [SPARKLINE_ATTRIBUTE],
								})
								Queue.offerUnsafe(queue, Message.CompletedMountChart())
								return () => {
									observer.disconnect()
									spark.destroy()
								}
							},
						})
					}),
				),
				(release) => Effect.sync(release),
			).pipe(Effect.flatMap(() => Effect.never)),
		),
})

export const view = Submodel.defineView<Model, Message, SparklineInputs>((_model, inputs, h) =>
	inputs.values.length === 0 && inputs.isFramedWhenEmpty !== true
		? h.div([h.Class(inputs.className ?? "")], [])
		: h.div(
				[
					h.Class(cn("relative select-none", inputs.className)),
					h.Attribute("role", "img"),
					h.AriaLabel("Trend"),
					h.Attribute(
						SPARKLINE_ATTRIBUTE,
						encodeSparkData({
							values: inputs.values,
							color: inputs.color,
							curve: inputs.curve ?? "linear",
							fillStart: inputs.fillOpacity?.[0] ?? 0.3,
							fillEnd: inputs.fillOpacity?.[1] ?? 0,
							animatesEntrance: inputs.animatesEntrance ?? true,
						}),
					),
					h.OnMount(MountSparkline()),
				],
				[],
			),
)

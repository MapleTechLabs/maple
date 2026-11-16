import { Effect, Option, Queue, Schema, Stream } from "effect"
import { Mount, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { createFlameChart, type FlameChartProps } from "./flame-chart"
import { FrameScope } from "./profile-tree"

/**
 * The profile flame chart as a Submodel: a zoomable icicle of a window's call stacks, navigated
 * like Chrome's performance panel. Zoom, pan and hover stay inside the canvas (`flame-chart.ts`);
 * the Model holds what the rest of the page reads: the selected frame, the search, the scope and
 * whether the chart is zoomed. The stacks themselves are the parent's data.
 */

export { FrameScope } from "./profile-tree"

export const Model = Schema.Struct({
	id: Schema.String,
	selectedNodeId: Schema.Option(Schema.String),
	search: Schema.String,
	/** Every frame, or only the service's own code with libraries and the runtime folded away. */
	scope: FrameScope,
	isZoomed: Schema.Boolean,
	/** Bumped by Reset: the canvas returns to the whole profile when it changes. */
	resetToken: Schema.Number,
})
export type Model = typeof Model.Type

export const init = (id: string): Model => ({
	id,
	selectedNodeId: Option.none(),
	search: "",
	scope: "all",
	isZoomed: false,
	resetToken: 0,
})

/**
 * The view for a new profile in the same place (another range or service): back to the whole
 * profile, with no selection or search. The scope is the reader's choice and stays.
 */
export const reset = (model: Model): Model => ({
	...model,
	selectedNodeId: Option.none(),
	search: "",
	resetToken: model.resetToken + 1,
})

export const Message = defineMessageUnion({
	SelectedFrame: { nodeId: Schema.NullOr(Schema.String) },
	ChangedZoom: { isZoomed: Schema.Boolean },
	ClickedReset: {},
	ChangedSearch: { value: Schema.String },
	ChangedScope: { scope: FrameScope },
	ClearedSearch: {},
})
export type Message = typeof Message.Type

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
	Message.match<Update.Return<Model, Message>>(message, {
		SelectedFrame: ({ nodeId }) => ({ model: { ...model, selectedNodeId: Option.fromNullOr(nodeId) } }),
		// Every new chart reports its zoom once, usually what the Model already holds.
		ChangedZoom: ({ isZoomed }) => ({
			model: model.isZoomed === isZoomed ? model : { ...model, isZoomed },
		}),
		ClickedReset: () => ({ model: { ...model, resetToken: model.resetToken + 1 } }),
		ChangedSearch: ({ value }) => ({ model: { ...model, search: value } }),
		// The two scopes are different trees: a selection in one names nothing in the other.
		ChangedScope: ({ scope }) => ({ model: { ...model, scope, selectedNodeId: Option.none() } }),
		ClearedSearch: () => ({ model: { ...model, search: "" } }),
	})

/** The attribute whose change tells a mounted chart to pick up new props. */
export const FLAME_REVISION_ATTRIBUTE = "data-flame-revision"

/**
 * What each chart should draw, by chart id. The tree is far too large for a DOM attribute, so the
 * view leaves it here and bumps the element's revision attribute; the mounted chart reads it back.
 */
const published = new Map<string, { readonly props: FlameChartProps; readonly revision: number }>()

/** Charts mounted per id: an entry goes when its last chart does. */
const mounts = new Map<string, number>()

// One counter for every chart, so a revision never repeats and an element's attribute always
// changes when its props do, whatever was published under the id before.
let lastRevision = 0

/** Records a chart's props and returns the revision to put on its element. */
export const publishFlameProps = (id: string, props: FlameChartProps): string => {
	const current = published.get(id)
	const unchanged =
		current !== undefined &&
		current.props.root === props.root &&
		current.props.viewKey === props.viewKey &&
		current.props.search === props.search &&
		current.props.selectedId === props.selectedId &&
		current.props.resetToken === props.resetToken
	if (unchanged) return String(current.revision)
	lastRevision += 1
	published.set(id, { props, revision: lastRevision })
	return String(lastRevision)
}

/** The props last published for a chart, if any chart still holds the id. */
export const publishedFlameProps = (id: string): FlameChartProps | undefined => published.get(id)?.props

/** A chart mounted under `id`. */
export const retainFlameProps = (id: string): void => {
	mounts.set(id, (mounts.get(id) ?? 0) + 1)
}

/** A chart under `id` unmounted. Its props stay until `forgetFlameProps`. */
export const releaseFlameProps = (id: string): void => {
	const left = (mounts.get(id) ?? 1) - 1
	if (left > 0) mounts.set(id, left)
	else mounts.delete(id)
}

/** Drops the props of an id no chart is mounted under any more. */
export const forgetFlameProps = (id: string): void => {
	if (!mounts.has(id)) published.delete(id)
}

const ChartMessage = Schema.Union([Message.SelectedFrame, Message.ChangedZoom])
type ChartMessage = typeof ChartMessage.Type

/** Builds the canvas chart inside the element and keeps it on the props published for `chartId`. */
export const MountFlameChart = Mount.defineStream("MountProfileFlameChart", {
	args: { chartId: Schema.String, maxRows: Schema.Number },
	messages: [Message.SelectedFrame, Message.ChangedZoom],
	execute: ({ element, chartId, maxRows }) =>
		Stream.callback<ChartMessage>((queue) =>
			Effect.acquireRelease(
				Effect.sync(() => {
					if (!(element instanceof HTMLElement)) return () => undefined
					const chart = createFlameChart(
						element,
						{ maxRows },
						{
							onSelect: (nodeId) => Queue.offerUnsafe(queue, Message.SelectedFrame({ nodeId })),
							onZoomChange: (isZoomed) =>
								Queue.offerUnsafe(queue, Message.ChangedZoom({ isZoomed })),
						},
					)
					retainFlameProps(chartId)
					const sync = (): void => {
						const props = publishedFlameProps(chartId)
						if (props !== undefined) chart.update(props)
					}
					sync()
					const observer = new MutationObserver(sync)
					observer.observe(element, {
						attributes: true,
						attributeFilter: [FLAME_REVISION_ATTRIBUTE],
					})
					return () => {
						observer.disconnect()
						chart.destroy()
						releaseFlameProps(chartId)
					}
				}),
				// A chart recreated in one patch unmounts first and mounts right after, in the same
				// turn. Forgetting a turn later leaves it the props the view has just published.
				(cleanup) =>
					Effect.sync(cleanup).pipe(
						Effect.andThen(Effect.yieldNow),
						Effect.andThen(Effect.sync(() => forgetFlameProps(chartId))),
					),
			).pipe(Effect.flatMap(() => Effect.never)),
		),
})

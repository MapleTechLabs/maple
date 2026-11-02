import { Effect, Option, Queue, Schema, Stream } from "effect"
import { Command, Mount, Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import * as Tooltip from "../ui/tooltip"
import { findSpanById } from "../service-map/trace-flow/flow-graph"
import { type FlamegraphInput, spanAtMinimapPercent } from "./flamegraph-layout"

/**
 * `Flamegraph` (packages/ui `traces/flamegraph.tsx`) as a Submodel: click a bar to select its span
 * (an OutMessage, the parent owns selection), Shift+click to zoom into it, the minimap to move the
 * zoom, Reset to leave it. A hover on a bar shows the span tooltip.
 */

// MODEL

export const Model = Schema.Struct({
	id: Schema.String,
	focusedSpanId: Schema.Option(Schema.String),
	tooltip: Tooltip.Model,
})
export type Model = typeof Model.Type

export const init = (id: string): Model => ({
	id,
	focusedSpanId: Option.none(),
	tooltip: Tooltip.init(`${id}-tooltip`, { side: "top" }),
})

/** The id a bar's tooltip trigger carries. */
export const barTriggerId = (flamegraphId: string, spanId: string): string => `${flamegraphId}-bar-${spanId}`

// MESSAGE

export const Message = defineMessageUnion({
	ClickedBar: { spanId: Schema.String, isShift: Schema.Boolean },
	ClickedReset: {},
	PointedMinimap: { percent: Schema.Finite },
	GotTooltipMessage: { message: Tooltip.Message },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
	SelectedSpan: { spanId: Schema.String },
})
export type OutMessage = typeof OutMessage.Type

// UPDATE

type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage>

const focus = (model: Model, spanId: Option.Option<string>): Return => ({
	model: { ...model, focusedSpanId: spanId },
})

export const update =
	(input: FlamegraphInput) =>
	(model: Model, message: Message): Return =>
		Message.match<Return>(message, {
			ClickedBar: ({ spanId, isShift }) => {
				if (!isShift) return { model, outMessage: OutMessage.SelectedSpan({ spanId }) }
				if (Option.contains(model.focusedSpanId, spanId)) return focus(model, Option.none())
				return findSpanById(input.rootSpans, spanId) === undefined
					? { model }
					: focus(model, Option.some(spanId))
			},
			ClickedReset: () => focus(model, Option.none()),
			PointedMinimap: ({ percent }) => {
				const span = spanAtMinimapPercent(input, percent)
				return span === undefined || Option.contains(model.focusedSpanId, span.spanId)
					? { model }
					: focus(model, Option.some(span.spanId))
			},
			GotTooltipMessage: ({ message: inner }) => {
				const next = Tooltip.update(model.tooltip, inner)
				return {
					model: { ...model, tooltip: next.model },
					commands: Command.mapMessages(next.commands ?? [], (m) =>
						Message.GotTooltipMessage({ message: m }),
					),
				}
			},
		})

/** The zoomed-into span, if it is still in the trace. */
export const focusedSpan = (model: Model, input: FlamegraphInput) =>
	Option.flatMap(model.focusedSpanId, (spanId) =>
		Option.fromUndefinedOr(findSpanById(input.rootSpans, spanId)),
	)

// MOUNT

const percentOf = (track: Element, clientX: number): number => {
	const rect = track.getBoundingClientRect()
	return rect.width === 0 ? 0 : ((clientX - rect.left) / rect.width) * 100
}

/**
 * Foldkit's click carries no modifier keys, so the flamegraph listens for a bar's click and Shift
 * itself; it also drives the minimap, where a press or a drag moves the zoom.
 */
export const MountFlamegraph = Mount.defineStream("MountFlamegraph", {
	messages: [Message.ClickedBar, Message.PointedMinimap],
	execute: ({ element }) =>
		Stream.callback<typeof Message.ClickedBar.Type | typeof Message.PointedMinimap.Type>((queue) =>
			Effect.acquireRelease(
				Effect.sync(() => {
					let dragging = false
					const closest = (event: Event, selector: string) =>
						event.target instanceof Element ? event.target.closest(selector) : null
					const point = (event: PointerEvent) => {
						const track = element.querySelector("[data-flame-minimap-track]")
						if (track !== null)
							Queue.offerUnsafe(
								queue,
								Message.PointedMinimap({ percent: percentOf(track, event.clientX) }),
							)
					}
					const onClick = (event: Event) => {
						const spanId = closest(event, "[data-flame-bar]")?.getAttribute("data-flame-bar")
						if (!(event instanceof MouseEvent) || spanId === null || spanId === undefined) return
						Queue.offerUnsafe(queue, Message.ClickedBar({ spanId, isShift: event.shiftKey }))
					}
					// A Shift press on a bar zooms; it should not start a text selection.
					const onMouseDown = (event: Event) => {
						if (
							event instanceof MouseEvent &&
							event.shiftKey &&
							closest(event, "[data-flame-bar]") !== null
						)
							event.preventDefault()
					}
					const onPointerDown = (event: Event) => {
						if (
							!(event instanceof PointerEvent) ||
							event.button !== 0 ||
							closest(event, "[data-flame-minimap]") === null
						)
							return
						dragging = true
						point(event)
					}
					const onPointerMove = (event: Event) => {
						if (dragging && event instanceof PointerEvent) point(event)
					}
					const onPointerUp = () => {
						dragging = false
					}
					element.addEventListener("click", onClick)
					element.addEventListener("mousedown", onMouseDown)
					element.addEventListener("pointerdown", onPointerDown)
					window.addEventListener("pointermove", onPointerMove)
					window.addEventListener("pointerup", onPointerUp)
					window.addEventListener("pointercancel", onPointerUp)
					return { onClick, onMouseDown, onPointerDown, onPointerMove, onPointerUp }
				}),
				(listeners) =>
					Effect.sync(() => {
						element.removeEventListener("click", listeners.onClick)
						element.removeEventListener("mousedown", listeners.onMouseDown)
						element.removeEventListener("pointerdown", listeners.onPointerDown)
						window.removeEventListener("pointermove", listeners.onPointerMove)
						window.removeEventListener("pointerup", listeners.onPointerUp)
						window.removeEventListener("pointercancel", listeners.onPointerUp)
					}),
			).pipe(Effect.flatMap(() => Effect.never)),
		),
})

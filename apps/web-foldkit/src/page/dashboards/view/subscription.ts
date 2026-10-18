import { resolveRefreshIntervalSeconds } from "@maple/web/lib/dashboard-controls/search-params"
import { Duration, Effect, Queue, Schema, Stream } from "effect"
import { Subscription } from "foldkit"
import type { Resources } from "../../../platform/resources"
import type { PageSubscriptionInput } from "../../contract"
import { documentStream, orgTagsStream } from "../kit/document-stream"
import { Message } from "./message"
import type { Model } from "./model"
import { isEditing } from "./update"

type PointerMessage =
	| typeof Message.MovedPointer.Type
	| typeof Message.ReleasedPointer.Type
	| typeof Message.CancelledPointer.Type

/** Auto-scroll while the pointer is this close to the scroller's edge, this far per frame. */
const EDGE_PX = 50
const EDGE_STEP_PX = 12

/** `nearestScroller`: the first scrolling ancestor, else the document. */
const nearestScroller = (element: HTMLElement): HTMLElement => {
	const scrolling = (node: HTMLElement | null): HTMLElement | null => {
		if (node === null) return null
		const overflowY = getComputedStyle(node).overflowY
		return (overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight
			? node
			: scrolling(node.parentElement)
	}
	return (
		scrolling(element.parentElement) ??
		(document.scrollingElement instanceof HTMLElement
			? document.scrollingElement
			: document.documentElement)
	)
}

/** `autoScroll`: one step if the pointer is near the scroller's edge; whether it moved. */
const autoScroll = (scroller: HTMLElement, clientY: number): boolean => {
	const isDocument = scroller === document.scrollingElement || scroller === document.documentElement
	const top = isDocument ? 0 : scroller.getBoundingClientRect().top
	const bottom = isDocument ? window.innerHeight : scroller.getBoundingClientRect().bottom
	const before = scroller.scrollTop
	if (clientY < top + EDGE_PX) scroller.scrollTop -= EDGE_STEP_PX
	else if (clientY > bottom - EDGE_PX) scroller.scrollTop += EDGE_STEP_PX
	return scroller.scrollTop !== before
}

/**
 * The gesture's window listeners and its per-frame step: each frame auto-scrolls if the pointer
 * is near the edge and reports the pointer with the grid's position, so the tile stays under it.
 */
const pointerEvents = Stream.callback<PointerMessage>((queue) =>
	Effect.acquireRelease(
		Effect.sync(() => {
			const grid = document.querySelector<HTMLElement>("[data-dashboard-grid]")
			const scroller = grid === null ? null : nearestScroller(grid)
			const pointer = { x: 0, y: 0, frame: 0 }
			const step = () => {
				pointer.frame = 0
				if (grid === null) return
				const isScrolled = scroller !== null && autoScroll(scroller, pointer.y)
				const rect = grid.getBoundingClientRect()
				Queue.offerUnsafe(
					queue,
					Message.MovedPointer({
						clientX: pointer.x,
						clientY: pointer.y,
						gridLeft: rect.left,
						gridTop: rect.top,
					}),
				)
				if (isScrolled) pointer.frame = requestAnimationFrame(step)
			}
			const onMove = (event: PointerEvent) => {
				pointer.x = event.clientX
				pointer.y = event.clientY
				if (pointer.frame === 0) pointer.frame = requestAnimationFrame(step)
			}
			const onUp = () => Queue.offerUnsafe(queue, Message.ReleasedPointer())
			const onCancel = () => Queue.offerUnsafe(queue, Message.CancelledPointer())
			const onKey = (event: KeyboardEvent) => {
				if (event.key !== "Escape") return
				event.preventDefault()
				Queue.offerUnsafe(queue, Message.CancelledPointer())
			}
			window.addEventListener("pointermove", onMove)
			window.addEventListener("pointerup", onUp)
			window.addEventListener("pointercancel", onCancel)
			window.addEventListener("keydown", onKey)
			return () => {
				cancelAnimationFrame(pointer.frame)
				window.removeEventListener("pointermove", onMove)
				window.removeEventListener("pointerup", onUp)
				window.removeEventListener("pointercancel", onCancel)
				window.removeEventListener("keydown", onKey)
			}
		}),
		(detach) => Effect.sync(detach),
	).pipe(Effect.flatMap(() => Effect.never)),
)

export const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message, Resources>()(
	(entry) => ({
		dashboard: entry(
			{ orgId: Schema.String, dashboardId: Schema.String },
			{
				modelToDependencies: ({ model, context }) => ({
					orgId: context.orgId,
					dashboardId: model.dashboardId,
				}),
				dependenciesToStream: ({ orgId, dashboardId }) =>
					documentStream(orgId, dashboardId, (maybeDocument) =>
						Message.UpdatedDashboard({ orgId, maybeDocument }),
					),
			},
		),
		/** The org's tags, for the tag editor's suggestions. */
		orgTags: entry(
			{ orgId: Schema.String },
			{
				modelToDependencies: ({ context }) => ({ orgId: context.orgId }),
				dependenciesToStream: ({ orgId }) =>
					orgTagsStream(orgId, (tags) => Message.UpdatedOrgTags({ tags })),
			},
		),
		/** `useGridInteraction`'s window listeners, attached for the life of a pointer gesture. */
		gesturePointer: entry(
			{ isActive: Schema.Boolean },
			{
				modelToDependencies: ({ model }) => ({ isActive: model.gesture !== null }),
				dependenciesToStream: ({ isActive }) => (isActive ? pointerEvents : Stream.empty),
			},
		),
		/** `useIntervalRefresh`: paused in edit mode, and a hidden tab skips its ticks. */
		autoRefresh: entry(
			{ seconds: Schema.Number },
			{
				modelToDependencies: ({ model }) => ({
					seconds:
						isEditing(model) || model.document === null
							? 0
							: resolveRefreshIntervalSeconds(
									model.search.refresh,
									model.document.refreshIntervalSeconds,
								),
				}),
				dependenciesToStream: ({ seconds }) =>
					seconds <= 0
						? Stream.empty
						: Stream.tick(Duration.seconds(seconds)).pipe(
								Stream.drop(1),
								Stream.filter(() => !document.hidden),
								Stream.map(() => Message.TickedAutoRefresh()),
							),
			},
		),
	}),
)

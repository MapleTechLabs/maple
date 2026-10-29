import { SIDEBAR_WIDTH_STORAGE_KEY } from "@maple/ui/components/traces/trace-timeline-types"
import { readLocalStorage } from "@maple/ui/lib/local-storage"
import { Effect, Option, Queue, Schema, Stream } from "effect"
import { TimelineDefinition } from "./definition"
import { ROW_PITCH } from "./layout"
import { Message } from "./message"

/** `readSidebarWidth`'s storage read; clamping happens in `update`. */
export const ReadSidebarWidth = TimelineDefinition.makeCommand("ReadTraceTimelineSidebarWidth", {
	messages: [Message.CompletedReadSidebarWidth],
	handler: function* () {
		return () =>
			Effect.sync(() =>
				Message.CompletedReadSidebarWidth({
					width: Option.getOrNull(
						Option.filter(
							Option.map(readLocalStorage(SIDEBAR_WIDTH_STORAGE_KEY), Number),
							Number.isFinite,
						),
					),
				}),
			)
	},
})

/** `/`: focus the timeline's search box (`searchInputRef.current?.focus()`). */
export const FocusSearch = TimelineDefinition.makeCommand("FocusTraceTimelineSearch", {
	messages: [Message.CompletedFocusSearch],
	handler: function* () {
		return () =>
			Effect.sync(() => {
				document.querySelector<HTMLInputElement>('input[placeholder="Search spans…"]')?.focus()
				return Message.CompletedFocusSearch()
			})
	},
})

const SCROLL_EVENT = "maple:trace-timeline-scroll"

/**
 * `rowVirtualizer.scrollToIndex(index, { align: "auto" })`, delivered to the body's Mount after the
 * next paint, once the rows rendered.
 */
export const ScrollToRow = TimelineDefinition.makeCommand("ScrollTraceTimelineToRow", {
	args: { index: Schema.Number },
	messages: [Message.CompletedScrollRequest],
	handler: function* () {
		return ({ index }) =>
			Effect.callback<typeof Message.CompletedScrollRequest.Type>((resume) => {
				const handle = requestAnimationFrame(() => {
					window.dispatchEvent(new CustomEvent(SCROLL_EVENT, { detail: index }))
					resume(Effect.succeed(Message.CompletedScrollRequest()))
				})
				return Effect.sync(() => cancelAnimationFrame(handle))
			})
	},
})

/** virtual-core's `align: "auto"` offset for a fixed-pitch row, clamped to the scroll range. */
const autoOffset = (scroller: HTMLElement, index: number): number | null => {
	const size = scroller.clientHeight
	const offset = scroller.scrollTop
	const start = index * ROW_PITCH
	const end = start + ROW_PITCH
	const max = Math.max(0, scroller.scrollHeight - size)
	if (end >= offset + size) return Math.max(0, Math.min(max, end - size))
	if (start <= offset) return Math.max(0, Math.min(max, start))
	return null
}

type MeasureMessage = typeof Message.MeasuredScroller.Type

const measure = (scroller: HTMLElement): Stream.Stream<MeasureMessage> =>
	Stream.callback<MeasureMessage>((queue) =>
		Effect.acquireRelease(
			Effect.sync(() => {
				const state = { width: -1, height: -1 }
				const apply = (width: number, height: number) => {
					const next = { width: Math.round(width), height: Math.round(height) }
					if (next.width === state.width && next.height === state.height) return
					state.width = next.width
					state.height = next.height
					Queue.offerUnsafe(queue, Message.MeasuredScroller(next))
				}
				const rect = scroller.getBoundingClientRect()
				apply(rect.width, rect.height)
				const observer = new ResizeObserver((entries) =>
					entries.forEach((entry) => apply(entry.contentRect.width, entry.contentRect.height)),
				)
				observer.observe(scroller)
				const onScrollRequest = (event: Event) => {
					const index = event instanceof CustomEvent ? Number(event.detail) : Number.NaN
					const top = Number.isInteger(index) ? autoOffset(scroller, index) : null
					if (top !== null) scroller.scrollTop = top
				}
				window.addEventListener(SCROLL_EVENT, onScrollRequest)
				return () => {
					window.removeEventListener(SCROLL_EVENT, onScrollRequest)
					observer.disconnect()
				}
			}),
			(cleanup) => Effect.sync(cleanup),
		).pipe(Effect.flatMap(() => Effect.never)),
	)

/** The body scroller: `useContainerSize` plus the scroll requests above. */
export const MeasureTimelineBody = TimelineDefinition.makeMountStream("MeasureTraceTimelineBody", {
	messages: [Message.MeasuredScroller],
	handler: function* () {
		return ({ element, viewStateChanges }) =>
			viewStateChanges.pipe(
				Stream.switchMap((viewState) =>
					viewState === "Live" && element instanceof HTMLElement ? measure(element) : Stream.never,
				),
			)
	},
})

const altToggles = (element: Element): Stream.Stream<typeof Message.AltClickedToggleCollapse.Type> =>
	Stream.callback<typeof Message.AltClickedToggleCollapse.Type>((queue) =>
		Effect.acquireRelease(
			Effect.sync(() => {
				const onClick = (event: Event) => {
					if (!(event instanceof MouseEvent) || !event.altKey) return
					const toggle =
						event.target instanceof Element
							? event.target.closest("[data-toggle-span]")
							: null
					const spanId = toggle?.getAttribute("data-toggle-span")
					if (spanId === null || spanId === undefined) return
					event.stopPropagation()
					Queue.offerUnsafe(queue, Message.AltClickedToggleCollapse({ spanId }))
				}
				element.addEventListener("click", onClick, true)
				return onClick
			}),
			(onClick) => Effect.sync(() => element.removeEventListener("click", onClick, true)),
		).pipe(Effect.flatMap(() => Effect.never)),
	)

/**
 * The row toggle's ⌥-click (`event.altKey`): Foldkit's click carries no modifiers, so the rows
 * listen first (capture) and, with ⌥ held, report the subtree toggle instead of the plain one.
 */
export const MountAltToggle = TimelineDefinition.makeMountStream("MountTimelineAltToggle", {
	messages: [Message.AltClickedToggleCollapse],
	handler: function* () {
		return ({ element }) => altToggles(element)
	},
})

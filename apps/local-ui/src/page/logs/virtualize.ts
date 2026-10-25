import { Effect, Queue, Stream } from "effect"
import { Mount } from "foldkit"
import { Message } from "./message"
import type { Viewport } from "./model"

// `useVirtualizer` in `LogListMode` (fixed 36 px rows, overscan 12) as data: a Mount reports the
// scroller's height and offset, and the window is computed from the Model.

export const ROW_HEIGHT = 36
const OVERSCAN = 12

/** @tanstack/virtual-core's `calculateRange` + `defaultRangeExtractor` for fixed-size rows. */
export const virtualWindow = (count: number, viewport: Viewport): ReadonlyArray<number> => {
	if (count === 0 || viewport.height <= 0) return []
	const lastIndex = count - 1
	const start = Math.min(lastIndex, Math.floor(viewport.scrollTop / ROW_HEIGHT))
	const end = Math.min(lastIndex, Math.max(start, Math.ceil((viewport.scrollTop + viewport.height) / ROW_HEIGHT) - 1))
	const from = Math.max(start - OVERSCAN, 0)
	const to = Math.min(end + OVERSCAN, lastIndex)
	return Array.from({ length: to - from + 1 }, (_, offset) => from + offset)
}

/** `onChange`: the last rendered row is the last loaded one, so the next page is wanted. */
export const reachesEnd = (count: number, viewport: Viewport): boolean => {
	const rows = virtualWindow(count, viewport)
	const last = rows[rows.length - 1]
	return last !== undefined && last >= count - 1
}

const viewportOf = (element: HTMLElement): Viewport => ({ scrollTop: element.scrollTop, height: element.offsetHeight })

/** `observeElementRect` and `observeElementOffset` on the stream's scroller. */
export const ObserveLogsViewport = Mount.defineStream("ObserveLogsViewport", {
	messages: [Message.ChangedViewport],
	execute: ({ element }) =>
		Stream.callback<typeof Message.ChangedViewport.Type>((queue) =>
			Effect.acquireRelease(
				Effect.sync(() => {
					if (!(element instanceof HTMLElement)) return () => undefined
					const emit = () => Queue.offerUnsafe(queue, Message.ChangedViewport({ viewport: viewportOf(element) }))
					const resize = new ResizeObserver(emit)
					resize.observe(element)
					element.addEventListener("scroll", emit, { passive: true })
					emit()
					return () => {
						resize.disconnect()
						element.removeEventListener("scroll", emit)
					}
				}),
				(cleanup) => Effect.sync(cleanup),
			).pipe(Effect.flatMap(() => Effect.never)),
		),
})

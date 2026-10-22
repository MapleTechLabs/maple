import { elementScroll, observeElementOffset, observeElementRect, Virtualizer } from "@tanstack/virtual-core"
import { Effect, Queue, Schema, Stream } from "effect"

// `SessionsList`'s `useVirtualizer` over the page scroller (`usePageScrollMargin`), on
// @tanstack/virtual-core: same estimate, overscan, item keys and measuring of every mounted row.

/** The list container carries its item keys, so the Mount sees every change without re-mounting. */
export const KEYS_ATTRIBUTE = "session-keys"
const ESTIMATE = 65
const OVERSCAN = 8

export const VirtualRow = Schema.Struct({ index: Schema.Number, start: Schema.Number, end: Schema.Number })
export type VirtualRow = typeof VirtualRow.Type

export const VirtualWindow = Schema.Struct({
	rows: Schema.Array(VirtualRow),
	totalSize: Schema.Number,
	scrollMargin: Schema.Number,
})
export type VirtualWindow = typeof VirtualWindow.Type

export const emptyWindow: VirtualWindow = { rows: [], totalSize: 0, scrollMargin: 0 }

export const keysValue = (keys: ReadonlyArray<string>): string => keys.join("\n")

const keysOf = (list: HTMLElement): ReadonlyArray<string> => {
	const raw = list.getAttribute(`data-${KEYS_ATTRIBUTE}`) ?? ""
	return raw === "" ? [] : raw.split("\n")
}

const marginBetween = (list: HTMLElement, scroller: HTMLElement): number =>
	Math.max(
		0,
		Math.round(
			list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop,
		),
	)

const sameWindow = (a: VirtualWindow, b: VirtualWindow): boolean =>
	a.totalSize === b.totalSize &&
	a.scrollMargin === b.scrollMargin &&
	a.rows.length === b.rows.length &&
	a.rows.every(
		(row, i) =>
			row.index === b.rows[i]?.index && row.start === b.rows[i]?.start && row.end === b.rows[i]?.end,
	)

/** Runs the virtualizer for the list element; every window change becomes `toMessage(window)`. */
export const virtualizeSessions = <A>(
	list: HTMLElement,
	toMessage: (window: VirtualWindow) => A,
): Stream.Stream<A> =>
	Stream.callback<A>((queue) =>
		Effect.acquireRelease(
			Effect.sync(() => {
				const scroller = list.closest<HTMLElement>('[data-slot="page-scroll-area"]') ?? list
				const state = { keys: keysOf(list), scrollMargin: 0, last: emptyWindow, isScheduled: false }
				const emit = (instance: Virtualizer<HTMLElement, HTMLElement>) => {
					const next: VirtualWindow = {
						rows: instance
							.getVirtualItems()
							.map((item) => ({ index: item.index, start: item.start, end: item.end })),
						totalSize: instance.getTotalSize(),
						scrollMargin: state.scrollMargin,
					}
					if (sameWindow(next, state.last)) return
					state.last = next
					Queue.offerUnsafe(queue, toMessage(next))
				}
				// The re-render a measurement raises is batched to a microtask.
				const schedule = (instance: Virtualizer<HTMLElement, HTMLElement>) => {
					if (state.isScheduled) return
					state.isScheduled = true
					queueMicrotask(() => {
						state.isScheduled = false
						emit(instance)
					})
				}
				const options = () => ({
					count: state.keys.length,
					getItemKey: (index: number) => state.keys[index] ?? String(index),
					getScrollElement: () => scroller,
					estimateSize: () => ESTIMATE,
					overscan: OVERSCAN,
					scrollMargin: state.scrollMargin,
					observeElementRect,
					observeElementOffset,
					scrollToFn: elementScroll,
					onChange: (instance: Virtualizer<HTMLElement, HTMLElement>) => schedule(instance),
				})
				const virtualizer = new Virtualizer<HTMLElement, HTMLElement>(options())
				const update = () => {
					virtualizer.setOptions(options())
					virtualizer._willUpdate()
					schedule(virtualizer)
				}
				const measureRows = () =>
					list
						.querySelectorAll<HTMLElement>(":scope > [data-index]")
						.forEach((node) => virtualizer.measureElement(node))
				const rowObserver = new MutationObserver(measureRows)
				rowObserver.observe(list, { childList: true })
				const keysObserver = new MutationObserver(() => {
					state.keys = keysOf(list)
					update()
				})
				keysObserver.observe(list, { attributes: true, attributeFilter: [`data-${KEYS_ATTRIBUTE}`] })
				const resizes = new ResizeObserver(() => {
					const margin = marginBetween(list, scroller)
					if (margin === state.scrollMargin) return
					state.scrollMargin = margin
					update()
				})
				resizes.observe(list)
				resizes.observe(scroller)
				state.scrollMargin = marginBetween(list, scroller)
				const unmount = virtualizer._didMount()
				virtualizer.setOptions(options())
				virtualizer._willUpdate()
				measureRows()
				emit(virtualizer)
				return () => {
					rowObserver.disconnect()
					keysObserver.disconnect()
					resizes.disconnect()
					unmount()
				}
			}),
			(cleanup) => Effect.sync(cleanup),
		).pipe(Effect.flatMap(() => Effect.never)),
	)

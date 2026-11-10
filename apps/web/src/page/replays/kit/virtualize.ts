import { Virtualizer } from "@tanstack/virtual-core"
import { Schema, type Stream, Array as Arr } from "effect"
import {
	batchedOnChange,
	DOM_OPTIONS,
	type Instance,
	pageScrollerOf,
	sameRows,
	scrollMarginOf,
	splitAttribute,
	virtualizerStream,
} from "@maple/views/lib/virtualizer"

// The sessions list's virtualizer over the page scroller, on @tanstack/virtual-core, measuring
// every mounted row.

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

export const keysValue = (keys: ReadonlyArray<string>): string => Arr.join(keys, "\n")

const sameWindow = (a: VirtualWindow, b: VirtualWindow): boolean =>
	a.totalSize === b.totalSize && a.scrollMargin === b.scrollMargin && sameRows(a.rows, b.rows)

/** Runs the virtualizer for the list element; every window change becomes `toMessage(window)`. */
export const virtualizeSessions = <A>(
	list: HTMLElement,
	toMessage: (window: VirtualWindow) => A,
): Stream.Stream<A> =>
	virtualizerStream<A>((offer) => {
		const scroller = pageScrollerOf(list)
		const keysOf = () => splitAttribute(list, KEYS_ATTRIBUTE, "\n")
		const state = { keys: keysOf(), scrollMargin: 0, last: emptyWindow, isMeasuring: false }
		const emit = (instance: Instance) => {
			const next: VirtualWindow = {
				rows: Arr.map(instance.getVirtualItems(), (item) => ({
					index: item.index,
					start: item.start,
					end: item.end,
				})),
				totalSize: instance.getTotalSize(),
				scrollMargin: state.scrollMargin,
			}
			if (sameWindow(next, state.last)) return
			state.last = next
			offer(toMessage(next))
		}
		// Every re-render, a measurement's or a scroll's, is batched to a microtask.
		const onChange = batchedOnChange(state, emit, false)
		const options = () => ({
			count: state.keys.length,
			getItemKey: (index: number) => state.keys[index] ?? String(index),
			getScrollElement: () => scroller,
			estimateSize: () => ESTIMATE,
			overscan: OVERSCAN,
			scrollMargin: state.scrollMargin,
			...DOM_OPTIONS,
			onChange,
		})
		const virtualizer: Instance = new Virtualizer<HTMLElement, HTMLElement>(options())
		const update = () => {
			virtualizer.setOptions(options())
			virtualizer._willUpdate()
			onChange(virtualizer, false)
		}
		const measureRows = () =>
			list
				.querySelectorAll<HTMLElement>(":scope > [data-index]")
				.forEach((node) => virtualizer.measureElement(node))
		const rowObserver = new MutationObserver(measureRows)
		rowObserver.observe(list, { childList: true })
		const keysObserver = new MutationObserver(() => {
			state.keys = keysOf()
			update()
		})
		keysObserver.observe(list, { attributes: true, attributeFilter: [`data-${KEYS_ATTRIBUTE}`] })
		const resizes = new ResizeObserver(() => {
			const margin = scrollMarginOf(list, scroller)
			if (margin === state.scrollMargin) return
			state.scrollMargin = margin
			update()
		})
		resizes.observe(list)
		resizes.observe(scroller)
		state.scrollMargin = scrollMarginOf(list, scroller)
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
	})

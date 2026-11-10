import { Virtualizer } from "@tanstack/virtual-core"
import { type Stream, Array as Arr } from "effect"
import { Mount } from "foldkit"
import {
	batchedOnChange,
	DOM_OPTIONS,
	type Instance,
	measureRow,
	rowMountObserver,
	sameRows,
	virtualizerStream,
	whileLive,
} from "@maple/views/lib/virtualizer"
import { Message } from "./message"
import type { VirtualRow } from "./model"

/** The scroller carries the row count, so the Mount sees every new page without re-mounting. */
export const COUNT_ATTRIBUTE = "trace-count"
const ROW_HEIGHT = 44
const OVERSCAN = 10

const rowsOf = (scroller: HTMLElement): ReadonlyArray<HTMLElement> =>
	Array.from(scroller.querySelectorAll<HTMLElement>("tbody > tr[data-index]"))

const countOf = (scroller: HTMLElement): number =>
	Number(scroller.getAttribute(`data-${COUNT_ATTRIBUTE}`) ?? "0")

type WindowMessage = typeof Message.ChangedVirtualWindow.Type

/** The virtualizer's running state between its measure and scroll callbacks. */
type VirtualizerState = {
	count: number
	rows: ReadonlyArray<VirtualRow>
	totalSize: number
	isMeasuring: boolean
}

/**
 * `useVirtualizer` from `TracesTableView` on @tanstack/virtual-core: the same estimate, overscan
 * and measuring of every mounted row (`VirtualTableBody`'s `measureRef`). Changes raised
 * while measuring are batched to a microtask; a scroll renders synchronously.
 */
const virtualize = (scroller: HTMLElement): Stream.Stream<WindowMessage> =>
	virtualizerStream<WindowMessage>((offer) => {
		const state: VirtualizerState = {
			count: countOf(scroller),
			rows: [],
			totalSize: -1,
			isMeasuring: false,
		}
		const emitWindow = (instance: Instance) => {
			const rows = Arr.map(instance.getVirtualItems(), (item) => ({
				index: item.index,
				start: item.start,
				end: item.end,
			}))
			const totalSize = instance.getTotalSize()
			if (totalSize === state.totalSize && sameRows(rows, state.rows)) return
			state.rows = rows
			state.totalSize = totalSize
			offer(Message.ChangedVirtualWindow({ rows, totalSize }))
		}
		const onChange = batchedOnChange(state, emitWindow)
		const options = () => ({
			count: state.count,
			getScrollElement: () => scroller,
			estimateSize: () => ROW_HEIGHT,
			overscan: OVERSCAN,
			...DOM_OPTIONS,
			onChange,
		})
		const virtualizer: Instance = new Virtualizer<HTMLElement, HTMLElement>(options())
		const measure = measureRow(state, virtualizer)
		const rowObserver = rowMountObserver(virtualizer, measure)
		const observeBody = () => {
			const body = scroller.querySelector("tbody")
			if (body !== null) rowObserver.observe(body, { childList: true })
		}
		const countObserver = new MutationObserver(() => {
			state.count = countOf(scroller)
			virtualizer.setOptions(options())
			rowObserver.disconnect()
			observeBody()
			virtualizer._willUpdate()
			emitWindow(virtualizer)
		})
		countObserver.observe(scroller, { attributes: true, attributeFilter: [`data-${COUNT_ATTRIBUTE}`] })

		observeBody()
		Arr.forEach(rowsOf(scroller), measure)
		const unmount = virtualizer._didMount()
		virtualizer._willUpdate()
		emitWindow(virtualizer)
		return () => {
			countObserver.disconnect()
			rowObserver.disconnect()
			unmount()
		}
	})

export const VirtualizeTraces = Mount.defineStream("VirtualizeTraces", {
	messages: [Message.ChangedVirtualWindow],
	execute: ({ element, viewStateChanges }) => whileLive(element, viewStateChanges, virtualize),
})

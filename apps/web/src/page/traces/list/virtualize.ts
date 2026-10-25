import { elementScroll, observeElementOffset, observeElementRect, Virtualizer } from "@tanstack/virtual-core"
import { Effect, Queue, Stream } from "effect"
import { Mount } from "foldkit"
import { Message } from "./message"
import type { VirtualRow } from "./model"

/** The scroller carries the row count, so the Mount sees every new page without re-mounting. */
export const COUNT_ATTRIBUTE = "trace-count"
const ROW_HEIGHT = 44
const OVERSCAN = 10

const sameRows = (a: ReadonlyArray<VirtualRow>, b: ReadonlyArray<VirtualRow>): boolean =>
	a.length === b.length &&
	a.every((row, i) => row.index === b[i]?.index && row.start === b[i]?.start && row.end === b[i]?.end)

const rowsOf = (scroller: HTMLElement): ReadonlyArray<HTMLElement> =>
	Array.from(scroller.querySelectorAll<HTMLElement>("tbody > tr[data-index]"))

const countOf = (scroller: HTMLElement): number =>
	Number(scroller.getAttribute(`data-${COUNT_ATTRIBUTE}`) ?? "0")

type WindowMessage = typeof Message.ChangedVirtualWindow.Type

/**
 * `useVirtualizer` from `TracesTableView` on @tanstack/virtual-core: the same estimate, overscan
 * and measuring of every mounted row (`VirtualTableBody`'s `measureRef`). Changes raised
 * while measuring are batched to a microtask; a scroll renders synchronously.
 */
/** The virtualizer's running state between its measure and scroll callbacks. */
type VirtualizerState = {
	count: number
	rows: ReadonlyArray<VirtualRow>
	totalSize: number
	isMeasuring: boolean
	isEmitScheduled: boolean
}

const virtualize = (scroller: HTMLElement): Stream.Stream<WindowMessage> =>
	Stream.callback<WindowMessage>((queue) =>
		Effect.acquireRelease(
			Effect.sync(() => {
				const state: VirtualizerState = {
					count: countOf(scroller),
					rows: [],
					totalSize: -1,
					isMeasuring: false,
					isEmitScheduled: false,
				}
				const emitWindow = (instance: Virtualizer<HTMLElement, HTMLElement>) => {
					const rows = instance
						.getVirtualItems()
						.map((item) => ({ index: item.index, start: item.start, end: item.end }))
					const totalSize = instance.getTotalSize()
					if (totalSize === state.totalSize && sameRows(rows, state.rows)) return
					state.rows = rows
					state.totalSize = totalSize
					Queue.offerUnsafe(queue, Message.ChangedVirtualWindow({ rows, totalSize }))
				}
				const options = () => ({
					count: state.count,
					getScrollElement: () => scroller,
					estimateSize: () => ROW_HEIGHT,
					overscan: OVERSCAN,
					observeElementRect,
					observeElementOffset,
					scrollToFn: elementScroll,
					onChange: (instance: Virtualizer<HTMLElement, HTMLElement>, sync: boolean) => {
						if (sync && !state.isMeasuring) return emitWindow(instance)
						if (state.isEmitScheduled) return
						state.isEmitScheduled = true
						queueMicrotask(() => {
							state.isEmitScheduled = false
							emitWindow(instance)
						})
					},
				})
				const virtualizer = new Virtualizer<HTMLElement, HTMLElement>(options())
				const measure = (node: HTMLElement) => {
					state.isMeasuring = true
					virtualizer.measureElement(node)
					state.isMeasuring = false
				}
				const rowObserver = new MutationObserver((records) => {
					if (records.some((record) => record.removedNodes.length > 0))
						virtualizer.measureElement(null)
					records.forEach((record) =>
						record.addedNodes.forEach((node) => {
							if (node instanceof HTMLElement && node.hasAttribute("data-index")) measure(node)
						}),
					)
				})
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
				countObserver.observe(scroller, {
					attributes: true,
					attributeFilter: [`data-${COUNT_ATTRIBUTE}`],
				})

				observeBody()
				rowsOf(scroller).forEach(measure)
				const unmount = virtualizer._didMount()
				virtualizer._willUpdate()
				emitWindow(virtualizer)
				return () => {
					countObserver.disconnect()
					rowObserver.disconnect()
					unmount()
				}
			}),
			(cleanup) => Effect.sync(cleanup),
		).pipe(Effect.flatMap(() => Effect.never)),
	)

export const VirtualizeTraces = Mount.defineStream("VirtualizeTraces", {
	messages: [Message.ChangedVirtualWindow],
	execute: ({ element, viewStateChanges }) =>
		viewStateChanges.pipe(
			Stream.switchMap((viewState) =>
				viewState === "Live" && element instanceof HTMLElement ? virtualize(element) : Stream.never,
			),
		),
})

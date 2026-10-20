import { elementScroll, observeElementOffset, observeElementRect, Virtualizer } from "@tanstack/virtual-core"
import { Effect, Queue, Schema, Stream } from "effect"
import { Command, Mount } from "foldkit"
import { Message, type VirtualRow } from "./logs-stream-message"

/**
 * The stream's scroller carries its virtualizer inputs as attributes, so the Mount sees every
 * change the view makes (row count, wrap, density) without being re-mounted.
 */
export const STREAM_ATTRIBUTE = "log-stream"
export const COUNT_ATTRIBUTE = "log-stream-count"
export const LAYOUT_ATTRIBUTE = "log-stream-layout"
const SCROLL_EVENT = "maple:log-stream-scroll"

const ROW_HEIGHT = 30
const ROW_HEIGHT_COMFORTABLE = 42

interface Layout {
	readonly count: number
	readonly wrap: boolean
	readonly comfortable: boolean
}

const readLayout = (scroller: HTMLElement): Layout => {
	const layout = scroller.getAttribute(`data-${LAYOUT_ATTRIBUTE}`) ?? ""
	return {
		count: Number(scroller.getAttribute(`data-${COUNT_ATTRIBUTE}`) ?? "0"),
		wrap: layout.includes("wrap") && !layout.includes("nowrap"),
		comfortable: layout.includes("comfortable"),
	}
}

const sameRows = (a: ReadonlyArray<VirtualRow>, b: ReadonlyArray<VirtualRow>): boolean =>
	a.length === b.length && a.every((row, i) => row.index === b[i]?.index && row.start === b[i]?.start)

const rowsOf = (scroller: HTMLElement): ReadonlyArray<HTMLElement> =>
	Array.from(scroller.querySelectorAll<HTMLElement>("[role='log'] > [data-index]"))

/**
 * The logs table's virtualizer on @tanstack/virtual-core: an adaptive row estimate and measuring
 * of every mounted row. The window
 * reaches the Model only when it changes, not on every scroll event.
 */
type VirtualizeMessage = typeof Message.ChangedVirtualWindow.Type | typeof Message.ChangedScrolledAway.Type

const virtualize = (scroller: HTMLElement): Stream.Stream<VirtualizeMessage> =>
	Stream.callback<VirtualizeMessage>((queue) =>
		Effect.acquireRelease(
			Effect.sync(() => {
				const state = {
					layout: readLayout(scroller),
					sizeSum: 0,
					sizeByIndex: new Map<number, number>(),
					rows: [] as ReadonlyArray<VirtualRow>,
					totalSize: -1,
					isScrolledAway: false,
					isMeasuring: false,
					isEmitScheduled: false,
				}
				const estimateSize = () => {
					if (state.sizeByIndex.size >= 8) return Math.round(state.sizeSum / state.sizeByIndex.size)
					if (state.layout.wrap) return state.layout.comfortable ? 88 : 72
					return state.layout.comfortable ? ROW_HEIGHT_COMFORTABLE : ROW_HEIGHT
				}
				const emitWindow = (instance: Virtualizer<HTMLElement, HTMLElement>) => {
					const rows = instance
						.getVirtualItems()
						.map((item) => ({ index: item.index, start: item.start }))
					const totalSize = instance.getTotalSize()
					if (totalSize === state.totalSize && sameRows(rows, state.rows)) return
					state.rows = rows
					state.totalSize = totalSize
					Queue.offerUnsafe(queue, Message.ChangedVirtualWindow({ rows, totalSize }))
				}
				const options = () => ({
					count: state.layout.count,
					getScrollElement: () => scroller,
					estimateSize,
					overscan: state.layout.wrap ? 6 : 12,
					observeElementRect,
					observeElementOffset,
					scrollToFn: elementScroll,
					// A scroll emits synchronously; every other change, including those raised while rows are
					// measured, is batched until the measuring is done.
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

				// Measure, then feed the adaptive estimate.
				const measure = (node: HTMLElement) => {
					state.isMeasuring = true
					virtualizer.measureElement(node)
					state.isMeasuring = false
					const index = Number(node.dataset.index)
					if (
						!Number.isInteger(index) ||
						node.firstElementChild?.hasAttribute("data-expanded") === true
					)
						return
					const height = node.offsetHeight
					if (height <= 0) return
					const previous = state.sizeByIndex.get(index)
					if (previous === height) return
					state.sizeSum += height - (previous ?? 0)
					state.sizeByIndex.set(index, height)
				}

				const rowObserver = new MutationObserver((records) => {
					const removed = records.some((record) => record.removedNodes.length > 0)
					if (removed) virtualizer.measureElement(null)
					records.forEach((record) =>
						record.addedNodes.forEach((node) => {
							if (node instanceof HTMLElement && node.hasAttribute("data-index")) measure(node)
						}),
					)
				})
				const observeLog = () => {
					const log = scroller.querySelector("[role='log']")
					if (log !== null) rowObserver.observe(log, { childList: true })
				}

				// A count change re-reads options; a wrap or density change also drops every measurement.
				const layoutObserver = new MutationObserver(() => {
					const next = readLayout(scroller)
					const relayout =
						next.wrap !== state.layout.wrap || next.comfortable !== state.layout.comfortable
					state.layout = next
					virtualizer.setOptions(options())
					// The window is read before rows re-measure: only the rows
					// that window keeps (overscan shrinks when wrapping) are measured, against the old sizes.
					const kept = new Set(virtualizer.getVirtualItems().map((item) => item.index))
					rowObserver.disconnect()
					observeLog()
					if (relayout) {
						state.sizeSum = 0
						state.sizeByIndex = new Map()
						virtualizer.measure()
						rowsOf(scroller)
							.filter((row) => kept.has(Number(row.dataset.index)))
							.forEach(measure)
					}
					virtualizer._willUpdate()
					emitWindow(virtualizer)
				})
				layoutObserver.observe(scroller, {
					attributes: true,
					attributeFilter: [`data-${COUNT_ATTRIBUTE}`, `data-${LAYOUT_ATTRIBUTE}`],
				})

				const onScroll = () => {
					const isScrolledAway = scroller.scrollTop > 0
					if (isScrolledAway === state.isScrolledAway) return
					state.isScrolledAway = isScrolledAway
					Queue.offerUnsafe(queue, Message.ChangedScrolledAway({ isScrolledAway }))
				}
				scroller.addEventListener("scroll", onScroll, { passive: true })

				const onScrollRequest = (event: Event) => {
					const index = event instanceof CustomEvent ? Number(event.detail) : Number.NaN
					if (Number.isInteger(index) && index >= 0)
						virtualizer.scrollToIndex(index, { align: "auto" })
					else scroller.scrollTo({ top: 0 })
				}
				scroller.addEventListener(SCROLL_EVENT, onScrollRequest)

				observeLog()
				rowsOf(scroller).forEach(measure)
				const unmount = virtualizer._didMount()
				virtualizer._willUpdate()
				emitWindow(virtualizer)

				return () => {
					scroller.removeEventListener(SCROLL_EVENT, onScrollRequest)
					scroller.removeEventListener("scroll", onScroll)
					layoutObserver.disconnect()
					rowObserver.disconnect()
					unmount()
				}
			}),
			(cleanup) => Effect.sync(cleanup),
		).pipe(Effect.flatMap(() => Effect.never)),
	)

export const VirtualizeLogStream = Mount.defineStream("VirtualizeLogStream", {
	messages: [Message.ChangedVirtualWindow, Message.ChangedScrolledAway],
	execute: ({ element, viewStateChanges }) =>
		viewStateChanges.pipe(
			Stream.switchMap((viewState) =>
				viewState === "Live" && element instanceof HTMLElement ? virtualize(element) : Stream.never,
			),
		),
})

const scrollerOf = (streamId: string): HTMLElement | null =>
	document.querySelector<HTMLElement>(`[data-${STREAM_ATTRIBUTE}="${CSS.escape(streamId)}"]`)

/** Keeps a keyboard-focused row in view (`virtualizer.scrollToIndex(index, { align: "auto" })`). */
export const ScrollStreamToIndex = Command.define("ScrollStreamToIndex", {
	args: { streamId: Schema.String, index: Schema.Number },
	messages: [Message.CompletedScroll],
	execute: ({ streamId, index }) =>
		Effect.sync(() => {
			scrollerOf(streamId)?.dispatchEvent(new CustomEvent(SCROLL_EVENT, { detail: index }))
			return Message.CompletedScroll()
		}),
})

/** `useCopy`'s write. A refused clipboard (no permission, no focus) is not an error the stream shows. */
const writeClipboard = (text: string) =>
	Effect.tryPromise(() => navigator.clipboard.writeText(text)).pipe(
		Effect.ignore,
		Effect.as(Message.CompletedCopy()),
	)

export const CopyText = Command.define("CopyText", {
	args: { text: Schema.String },
	messages: [Message.CompletedCopy],
	execute: ({ text }) => writeClipboard(text),
})

/** `logPermalink`: the standalone `/logs/$logId` page on this origin. */
export const CopyLogLink = Command.define("CopyLogLink", {
	args: { logKey: Schema.String },
	messages: [Message.CompletedCopy],
	execute: ({ logKey }) => Effect.suspend(() => writeClipboard(`${window.location.origin}/logs/${logKey}`)),
})

/** Back to the newest rows. */
export const ScrollStreamToTop = Command.define("ScrollStreamToTop", {
	args: { streamId: Schema.String },
	messages: [Message.CompletedScroll],
	execute: ({ streamId }) =>
		Effect.sync(() => {
			scrollerOf(streamId)?.dispatchEvent(new CustomEvent(SCROLL_EVENT, { detail: -1 }))
			return Message.CompletedScroll()
		}),
})

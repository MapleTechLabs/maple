import { Virtualizer } from "@tanstack/virtual-core"
import { Effect, Schema, type Stream, Array as Arr, String as Str } from "effect"
import { Command, Mount } from "foldkit"
import {
	batchedOnChange,
	DOM_OPTIONS,
	type Instance,
	measureRow,
	rowMountObserver,
	sameRows,
	virtualizerStream,
	whileLive,
} from "../../lib/virtualizer"
import { writeClipboardApi } from "../copy-button"
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
		wrap: Str.includes("wrap")(layout) && !Str.includes("nowrap")(layout),
		comfortable: Str.includes("comfortable")(layout),
	}
}

const rowsOf = (scroller: HTMLElement): ReadonlyArray<HTMLElement> =>
	Array.from(scroller.querySelectorAll<HTMLElement>("[role='log'] > [data-index]"))

/**
 * The logs table's virtualizer on @tanstack/virtual-core: an adaptive row estimate and measuring
 * of every mounted row. The window
 * reaches the Model only when it changes, not on every scroll event.
 */
const VirtualizeMessage = Schema.Union([Message.ChangedVirtualWindow, Message.ChangedScrolledAway])
type VirtualizeMessage = typeof VirtualizeMessage.Type

type VirtualizerState = {
	layout: Layout
	sizeSum: number
	sizeByIndex: Map<number, number>
	rows: ReadonlyArray<VirtualRow>
	totalSize: number
	isScrolledAway: boolean
	isMeasuring: boolean
}

const virtualize = (scroller: HTMLElement): Stream.Stream<VirtualizeMessage> =>
	virtualizerStream<VirtualizeMessage>((offer) => {
		const state: VirtualizerState = {
			layout: readLayout(scroller),
			sizeSum: 0,
			sizeByIndex: new Map<number, number>(),
			rows: [],
			totalSize: -1,
			isScrolledAway: false,
			isMeasuring: false,
		}
		const estimateSize = () => {
			if (state.sizeByIndex.size >= 8) return Math.round(state.sizeSum / state.sizeByIndex.size)
			if (state.layout.wrap) return state.layout.comfortable ? 88 : 72
			return state.layout.comfortable ? ROW_HEIGHT_COMFORTABLE : ROW_HEIGHT
		}
		const emitWindow = (instance: Instance) => {
			const rows = Arr.map(instance.getVirtualItems(), (item) => ({
				index: item.index,
				start: item.start,
			}))
			const totalSize = instance.getTotalSize()
			if (totalSize === state.totalSize && sameRows(rows, state.rows)) return
			state.rows = rows
			state.totalSize = totalSize
			offer(Message.ChangedVirtualWindow({ rows, totalSize }))
		}
		// A scroll emits synchronously; every other change, including those raised while rows are
		// measured, is batched until the measuring is done.
		const onChange = batchedOnChange(state, emitWindow)
		const options = () => ({
			count: state.layout.count,
			getScrollElement: () => scroller,
			estimateSize,
			overscan: state.layout.wrap ? 6 : 12,
			...DOM_OPTIONS,
			onChange,
		})
		const virtualizer: Instance = new Virtualizer<HTMLElement, HTMLElement>(options())
		const measureOnly = measureRow(state, virtualizer)

		// Measure, then feed the adaptive estimate.
		const measure = (node: HTMLElement) => {
			measureOnly(node)
			const index = Number(node.dataset.index)
			if (!Number.isInteger(index) || node.firstElementChild?.hasAttribute("data-expanded") === true)
				return
			const height = node.offsetHeight
			if (height <= 0) return
			const previous = state.sizeByIndex.get(index)
			if (previous === height) return
			state.sizeSum += height - (previous ?? 0)
			state.sizeByIndex.set(index, height)
		}

		const rowObserver = rowMountObserver(virtualizer, measure)
		const observeLog = () => {
			const log = scroller.querySelector("[role='log']")
			if (log !== null) rowObserver.observe(log, { childList: true })
		}

		// A count change re-reads options; a wrap or density change also drops every measurement.
		const layoutObserver = new MutationObserver(() => {
			const next = readLayout(scroller)
			const relayout = next.wrap !== state.layout.wrap || next.comfortable !== state.layout.comfortable
			state.layout = next
			virtualizer.setOptions(options())
			// The window is read before rows re-measure: only the rows
			// that window keeps (overscan shrinks when wrapping) are measured, against the old sizes.
			const kept = new Set(Arr.map(virtualizer.getVirtualItems(), (item) => item.index))
			rowObserver.disconnect()
			observeLog()
			if (relayout) {
				state.sizeSum = 0
				state.sizeByIndex = new Map()
				virtualizer.measure()
				Arr.forEach(
					Arr.filter(rowsOf(scroller), (row) => kept.has(Number(row.dataset.index))),
					measure,
				)
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
			offer(Message.ChangedScrolledAway({ isScrolledAway }))
		}
		scroller.addEventListener("scroll", onScroll, { passive: true })

		const onScrollRequest = (event: Event) => {
			const index = event instanceof CustomEvent ? Number(event.detail) : Number.NaN
			if (Number.isInteger(index) && index >= 0) virtualizer.scrollToIndex(index, { align: "auto" })
			else scroller.scrollTo({ top: 0 })
		}
		scroller.addEventListener(SCROLL_EVENT, onScrollRequest)

		observeLog()
		Arr.forEach(rowsOf(scroller), measure)
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
	})

export const VirtualizeLogStream = Mount.defineStream("VirtualizeLogStream", {
	messages: [Message.ChangedVirtualWindow, Message.ChangedScrolledAway],
	execute: ({ element, viewStateChanges }) => whileLive(element, viewStateChanges, virtualize),
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
	writeClipboardApi(text).pipe(Effect.ignore, Effect.as(Message.CompletedCopy()))

export const CopyText = Command.define("CopyText", {
	args: { text: Schema.String },
	messages: [Message.CompletedCopy],
	execute: ({ text }) => writeClipboard(text),
})

/** The row's own log page on this origin. */
export const CopyLogLink = Command.define("CopyLogLink", {
	args: { href: Schema.String },
	messages: [Message.CompletedCopy],
	execute: ({ href }) => Effect.suspend(() => writeClipboard(`${window.location.origin}${href}`)),
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

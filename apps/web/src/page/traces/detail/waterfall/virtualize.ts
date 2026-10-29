import { elementScroll, observeElementOffset, observeElementRect, Virtualizer } from "@tanstack/virtual-core"
import { Effect, Queue, Stream } from "effect"
import { WaterfallDefinition } from "./definition"
import { Message, type VirtualRow } from "./model"

/** The scroller carries the visible rows' span ids and the selection, so the Mount sees each change. */
export const KEYS_ATTRIBUTE = "waterfall-keys"
export const SELECTED_ATTRIBUTE = "waterfall-selected"

/** Estimated row height; measured rows replace it. */
export const ROW_HEIGHT = 33
const OVERSCAN = 12
const MAX_SCROLL_ATTEMPTS = 15

const keysOf = (scroller: HTMLElement): ReadonlyArray<string> => {
	const raw = scroller.getAttribute(`data-${KEYS_ATTRIBUTE}`) ?? ""
	return raw === "" ? [] : raw.split(" ")
}

const rowsOf = (scroller: HTMLElement): ReadonlyArray<HTMLElement> =>
	Array.from(scroller.querySelectorAll<HTMLElement>(":scope > div > [data-index]"))

const sameRows = (a: ReadonlyArray<VirtualRow>, b: ReadonlyArray<VirtualRow>): boolean =>
	a.length === b.length && a.every((row, i) => row.index === b[i]?.index && row.start === b[i]?.start)

type WindowMessage = typeof Message.ChangedVirtualWindow.Type
type Instance = Virtualizer<HTMLElement, HTMLElement>

/**
 * The scroll-to-selected effect of `SpanHierarchy`, verbatim: retry across frames, latch only once
 * a later frame sees the row in view. It stops on estimated row heights when the rows were not
 * measured first (a known race).
 */
const scrollToSelected = (
	scroller: HTMLElement,
	instance: Instance,
	index: number,
	onLatch: () => void,
	setHandle: (handle: number) => void,
): void => {
	const state = { attempts: 0 }
	const attempt = (): void => {
		if (scroller.clientHeight > 0) {
			const row = instance.getVirtualItems().find((item) => item.index === index)
			const start = row?.start ?? index * ROW_HEIGHT
			const end = row?.end ?? start + ROW_HEIGHT
			const viewTop = scroller.scrollTop
			const viewBottom = viewTop + scroller.clientHeight
			const isComfortablyVisible = start >= viewTop + ROW_HEIGHT && end <= viewBottom - ROW_HEIGHT
			if (row !== undefined && isComfortablyVisible) return onLatch()
			const target = Math.max(
				0,
				Math.min(
					start - (scroller.clientHeight - (end - start)) / 2,
					scroller.scrollHeight - scroller.clientHeight,
				),
			)
			if (Math.abs(viewTop - target) <= 1) {
				if (row !== undefined) return onLatch()
			} else {
				scroller.scrollTop = target
			}
		}
		state.attempts += 1
		if (state.attempts < MAX_SCROLL_ATTEMPTS) setHandle(requestAnimationFrame(attempt))
	}
	attempt()
}

interface Parts {
	readonly state: { keys: ReadonlyArray<string>; handle: number }
	readonly virtualizer: Instance
	readonly emitWindow: (instance: Instance) => void
	readonly options: () => ConstructorParameters<typeof Virtualizer<HTMLElement, HTMLElement>>[0]
	readonly measure: (node: HTMLElement) => void
	readonly runScrollEffect: () => void
}

/** Wires the observers: rows measured as they mount, keys and selection re-read on change. */
const attach = (scroller: HTMLElement, parts: Parts): (() => void) => {
	const { state, virtualizer } = parts
	const rowObserver = new MutationObserver((records) => {
		if (records.some((record) => record.removedNodes.length > 0)) virtualizer.measureElement(null)
		records.forEach((record) =>
			record.addedNodes.forEach((node) => {
				if (node instanceof HTMLElement && node.hasAttribute("data-index")) parts.measure(node)
			}),
		)
	})
	const observeBody = (): void => {
		const body = scroller.firstElementChild
		if (body !== null) rowObserver.observe(body, { childList: true })
	}
	const attributeObserver = new MutationObserver(() => {
		state.keys = keysOf(scroller)
		virtualizer.setOptions(parts.options())
		virtualizer._willUpdate()
		parts.emitWindow(virtualizer)
		queueMicrotask(parts.runScrollEffect)
	})
	attributeObserver.observe(scroller, {
		attributes: true,
		attributeFilter: [`data-${KEYS_ATTRIBUTE}`, `data-${SELECTED_ATTRIBUTE}`],
	})
	observeBody()
	rowsOf(scroller).forEach(parts.measure)
	const unmount = virtualizer._didMount()
	virtualizer._willUpdate()
	parts.emitWindow(virtualizer)
	queueMicrotask(parts.runScrollEffect)
	return () => {
		cancelAnimationFrame(state.handle)
		attributeObserver.disconnect()
		rowObserver.disconnect()
		unmount()
	}
}

/** The virtualizer's running state between its measure, scroll and scroll-to callbacks. */
type VirtualizerState = {
	keys: ReadonlyArray<string>
	rows: ReadonlyArray<VirtualRow>
	totalSize: number
	isMeasuring: boolean
	isEmitScheduled: boolean
	scrolledTo: string
	handle: number
}

/** `useVirtualizer` keyed by span id, measuring every mounted row, plus the scroll effect. */
const virtualize = (scroller: HTMLElement): Stream.Stream<WindowMessage> =>
	Stream.callback<WindowMessage>((queue) =>
		Effect.acquireRelease(
			Effect.sync(() => {
				const state: VirtualizerState = {
					keys: keysOf(scroller),
					rows: [],
					totalSize: -1,
					isMeasuring: false,
					isEmitScheduled: false,
					scrolledTo: "",
					handle: 0,
				}
				const emitWindow = (instance: Instance): void => {
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
					count: state.keys.length,
					getScrollElement: () => scroller,
					estimateSize: () => ROW_HEIGHT,
					getItemKey: (index: number) => state.keys[index] ?? index,
					overscan: OVERSCAN,
					observeElementRect,
					observeElementOffset,
					scrollToFn: elementScroll,
					onChange: (instance: Instance, sync: boolean) => {
						if (sync && !state.isMeasuring) return emitWindow(instance)
						if (state.isEmitScheduled) return
						state.isEmitScheduled = true
						queueMicrotask(() => {
							state.isEmitScheduled = false
							emitWindow(instance)
						})
					},
				})
				const virtualizer: Instance = new Virtualizer<HTMLElement, HTMLElement>(options())
				const measure = (node: HTMLElement): void => {
					state.isMeasuring = true
					virtualizer.measureElement(node)
					state.isMeasuring = false
				}
				// The effect's deps are the selection and the visible rows: re-run on either, unless latched.
				const runScrollEffect = (): void => {
					cancelAnimationFrame(state.handle)
					const selected = scroller.getAttribute(`data-${SELECTED_ATTRIBUTE}`) ?? ""
					if (selected === "" || selected === state.scrolledTo) return
					const index = state.keys.indexOf(selected)
					if (index === -1) return
					scrollToSelected(
						scroller,
						virtualizer,
						index,
						() => {
							state.scrolledTo = selected
						},
						(handle) => {
							state.handle = handle
						},
					)
				}
				return { state, virtualizer, emitWindow, options, measure, runScrollEffect }
			}).pipe(Effect.map((parts) => attach(scroller, parts))),
			(cleanup) => Effect.sync(cleanup),
		).pipe(Effect.flatMap(() => Effect.never)),
	)

export const VirtualizeWaterfall = WaterfallDefinition.makeMountStream("VirtualizeWaterfall", {
	messages: [Message.ChangedVirtualWindow],
	handler: function* () {
		return ({ element, viewStateChanges }) =>
			viewStateChanges.pipe(
				Stream.switchMap((viewState) =>
					viewState === "Live" && element instanceof HTMLElement ? virtualize(element) : Stream.never,
				),
			)
	},
})

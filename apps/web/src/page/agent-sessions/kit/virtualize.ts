import { elementScroll, observeElementOffset, observeElementRect, Virtualizer } from "@tanstack/virtual-core"
import { Effect, Queue, Schema, Stream } from "effect"
import type { HtmlBuilder } from "foldkit/html"

// `useVirtualizer` over the page scroller (`usePageScrollMargin`) on @tanstack/virtual-core, for the
// agent session list, waterfall and transcript. The list element carries the inputs as attributes,
// so the Mount sees every change without re-mounting; the window comes back as a Message.

const KEYS = "virtual-keys"
const ESTIMATES = "virtual-estimates"
const SCROLL = "virtual-scroll"

export const VirtualItem = Schema.Struct({ index: Schema.Number, start: Schema.Number, end: Schema.Number })
export type VirtualItem = typeof VirtualItem.Type

export const VirtualWindow = Schema.Struct({
	items: Schema.Array(VirtualItem),
	totalSize: Schema.Number,
	scrollMargin: Schema.Number,
})
export type VirtualWindow = typeof VirtualWindow.Type

export const emptyWindow: VirtualWindow = { items: [], totalSize: 0, scrollMargin: 0 }

/** A scroll the view asks for; `seq` makes a repeat of the same index a new request. */
export type ScrollRequest = Readonly<{
	seq: number
	index: number
	align: "auto" | "center"
	reveal: boolean
}>

export type VirtualConfig = Readonly<{
	overscan: number
	/** Rows are measured (`ref={virtualizer.measureElement}`); otherwise every row is its estimate. */
	isMeasured: boolean
	/** `directDomUpdates`: row transforms and the container height are written here, not rendered. */
	container?: string
	/** The mounted rows, relative to the list element. */
	rows: string
	isAnimationFrameResize?: boolean
}>

/** The attributes the list element carries for the Mount. */
export const virtualAttributes = <M>(
	h: HtmlBuilder<M>,
	keys: ReadonlyArray<string>,
	estimates: ReadonlyArray<number>,
	scroll?: ScrollRequest,
): ReadonlyArray<ReturnType<HtmlBuilder<M>["DataAttribute"]>> => [
	h.DataAttribute(KEYS, keys.join("\n")),
	h.DataAttribute(ESTIMATES, estimates.join(",")),
	...(scroll === undefined
		? []
		: [
				h.DataAttribute(
					SCROLL,
					`${scroll.seq}:${scroll.index}:${scroll.align}:${scroll.reveal ? 1 : 0}`,
				),
			]),
]

const keysOf = (list: HTMLElement): ReadonlyArray<string> => {
	const raw = list.getAttribute(`data-${KEYS}`) ?? ""
	return raw === "" ? [] : raw.split("\n")
}

const estimatesOf = (list: HTMLElement): ReadonlyArray<number> => {
	const raw = list.getAttribute(`data-${ESTIMATES}`) ?? ""
	return raw === "" ? [] : raw.split(",").map(Number)
}

const marginBetween = (list: HTMLElement, scroller: HTMLElement): number =>
	Math.max(
		0,
		Math.round(
			list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop,
		),
	)

const sameItems = (
	a: ReadonlyArray<VirtualItem>,
	b: ReadonlyArray<VirtualItem>,
	isIndexOnly: boolean,
): boolean =>
	a.length === b.length &&
	a.every(
		(item, i) =>
			item.index === b[i]?.index &&
			(isIndexOnly || (item.start === b[i]?.start && item.end === b[i]?.end)),
	)

const scrollOf = (list: HTMLElement): (ScrollRequest & { raw: string }) | undefined => {
	const raw = list.getAttribute(`data-${SCROLL}`)
	if (raw === null) return undefined
	const [seq, index, align, reveal] = raw.split(":")
	return {
		raw,
		seq: Number(seq),
		index: Number(index),
		align: align === "center" ? "center" : "auto",
		reveal: reveal === "1",
	}
}

type Instance = Virtualizer<HTMLElement, HTMLElement>

type State = {
	keys: ReadonlyArray<string>
	estimates: ReadonlyArray<number>
	scrollMargin: number
	last: VirtualWindow
	lastScroll: string
	lastSize: number
	positions: WeakMap<HTMLElement, number>
	isMeasuring: boolean
	isScheduled: boolean
}

/** `directDomUpdates`' `applyDirectStyles`: the container's height and each row's offset. */
const applyDirect = (instance: Instance, state: State, container: HTMLElement | null) => {
	if (container === null) return
	const totalSize = instance.getTotalSize()
	if (totalSize !== state.lastSize) {
		state.lastSize = totalSize
		container.style.height = `${totalSize}px`
	}
	instance.getVirtualItems().forEach((item) => {
		const element = instance.elementsCache.get(item.key)
		const next = item.start - state.scrollMargin
		if (element === undefined || state.positions.get(element) === next) return
		state.positions.set(element, next)
		element.style.transform = `translate3d(0, ${next}px, 0)`
	})
}

const windowOf = (instance: Instance, state: State, isDirect: boolean): VirtualWindow => ({
	items: instance
		.getVirtualItems()
		.map((item) => ({ index: item.index, start: item.start, end: item.end })),
	totalSize: isDirect ? 0 : instance.getTotalSize(),
	scrollMargin: state.scrollMargin,
})

const isSameWindow = (a: VirtualWindow, b: VirtualWindow, isDirect: boolean): boolean =>
	a.totalSize === b.totalSize && a.scrollMargin === b.scrollMargin && sameItems(a.items, b.items, isDirect)

const setUp = (
	list: HTMLElement,
	config: VirtualConfig,
	offer: (window: VirtualWindow) => void,
): (() => void) => {
	const scroller = list.closest<HTMLElement>('[data-slot="page-scroll-area"]') ?? list
	const container =
		config.container === undefined ? null : list.querySelector<HTMLElement>(config.container)
	const isDirect = container !== null
	const state: State = {
		keys: keysOf(list),
		estimates: estimatesOf(list),
		scrollMargin: marginBetween(list, scroller),
		last: emptyWindow,
		lastScroll: "",
		lastSize: -1,
		positions: new WeakMap(),
		isMeasuring: false,
		isScheduled: false,
	}
	const emit = (instance: Instance) => {
		const next = windowOf(instance, state, isDirect)
		if (isSameWindow(next, state.last, isDirect)) return
		state.last = next
		offer(next)
	}
	// The re-render a measurement raises is batched to a microtask; a scroll flushes.
	const onChange = (instance: Instance, sync: boolean) => {
		applyDirect(instance, state, container)
		if (sync && !state.isMeasuring) return emit(instance)
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
		estimateSize: (index: number) => state.estimates[index] ?? state.estimates[0] ?? 40,
		overscan: config.overscan,
		scrollMargin: state.scrollMargin,
		useAnimationFrameWithResizeObserver: config.isAnimationFrameResize === true,
		observeElementRect,
		observeElementOffset,
		scrollToFn: elementScroll,
		onChange,
	})
	const virtualizer: Instance = new Virtualizer<HTMLElement, HTMLElement>(options())
	const update = () => {
		virtualizer.setOptions(options())
		virtualizer._willUpdate()
		onChange(virtualizer, false)
	}
	const measureRows = () => {
		if (config.isMeasured) {
			virtualizer.measureElement(null)
			state.isMeasuring = true
			list.querySelectorAll<HTMLElement>(config.rows).forEach((node) => {
				const key = state.keys[Number(node.getAttribute("data-index"))]
				if (key === undefined || virtualizer.elementsCache.get(key) !== node)
					virtualizer.measureElement(node)
			})
			state.isMeasuring = false
		}
		applyDirect(virtualizer, state, container)
	}
	const requestScroll = () => {
		const request = scrollOf(list)
		if (request === undefined || request.raw === state.lastScroll) return
		state.lastScroll = request.raw
		virtualizer.scrollToIndex(request.index, { align: request.align })
		if (!request.reveal) return
		// The waterfall's second aim: a frame later the row exists and can say where it is.
		requestAnimationFrame(() =>
			Array.from(list.querySelectorAll<HTMLElement>(config.rows))
				.find((row) => row.getAttribute("data-index") === String(request.index))
				?.scrollIntoView({ block: "center" }),
		)
	}
	// One observer for the inputs and the rows: a render that changes both must re-key before it
	// measures, or the new rows are measured under the old keys.
	const observer = new MutationObserver((records) => {
		const isInput = (record: MutationRecord) =>
			record.target === list &&
			record.type === "attributes" &&
			record.attributeName !== `data-${SCROLL}`
		if (records.some(isInput)) {
			state.keys = keysOf(list)
			state.estimates = estimatesOf(list)
			update()
		}
		if (records.some((record) => record.type === "childList")) measureRows()
		requestScroll()
	})
	observer.observe(list, {
		childList: true,
		subtree: true,
		attributes: true,
		attributeFilter: [`data-${KEYS}`, `data-${ESTIMATES}`, `data-${SCROLL}`],
	})
	const resizes = new ResizeObserver(() => {
		const margin = marginBetween(list, scroller)
		if (margin === state.scrollMargin) return
		state.scrollMargin = margin
		update()
	})
	resizes.observe(list)
	resizes.observe(scroller)
	const unmount = virtualizer._didMount()
	virtualizer._willUpdate()
	measureRows()
	emit(virtualizer)
	requestScroll()
	return () => {
		observer.disconnect()
		resizes.disconnect()
		unmount()
	}
}

/** Runs the virtualizer for `list` while it is mounted; every window change becomes `toMessage`. */
export const virtualize = <A>(
	list: HTMLElement,
	config: VirtualConfig,
	toMessage: (window: VirtualWindow) => A,
): Stream.Stream<A> =>
	Stream.callback<A>((queue) =>
		Effect.acquireRelease(
			Effect.sync(() => setUp(list, config, (window) => Queue.offerUnsafe(queue, toMessage(window)))),
			(cleanup) => Effect.sync(cleanup),
		).pipe(Effect.flatMap(() => Effect.never)),
	)

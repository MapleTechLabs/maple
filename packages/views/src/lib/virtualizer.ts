import { elementScroll, observeElementOffset, observeElementRect, Virtualizer } from "@tanstack/virtual-core"
import { Effect, Queue, Stream, Array as Arr, String as Str } from "effect"
import type { Mount } from "foldkit"

// The Foldkit mount of @tanstack/virtual-core every virtualized list shares (replays, traces, the
// waterfall, agent sessions, logs): the element carries the inputs as attributes, the virtualizer
// runs while the element is live, and the window it computes comes back as Messages. Each binding
// keeps its options (count or keys, estimate, overscan, scroll margin) and what it measures.

export type Instance = Virtualizer<HTMLElement, HTMLElement>

/** The DOM wiring every binding passes: element rect and offset observers, element scroll. */
export const DOM_OPTIONS = { observeElementRect, observeElementOffset, scrollToFn: elementScroll } as const

/** Runs `setUp` while the stream is read; what it offers is emitted, and its return tears it down. */
export const virtualizerStream = <A>(setUp: (offer: (message: A) => void) => () => void): Stream.Stream<A> =>
	Stream.callback<A>((queue) =>
		Effect.acquireRelease(
			Effect.sync(() => setUp((message) => Queue.offerUnsafe(queue, message))),
			(cleanup) => Effect.sync(cleanup),
		).pipe(Effect.flatMap(() => Effect.never)),
	)

/** A Mount's stream: `run` on its element while the view is live (not a time-travel view). */
export const whileLive = <A>(
	element: Element,
	viewStateChanges: Stream.Stream<Mount.ViewState>,
	run: (element: HTMLElement) => Stream.Stream<A>,
): Stream.Stream<A> =>
	viewStateChanges.pipe(
		Stream.switchMap((viewState) =>
			viewState === "Live" && element instanceof HTMLElement ? run(element) : Stream.never,
		),
	)

/**
 * `onChange`: a scroll emits at once; a change raised while rows are measured is batched to a
 * microtask. With `isScrollSync: false` every change is batched.
 */
export const batchedOnChange = (
	state: { readonly isMeasuring: boolean },
	emit: (instance: Instance) => void,
	isScrollSync = true,
): ((instance: Instance, sync: boolean) => void) => {
	const flags = { isScheduled: false }
	return (instance, sync) => {
		if (isScrollSync && sync && !state.isMeasuring) return emit(instance)
		if (flags.isScheduled) return
		flags.isScheduled = true
		queueMicrotask(() => {
			flags.isScheduled = false
			emit(instance)
		})
	}
}

/** Measures one row, flagged so the change the measurement raises is batched. */
export const measureRow =
	(state: { isMeasuring: boolean }, virtualizer: Instance) =>
	(node: HTMLElement): void => {
		state.isMeasuring = true
		virtualizer.measureElement(node)
		state.isMeasuring = false
	}

/** Measures each row (`data-index`) as it mounts; a removal first drops detached rows. */
export const rowMountObserver = (
	virtualizer: Instance,
	measure: (node: HTMLElement) => void,
): MutationObserver =>
	new MutationObserver((records) => {
		if (Arr.some(records, (record) => record.removedNodes.length > 0)) virtualizer.measureElement(null)
		Arr.forEach(records, (record) =>
			record.addedNodes.forEach((node) => {
				if (node instanceof HTMLElement && node.hasAttribute("data-index")) measure(node)
			}),
		)
	})

/** A list attribute holding several values, split; absent or empty is none. */
export const splitAttribute = (
	element: HTMLElement,
	name: string,
	separator: string,
): ReadonlyArray<string> => {
	const raw = element.getAttribute(`data-${name}`) ?? ""
	return raw === "" ? [] : Str.split(separator)(raw)
}

/** The page scroller a list virtualizes against, or the list itself. */
export const pageScrollerOf = (list: HTMLElement): HTMLElement =>
	list.closest<HTMLElement>('[data-slot="page-scroll-area"]') ?? list

/** The list's offset inside the scroller: the virtualizer's `scrollMargin`. */
export const scrollMarginOf = (list: HTMLElement, scroller: HTMLElement): number =>
	Math.max(
		0,
		Math.round(
			list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop,
		),
	)

type Row = Readonly<{ index: number; start: number; end?: number }>

/** Whether two windows hold the same rows at the same offsets (`end` too, where rows carry it). */
export const sameRows = (a: ReadonlyArray<Row>, b: ReadonlyArray<Row>): boolean =>
	a.length === b.length &&
	Arr.every(a, (row, i) => row.index === b[i]?.index && row.start === b[i]?.start && row.end === b[i]?.end)

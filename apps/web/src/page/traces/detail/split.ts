import { Effect, Queue, Stream } from "effect"
import { Mount } from "foldkit"
import { Message } from "./message"

// The trace / span-panel split. Its sizes are the bare numbers react-resizable-panels 4 reads
// as pixels: `defaultSize` 60 and 40, `minSize` 40 and 25. Its layout is those pixels as percents of
// the group's panel width, scaled to sum to 100 (`jn`, then `ge`), each rounded to 3 decimals.

const round3 = (value: number): number => Number.parseFloat(value.toFixed(3))

const DEFAULT_PX = [60, 40] as const
const HANDLE_PX = 1

/** The group's layout for one or two panels, given the group's content width. */
export const splitLayout = (panelCount: number, groupWidth: number | null): ReadonlyArray<number> => {
	if (panelCount < 2) return [100]
	if (groupWidth === null) return [60, 40]
	const available = groupWidth - HANDLE_PX
	const defaults = DEFAULT_PX.map((px) => round3((px / available) * 100))
	const sum = defaults.reduce((total, size) => total + size, 0)
	return defaults.map((size) => round3((100 / sum) * size))
}

const groupOf = (element: Element): HTMLElement | null =>
	element.querySelector<HTMLElement>("[data-slot='resizable-panel-group']")

/** Reports the split group's content width whenever it changes. */
export const MeasureSplit = Mount.defineStream("MeasureTraceSplit", {
	messages: [Message.MeasuredSplitWidth],
	execute: ({ element }) =>
		Stream.callback<typeof Message.MeasuredSplitWidth.Type>((queue) =>
			Effect.acquireRelease(
				Effect.sync(() => {
					const state = { width: -1 }
					const report = () => {
						const group = groupOf(element)
						const width = group?.clientWidth ?? -1
						if (width <= 0 || width === state.width) return
						state.width = width
						Queue.offerUnsafe(queue, Message.MeasuredSplitWidth({ width }))
					}
					const observer = new ResizeObserver(report)
					observer.observe(element)
					report()
					return observer
				}),
				(observer) => Effect.sync(() => observer.disconnect()),
			).pipe(Effect.flatMap(() => Effect.never)),
		),
})

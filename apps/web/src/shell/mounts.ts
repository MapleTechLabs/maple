import { Array as Arr, Effect, Queue, Schema, Stream } from "effect"
import { Dom, Mount } from "foldkit"
import { Align, measurePosition, Side } from "@maple/views/ui/anchor"
import { applyScrollOverflow } from "@maple/views/ui/scroll-area"
import { containSearchKeys } from "./namespace-search"
import { Menu, Message } from "./message"

/**
 * Positions an open menu's positioner against its trigger (Base UI's anchor positioning), on
 * insert and on every viewport resize, and moves focus into the popup like Base UI on open.
 */
export const PositionMenu = Mount.defineStream("PositionMenu", {
	args: {
		menu: Menu,
		triggerId: Schema.String,
		popupId: Schema.String,
		side: Side,
		align: Align,
		sideOffset: Schema.Number,
	},
	messages: [Message.MeasuredMenuPopup],
	execute: ({ element, menu, triggerId, popupId, side, align, sideOffset }) => {
		const measure = () => {
			const position = measurePosition(element, triggerId, { side, align, sideOffset, alignOffset: 0 })
			return position === undefined
				? Stream.empty
				: Stream.succeed(Message.MeasuredMenuPopup({ menu, position }))
		}
		const initial = Stream.suspend(() => {
			const popup = element.ownerDocument.getElementById(popupId)
			// An `autoFocus` field inside (the namespace search) keeps the focus it took.
			if (popup instanceof HTMLElement && !popup.contains(element.ownerDocument.activeElement))
				popup.focus({ preventScroll: true })
			return measure()
		})
		const resized = Dom.streamFromEvent({
			target: window,
			type: "resize",
			mapEvent: () => undefined,
		}).pipe(Stream.flatMap(measure))
		return Stream.concat(initial, resized)
	},
})

/** The namespace menu's search input: focused as it mounts, its keys kept from the menu. */
export const MountNamespaceSearch = Mount.defineStream("MountNamespaceSearch", {
	messages: [Message.CompletedMountNamespaceSearch],
	execute: ({ element }) =>
		Stream.callback<typeof Message.CompletedMountNamespaceSearch.Type>((queue) =>
			containSearchKeys(element).pipe(
				Effect.andThen(
					Effect.sync(() => Queue.offerUnsafe(queue, Message.CompletedMountNamespaceSearch())),
				),
				Effect.andThen(Effect.never),
			),
		),
})

/** The sidebar nav's `ScrollArea` overflow (its bottom fade), kept current on scroll and resize. */
/**
 * Scrolls the nav so the open section (its row and every sub-item) clears the pinned footer, or
 * the active row alone when the section is taller than the nav.
 */
const revealActiveRow = (viewport: HTMLElement): void => {
	const rows = viewport.querySelectorAll<HTMLElement>('[data-active="true"]')
	const row = rows.item(rows.length - 1)
	if (row === null) return
	const section = row.closest<HTMLElement>('[data-sidebar="menu-item"]') ?? row
	// Past the scroll area's 1.5rem edge fades, so the last sub-item reads at full strength.
	const margin = 28
	const target = section.offsetHeight + 2 * margin <= viewport.clientHeight ? section : row
	const top = target.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop
	const bottom = top + target.offsetHeight
	if (top < viewport.scrollTop + margin) viewport.scrollTop = Math.max(0, top - margin)
	else if (bottom > viewport.scrollTop + viewport.clientHeight - margin)
		viewport.scrollTop = bottom - viewport.clientHeight + margin
}

/** Which rows are active: a re-render that leaves them alone doesn't move the nav. */
const activeKeyOf = (viewport: HTMLElement): string =>
	Arr.join(
		Arr.map(
			Arr.fromIterable(viewport.querySelectorAll('[data-active="true"]')),
			(row) => row.getAttribute("href") ?? "",
		),
		" ",
	)

export const MeasureSidebarOverflow = Mount.defineStream("MeasureSidebarOverflow", {
	messages: [Message.MeasuredSidebarOverflow],
	execute: ({ element }) =>
		Stream.callback<typeof Message.MeasuredSidebarOverflow.Type>((queue) =>
			Effect.acquireRelease(
				Effect.sync(() => {
					if (!(element instanceof HTMLElement)) return undefined
					const measure = () => applyScrollOverflow(element)
					const observer = new ResizeObserver(measure)
					observer.observe(element)
					if (element.firstElementChild !== null) observer.observe(element.firstElementChild)
					element.addEventListener("scroll", measure, { passive: true })
					revealActiveRow(element)
					// A route change moves the active row (or opens a section): bring it into view too.
					const seen = { key: activeKeyOf(element) }
					const routed = new MutationObserver(() => {
						const key = activeKeyOf(element)
						if (key === seen.key) return
						seen.key = key
						revealActiveRow(element)
					})
					routed.observe(element, {
						subtree: true,
						childList: true,
						attributes: true,
						attributeFilter: ["data-active"],
					})
					measure()
					Queue.offerUnsafe(queue, Message.MeasuredSidebarOverflow())
					return { observer, measure, routed }
				}),
				(handles) =>
					Effect.sync(() => {
						handles?.routed.disconnect()
						handles?.observer.disconnect()
						if (handles !== undefined) element.removeEventListener("scroll", handles.measure)
					}),
			).pipe(Effect.flatMap(() => Effect.never)),
		),
})

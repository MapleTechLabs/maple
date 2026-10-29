import { Effect, Queue, Schema, Stream } from "effect"
import { Dom } from "foldkit"
import { Align, measurePosition, Side } from "../ui/anchor"
import { applyScrollOverflow } from "../ui/scroll-area"
import { ShellDefinition } from "./definition"
import { containSearchKeys } from "./namespace-search"
import { Menu, Message } from "./message"
import { measuredViewport } from "./palette/command"

/**
 * Positions an open menu's positioner against its trigger (Base UI's anchor positioning), on
 * insert and on every viewport resize, and moves focus into the popup like Base UI on open.
 */
export const PositionMenu = ShellDefinition.makeMountStream("PositionMenu", {
	args: {
		menu: Menu,
		triggerId: Schema.String,
		popupId: Schema.String,
		side: Side,
		align: Align,
		sideOffset: Schema.Number,
	},
	messages: [Message.MeasuredMenuPopup],
	handler: function* () {
		return ({ element, menu, triggerId, popupId, side, align, sideOffset }) => {
			const measure = () => {
				const position = measurePosition(element, triggerId, {
					side,
					align,
					sideOffset,
					alignOffset: 0,
				})
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
		}
	},
})

/** The namespace menu's search input: focused as it mounts, its keys kept from the menu. */
export const MountNamespaceSearch = ShellDefinition.makeMountStream("MountNamespaceSearch", {
	messages: [Message.CompletedMountNamespaceSearch],
	handler: function* () {
		return ({ element }) =>
			Stream.callback<typeof Message.CompletedMountNamespaceSearch.Type>((queue) =>
				containSearchKeys(element).pipe(
					Effect.andThen(
						Effect.sync(() => Queue.offerUnsafe(queue, Message.CompletedMountNamespaceSearch())),
					),
					Effect.andThen(Effect.never),
				),
			)
	},
})

/** The sidebar nav's `ScrollArea` overflow (its bottom fade), kept current on scroll and resize. */
/** Scrolls the nav so the active row clears the pinned footer on a deep-linked load. */
const revealActiveRow = (viewport: HTMLElement): void => {
	const rows = viewport.querySelectorAll<HTMLElement>('[data-active="true"]')
	const row = rows.item(rows.length - 1)
	if (row === null) return
	const top = row.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop
	const bottom = top + row.offsetHeight
	if (bottom > viewport.scrollTop + viewport.clientHeight)
		viewport.scrollTop = bottom - viewport.clientHeight + 8
}

export const MeasureSidebarOverflow = ShellDefinition.makeMountStream("MeasureSidebarOverflow", {
	messages: [Message.MeasuredSidebarOverflow],
	handler: function* () {
		return ({ element }) =>
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
						measure()
						Queue.offerUnsafe(queue, Message.MeasuredSidebarOverflow())
						return { observer, measure }
					}),
					(handles) =>
						Effect.sync(() => {
							handles?.observer.disconnect()
							if (handles !== undefined) element.removeEventListener("scroll", handles.measure)
						}),
				).pipe(Effect.flatMap(() => Effect.never)),
			)
	},
})

/** The shortcuts dialog's panel viewport: its overflow (fades) and measured scrollbar. */
export const MeasureShortcutsPanel = ShellDefinition.makeMountStream("MeasureShortcutsPanel", {
	messages: [Message.MeasuredShortcutsPanel],
	handler: function* () {
		return ({ element }) =>
			element instanceof HTMLElement
				? measuredViewport(element, Message.MeasuredShortcutsPanel())
				: Stream.empty
	},
})

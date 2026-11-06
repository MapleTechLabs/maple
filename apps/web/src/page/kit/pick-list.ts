import { Array as Arr } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "@maple/views/ui/icon"
import { iconButton } from "@maple/views/ui/icon-button"
import type * as Menu from "@maple/views/ui/menu"
import * as MenuView from "@maple/views/ui/menu-view"
import { panel } from "@maple/views/ui/panel"
import { pressable } from "@maple/views/ui/pressable"
import { hstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"

// `PickList`: what a form has picked (destinations, people, schedules), each removable and, in an
// ordered list, movable, then an "Add" menu of the rest.

const moveLabel = (label: string, direction: "up" | "down", context: string | undefined): string =>
	context === undefined ? `Move ${label} ${direction}` : `Move ${label} ${direction} in ${context}`

/** One picked entry: its media (an icon or an avatar), its name and how to remove or move it. */
export type PickedEntry<M> = Readonly<{
	key: string
	label: string
	media: Html
	/** A muted note after the name ("on call: Ben Brook"). */
	detail?: string
	removeLabel: string
	onRemove: M
	/** Present on an ordered list: the up and down buttons, disabled at its ends. */
	/** `context` names the list in the move buttons ("layer 2"), when one page shows several lists. */
	move?: Readonly<{ up: M | null; down: M | null; context?: string }>
}>

/**
 * `PickList`: what a form has picked, each removable (and in order, movable), then an "Add" menu
 * of the rest. The owner keeps the menu's Model and the picks; destinations, people and schedules.
 */
export const pickList = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		entries: ReadonlyArray<PickedEntry<M>>
		/** What an empty pick means, in one line. */
		emptyText: string
		menu: Menu.Model
		toMenuMessage: (message: Menu.Message) => M
		/** The menu's entries; no add row while there are none. */
		addEntries: ReadonlyArray<MenuView.MenuEntry>
		addLabel: string
		/** A save in flight: the picks show, but nothing can be removed, moved or added. */
		isDisabled?: boolean
	}>,
): Html => {
	const isDisabled = options.isDisabled ?? false
	return panel(h, { className: "divide-y shadow-none" }, [
		...Arr.map(options.entries, (entry) =>
			hstack(h, { gap: "2", className: "px-3 py-2", attributes: [h.Key(entry.key)] }, [
				entry.media,
				typography(h, { size: "sm", truncate: true, className: "min-w-0 flex-1" }, [
					entry.label,
					...(entry.detail === undefined
						? []
						: [typography(h, { size: "xs", tone: "muted" }, [` · ${entry.detail}`])]),
				]),
				...(entry.move === undefined
					? []
					: [
							iconButton(
								h,
								{
									label: moveLabel(entry.label, "up", entry.move.context),
									isDisabled: isDisabled || entry.move.up === null,
									className: "text-muted-foreground",
									attributes: entry.move.up === null ? [] : [h.OnClick(entry.move.up)],
								},
								[icon(h, "ArrowUpIcon")],
							),
							iconButton(
								h,
								{
									label: moveLabel(entry.label, "down", entry.move.context),
									isDisabled: isDisabled || entry.move.down === null,
									className: "text-muted-foreground",
									attributes: entry.move.down === null ? [] : [h.OnClick(entry.move.down)],
								},
								[icon(h, "ArrowDownIcon")],
							),
						]),
				iconButton(
					h,
					{
						label: entry.removeLabel,
						className: "text-muted-foreground",
						isDisabled,
						attributes: [h.OnClick(entry.onRemove)],
					},
					[icon(h, "XmarkIcon")],
				),
			]),
		),
		...(options.entries.length === 0
			? [
					typography(h, { size: "sm", tone: "muted", as: "p", className: "px-3 py-2.5" }, [
						options.emptyText,
					]),
				]
			: []),
		...(options.addEntries.length === 0
			? []
			: [
					h.submodel({
						slotId: options.menu.id,
						model: options.menu,
						view: MenuView.view,
						viewInputs: {
							entries: options.addEntries,
							align: "start",
							className: "w-72",
							toView: ({ trigger, withTrigger }) =>
								h.span(
									[h.Class("contents")],
									withTrigger(
										pressable(
											h,
											{
												className:
													"flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-muted-foreground hover:bg-surface-sunken active:bg-surface-sunken hover:text-foreground active:text-foreground",
												isDisabled,
												attributes: trigger,
											},
											[icon(h, "PlusIcon", { size: 14 }), options.addLabel],
										),
									),
								),
						},
						toParentMessage: options.toMenuMessage,
					}),
				]),
	])
}

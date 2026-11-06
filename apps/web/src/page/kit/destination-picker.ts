import type { AlertDestinationRow } from "@maple/web-data/collections/alerts"
import { Array as Arr, Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "@maple/views/ui/icon"
import { iconButton } from "@maple/views/ui/icon-button"
import type * as Menu from "@maple/views/ui/menu"
import * as MenuView from "@maple/views/ui/menu-view"
import { panel } from "@maple/views/ui/panel"
import { pressable } from "@maple/views/ui/pressable"
import { hstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"

/**
 * `DestinationPicker`: the alert destinations a form notifies, each removable, then an "Add
 * destination" menu of the rest; the owner keeps the menu's Model and the chosen ids.
 */
export const destinationPicker = <M, Id extends string>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		/** The synced destinations; `null` until they arrive. */
		rows: ReadonlyArray<AlertDestinationRow> | null
		selectedIds: ReadonlyArray<Id>
		menu: Menu.Model
		toMenuMessage: (message: Menu.Message) => M
		onRemove: (id: Id) => M
		/** What an empty pick means, in one line. */
		emptyText: string
		/** The pick is shown but cannot change (a form whose save is in flight). */
		isDisabled?: boolean
		/** Names the list in its buttons ("step 2") when one form shows several pickers. */
		context?: string
	}>,
): Html => {
	const rows = options.rows ?? []
	const isDisabled = options.isDisabled ?? false
	const inContext = options.context === undefined ? "" : ` in ${options.context}`
	// `null` until destinations sync: a neutral name, not "unavailable", for the saved ones.
	const fallback = options.rows === null ? "Destination" : "Unavailable destination"
	const selected = Arr.map(options.selectedIds, (id) => ({
		id,
		name: Option.getOrElse(
			Option.map(
				Arr.findFirst(rows, (row) => row.id === id),
				(row) => row.name,
			),
			() => fallback,
		),
	}))
	const available = Arr.filter(rows, (row) => !Arr.some(options.selectedIds, (id) => id === row.id))
	return panel(h, { className: "divide-y shadow-none" }, [
		...Arr.map(selected, (destination) =>
			hstack(h, { gap: "2", className: "px-3 py-2", attributes: [h.Key(destination.id)] }, [
				icon(h, "BellIcon", { className: "text-muted-foreground" }),
				typography(h, { size: "sm", truncate: true, className: "min-w-0 flex-1" }, [
					destination.name,
				]),
				iconButton(
					h,
					{
						label: `Stop notifying ${destination.name}${inContext}`,
						className: "text-muted-foreground",
						isDisabled,
						attributes: [h.OnClick(options.onRemove(destination.id))],
					},
					[icon(h, "XmarkIcon")],
				),
			]),
		),
		...(selected.length === 0
			? [
					typography(h, { size: "sm", tone: "muted", as: "p", className: "px-3 py-2.5" }, [
						options.emptyText,
					]),
				]
			: []),
		...(available.length === 0
			? []
			: [
					h.submodel({
						slotId: options.menu.id,
						model: options.menu,
						view: MenuView.view,
						viewInputs: {
							entries: Arr.map(available, (row): MenuView.MenuEntry => ({
								_tag: "Item",
								value: row.id,
								label: row.name,
							})),
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
												attributes:
													options.context === undefined
														? trigger
														: [
																...trigger,
																h.AriaLabel(
																	`Add destination to ${options.context}`,
																),
															],
											},
											[icon(h, "PlusIcon", { size: 14 }), "Add destination"],
										),
									),
								),
						},
						toParentMessage: options.toMenuMessage,
					}),
				]),
	])
}

/** The destination a menu pick added, if it is a synced one not already chosen. */
export const pickedDestination = (
	outMessage: Menu.OutMessage | undefined,
	rows: ReadonlyArray<AlertDestinationRow> | null,
	selectedIds: ReadonlyArray<string>,
): Option.Option<string> => {
	const picked = outMessage?._tag === "SelectedItem" ? outMessage.value : null
	return picked !== null &&
		!selectedIds.includes(picked) &&
		Arr.some(rows ?? [], (row) => row.id === picked)
		? Option.some(picked)
		: Option.none()
}

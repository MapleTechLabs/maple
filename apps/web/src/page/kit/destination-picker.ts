import type { AlertDestinationRow } from "@maple/web-data/collections/alerts"
import { Array as Arr, Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "@maple/views/ui/icon"
import type * as Menu from "@maple/views/ui/menu"
import type * as MenuView from "@maple/views/ui/menu-view"
import { pickList } from "./pick-list"

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
	}>,
): Html => {
	const rows = options.rows ?? []
	const isDisabled = options.isDisabled ?? false
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
	return pickList(h, {
		entries: Arr.map(selected, (destination) => ({
			key: destination.id,
			label: destination.name,
			media: icon(h, "BellIcon", { className: "text-muted-foreground" }),
			removeLabel: `Stop notifying ${destination.name}`,
			onRemove: options.onRemove(destination.id),
		})),
		emptyText: options.emptyText,
		menu: options.menu,
		toMenuMessage: options.toMenuMessage,
		addEntries: Arr.map(available, (row): MenuView.MenuEntry => ({
			_tag: "Item",
			value: row.id,
			label: row.name,
		})),
		addLabel: "Add destination",
		isDisabled,
	})
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

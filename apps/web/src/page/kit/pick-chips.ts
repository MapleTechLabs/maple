import { Array as Arr } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import { icon } from "@maple/views/ui/icon"
import type * as Menu from "@maple/views/ui/menu"
import * as MenuView from "@maple/views/ui/menu-view"
import { hstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"

// `PickChips`: `PickList` for a sentence, where the picks sit inline on the sentence's own line.

/** One picked chip: its media (a logo, an avatar, an icon), its name and how to remove it. */
export type PickedChip<M> = Readonly<{
	key: string
	label: string
	media: Html
	/** A muted note after the name ("Ben Brook on call"). */
	detail?: string
	removeLabel: string
	onRemove: M
}>

const chip = <M>(h: HtmlBuilder<M>, entry: PickedChip<M>, canEdit: boolean, isDisabled: boolean): Html =>
	hstack(
		h,
		{
			gap: "1.5",
			inline: true,
			as: "span",
			className: `h-7 max-w-full rounded-md border border-border bg-surface-sunken pl-1.5 ${canEdit ? "pr-1" : "pr-2"}`,
			attributes: [h.Key(entry.key)],
		},
		[
			entry.media,
			typography(h, { size: "sm", truncate: true }, [entry.label]),
			...(entry.detail === undefined
				? []
				: [
						typography(
							h,
							{ size: "xs", tone: "muted", className: "hidden whitespace-nowrap sm:inline" },
							[entry.detail],
						),
					]),
			...(canEdit
				? [
						button(
							h,
							{
								variant: "ghost",
								size: "icon-2xs",
								isDisabled,
								attributes: [h.AriaLabel(entry.removeLabel), h.OnClick(entry.onRemove)],
							},
							[icon(h, "XmarkIcon")],
						),
					]
				: []),
		],
	)

/**
 * `PickChips`: what a form has picked as removable chips, then an "Add" chip that opens a menu of
 * the rest; the chips and the button go inline on the caller's own wrapping line.
 */
export const pickChips = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		entries: ReadonlyArray<PickedChip<M>>
		menu: Menu.Model
		toMenuMessage: (message: Menu.Message) => M
		addEntries: ReadonlyArray<MenuView.MenuEntry>
		/** The add button's text while nothing is picked; after that it reads "Add". */
		addLabel: string
		/** The add button's accessible name, when a form shows several pickers ("... to step 2"). */
		addAriaLabel?: string
		/** A save in flight: the picks show, but nothing can be removed or added. */
		isDisabled?: boolean
		/** A viewer who cannot edit: the picks alone, and `emptyText` when there are none. */
		isReadOnly?: boolean
		emptyText: string
	}>,
): ReadonlyArray<Html> => {
	const isDisabled = options.isDisabled ?? false
	const canEdit = !(options.isReadOnly ?? false)
	return [
		...Arr.map(options.entries, (entry) => chip(h, entry, canEdit, isDisabled)),
		...(canEdit
			? [
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
										button(
											h,
											{
												variant: "dashed",
												size: "xs",
												isDisabled,
												attributes: [
													h.AriaLabel(options.addAriaLabel ?? options.addLabel),
													...trigger,
												],
											},
											[
												icon(h, "PlusIcon"),
												options.entries.length === 0 ? options.addLabel : "Add",
											],
										),
									),
								),
						},
						toParentMessage: options.toMenuMessage,
					}),
				]
			: options.entries.length === 0
				? [typography(h, { size: "sm", tone: "muted" }, [options.emptyText])]
				: []),
	]
}

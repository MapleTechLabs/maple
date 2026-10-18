import { cn } from "@maple/ui/lib/utils"
import * as A from "@maple/ui/styles/ui/autocomplete"
import {
	commandFooterStyles,
	commandInputStyles,
	commandInputWrapperStyles,
	commandItemStyles,
	commandListStyles,
	commandShortcutStyles,
} from "@maple/ui/styles/ui/command"
import { Array } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { autocompleteField } from "./autocomplete"
import { filterItems, itemId, listId, Message, type Model } from "./combobox"
import { hiddenInput } from "./combobox-view"
import { scrollArea } from "./scroll-area"

/**
 * `@maple/ui/command`: the command palette's body, an inline Autocomplete (always open, first
 * match highlighted) on the Combobox Model, inside a `command-dialog` Dialog. Rendered from the
 * parent's frame with `toMessage`, because its parts sit directly in the dialog popup.
 */
export type CommandItem = Readonly<{ title: string; shortcut?: string }>
export type CommandGroup = Readonly<{ label: string; items: ReadonlyArray<CommandItem> }>

/** The groups' titles in list order: what the input filters and the highlight indexes. */
export const commandTitles = (groups: ReadonlyArray<CommandGroup>): ReadonlyArray<string> =>
	Array.flatMap(groups, (group) => group.items.map((item) => item.title))

/** `CommandInput`: the large borderless autocomplete input, focused when the dialog opens. */
export const commandInput = <M>(
	h: HtmlBuilder<M>,
	model: Model,
	options: Readonly<{ placeholder: string; groups: ReadonlyArray<CommandGroup>; hasDismissButton?: boolean }>,
	toMessage: (message: Message) => M,
): Html =>
	h.div(
		[h.Class(commandInputWrapperStyles)],
		[
			autocompleteField(
				h,
				model,
				{
					items: commandTitles(options.groups),
					placeholder: options.placeholder,
					size: "lg",
					className: commandInputStyles,
					isInline: true,
					isListEmpty: true,
					hasDismissButton: options.hasDismissButton,
				},
				toMessage,
			),
		],
	)

const commandItem = <M>(
	h: HtmlBuilder<M>,
	model: Model,
	item: CommandItem,
	index: number,
	toMessage: (message: Message) => M,
): Html =>
	h.div(
		[
			h.Class(cn(A.autocompleteItemStyles, commandItemStyles)),
			...(model.highlighted === index ? [h.DataAttribute("highlighted", "")] : []),
			h.DataAttribute("slot", "command-item"),
			h.Id(itemId(model.id, index)),
			h.Role("option"),
			h.OnMouseMove(toMessage(Message.HighlightedItem({ index }))),
			h.OnClick(toMessage(Message.ClickedItem({ value: item.title }))),
		],
		[
			h.span([h.Class("truncate text-sm")], [item.title]),
			...(item.shortcut === undefined
				? []
				: [
						h.kbd(
							[h.Class(commandShortcutStyles), h.DataAttribute("slot", "command-shortcut")],
							[item.shortcut],
						),
					]),
		],
	)

/** `CommandList` in its ScrollArea: the groups whose items match the input, numbered in order. */
export const commandList = <M>(
	h: HtmlBuilder<M>,
	model: Model,
	groups: ReadonlyArray<CommandGroup>,
	toMessage: (message: Message) => M,
): Html => {
	const matches = new Set(filterItems(commandTitles(groups), model.inputValue))
	const visible = Array.filter(
		groups.map((group) => ({
			...group,
			items: Array.filter(group.items, (item) => matches.has(item.title)),
		})),
		(group) => group.items.length > 0,
	)
	const rendered = Array.mapAccum(visible, 0, (start, group, groupIndex): [number, Html] => {
		const labelId = `${model.id}-group-${groupIndex}`
		return [
			start + group.items.length,
			h.div(
				[
					h.AriaLabelledBy(labelId),
					h.Class(cn(A.autocompleteGroupStyles)),
					h.DataAttribute("slot", "command-group"),
					h.Role("group"),
				],
				[
					h.div(
						[
							h.AriaHidden(true),
							h.Class(cn(A.autocompleteGroupLabelStyles)),
							h.DataAttribute("slot", "command-group-label"),
							h.Id(labelId),
						],
						[group.label],
					),
					...group.items.map((item, offset) =>
						commandItem(h, model, item, start + offset, toMessage),
					),
				],
			),
		]
	})[1]
	return scrollArea(h, { idPrefix: `${model.id}-scroll`, scrollFade: true, scrollbarGutter: true }, [
		h.div(
			[
				...(model.highlighted === null
					? []
					: [h.AriaActiveDescendant(itemId(model.id, model.highlighted))]),
				h.Class(cn(A.autocompleteListStyles, commandListStyles)),
				h.DataAttribute("empty", ""),
				h.DataAttribute("slot", "command-list"),
				h.Id(listId(model.id)),
				h.Role("listbox"),
				h.Tabindex(-1),
			],
			rendered,
		),
	])
}

/** `CommandFooter`. */
export const commandFooter = <M>(h: HtmlBuilder<M>, children: ReadonlyArray<Html>): Html =>
	h.div([h.Class(commandFooterStyles), h.DataAttribute("slot", "command-footer")], children)

/** The autocomplete's hidden input, last in the popup. */
export const commandHiddenInput = hiddenInput

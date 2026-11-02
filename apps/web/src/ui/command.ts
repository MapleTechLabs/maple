import { cn } from "@maple/ui/lib/utils"
import * as A from "@maple/ui/styles/ui/autocomplete"
import {
	commandEmptyStyles,
	commandFooterStyles,
	commandInputStyles,
	commandInputWrapperStyles,
	commandItemStyles,
	commandListStyles,
	commandShortcutStyles,
} from "@maple/ui/styles/ui/command"
import { Array } from "effect"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { autocompleteField } from "./autocomplete"
import { filterItems, itemId, listId, Message, type Model } from "./combobox"
import { hiddenInput } from "./combobox-view"
import { scrollArea } from "./scroll-area"

/**
 * `@maple/ui/command`: the command palette's body, an inline Autocomplete (always open, first
 * match highlighted) on the Combobox Model, inside a `command-dialog` Dialog. Rendered from the
 * parent's frame with `toMessage`, because its parts sit directly in the dialog popup.
 */
export type CommandItem = Readonly<{
	title: string
	shortcut?: string
	/** The item's value (default: its title), what a pick reports. */
	value?: string
	/** `render={<Link />}`: the item is an `<a>` to this href. */
	href?: string
	/** A glyph before the title (an icon, a service dot). */
	leading?: Html
}>
export type CommandGroup = Readonly<{ label: string; items: ReadonlyArray<CommandItem> }>

const valueOf = (item: CommandItem): string => item.value ?? item.title

/** The groups' values in list order: what the input filters and the highlight indexes. */
export const commandTitles = (groups: ReadonlyArray<CommandGroup>): ReadonlyArray<string> =>
	Array.flatMap(groups, (group) => group.items.map(valueOf))

/** `CommandInput`: the large borderless autocomplete input, focused when the dialog opens. */
export const commandInput = <M>(
	h: HtmlBuilder<M>,
	model: Model,
	options: Readonly<{
		placeholder: string
		groups: ReadonlyArray<CommandGroup>
		hasDismissButton?: boolean
		/** `filter={null}`: the groups are already what the query matched. */
		isUnfiltered?: boolean
	}>,
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
					isUnfiltered: options.isUnfiltered,
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
	options: ListOptions<M>,
): Html => {
	// Keyed like cmdk's items, so a re-ranked row keeps its node (a pending click stays on it).
	const attributes = [
		h.Key(valueOf(item)),
		h.Class(cn(A.autocompleteItemStyles, commandItemStyles, options.itemClassName)),
		...(model.highlighted === index ? [h.DataAttribute("highlighted", "")] : []),
		h.DataAttribute("slot", "command-item"),
		...(item.href === undefined ? [] : [h.Href(item.href)]),
		h.Id(itemId(model.id, index)),
		h.Role("option"),
		h.OnMouseMove(toMessage(Message.HighlightedItem({ index }))),
		h.OnClick(
			options.onClickItem === undefined
				? toMessage(Message.ClickedItem({ value: valueOf(item) }))
				: options.onClickItem(valueOf(item)),
		),
	]
	const children = [
		...(item.leading === undefined ? [] : [item.leading]),
		h.span([h.Class("truncate text-sm")], [item.title]),
		...(item.shortcut === undefined
			? []
			: [
					h.kbd(
						[h.Class(commandShortcutStyles), h.DataAttribute("slot", "command-shortcut")],
						[item.shortcut],
					),
				]),
	]
	return item.href === undefined ? h.div(attributes, children) : h.a(attributes, children)
}

export type ListOptions<M> = Readonly<{
	/** `filter={null}`: the groups are already what the query matched. */
	isUnfiltered?: boolean
	/** Replaces the pick an item click reports (a link item navigates on its own). */
	onClickItem?: (value: string) => M
	/** `CommandItem className`. */
	itemClassName?: string
	/** `CommandEmpty`, shown in the list when no group has items. */
	empty?: Html
	/** On the ScrollArea viewport, e.g. a Mount that measures its overflow. */
	viewportAttributes?: ReadonlyArray<Attribute<M>>
	/** The scrollbar, sized and shown by that Mount (`trackScrollbar`). */
	hasMeasuredScrollbar?: boolean
}>

/** `CommandList` in its ScrollArea: the groups whose items match the input, numbered in order. */
export const commandList = <M>(
	h: HtmlBuilder<M>,
	model: Model,
	groups: ReadonlyArray<CommandGroup>,
	toMessage: (message: Message) => M,
	options: ListOptions<M> = {},
): Html => {
	const matches = new Set(
		options.isUnfiltered === true
			? commandTitles(groups)
			: filterItems(commandTitles(groups), model.inputValue),
	)
	const visible = Array.filter(
		groups.map((group) => ({
			...group,
			items: Array.filter(group.items, (item) => matches.has(valueOf(item))),
		})),
		(group) => group.items.length > 0,
	)
	const rendered = Array.mapAccum(visible, 0, (start, group, groupIndex): [number, Html] => {
		const labelId = `${model.id}-group-${groupIndex}`
		return [
			start + group.items.length,
			h.div(
				[
					h.Key(group.label),
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
						commandItem(h, model, item, start + offset, toMessage, options),
					),
				],
			),
		]
	})[1]
	const body = rendered.length === 0 && options.empty !== undefined ? [options.empty] : rendered
	const scroll = {
		idPrefix: `${model.id}-scroll`,
		scrollFade: true,
		scrollbarGutter: true,
		viewportAttributes: options.viewportAttributes,
		hasMeasuredScrollbar: options.hasMeasuredScrollbar === true,
	}
	return scrollArea(h, scroll, [
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
			body,
		),
	])
}

/** `CommandGroup` and its label, around option rows the caller draws (`commandOption`). */
export const commandGroup = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ labelId: string; label: string }>,
	children: ReadonlyArray<Html>,
): Html =>
	h.div(
		[
			h.AriaLabelledBy(options.labelId),
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
					h.Id(options.labelId),
				],
				[options.label],
			),
			...children,
		],
	)

/** `CommandFooter`. Positioned so the popup's tinted `::before` layer paints under its hints, not over them. */
export const commandFooter = <M>(h: HtmlBuilder<M>, children: ReadonlyArray<Html>): Html =>
	h.div([h.Class(cn("relative", commandFooterStyles)), h.DataAttribute("slot", "command-footer")], children)

/** The autocomplete's hidden input, last in the popup. */
export const commandHiddenInput = hiddenInput

type Part<M> = Readonly<{ className?: string; attributes?: ReadonlyArray<Attribute<M>> }>

/** A bare `role="option"` command row for a hand-rolled list (a quick-pick popover); the caller
 *  owns its ids, highlight and events. */
export const commandOption = <M>(h: HtmlBuilder<M>, options: Part<M>, children: ReadonlyArray<Html>): Html =>
	h.div(
		[
			h.Class(cn(A.autocompleteItemStyles, cn(commandItemStyles, options.className))),
			h.DataAttribute("slot", "command-item"),
			h.Role("option"),
			...(options.attributes ?? []),
		],
		children,
	)

/** A bare `role="listbox"` command list for a hand-rolled list. */
export const commandListbox = <M>(h: HtmlBuilder<M>, options: Part<M>, children: ReadonlyArray<Html>): Html =>
	h.div(
		[
			h.Class(cn(A.autocompleteListStyles, cn(commandListStyles, options.className))),
			h.DataAttribute("slot", "command-list"),
			h.Role("listbox"),
			h.Tabindex(-1),
			...(options.attributes ?? []),
		],
		children,
	)

/** `CommandEmpty`: a live status line, filled only while nothing matches. */
export const commandEmpty = <M>(
	h: HtmlBuilder<M>,
	options: Part<M>,
	children: ReadonlyArray<Html | string>,
): Html =>
	h.div(
		[
			h.AriaAtomic(true),
			h.AriaLive("polite"),
			h.Class(cn(A.autocompleteEmptyStyles, cn(commandEmptyStyles, options.className))),
			h.DataAttribute("slot", "command-empty"),
			h.Role("status"),
			...(options.attributes ?? []),
		],
		children,
	)

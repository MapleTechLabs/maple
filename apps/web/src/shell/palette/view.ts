import { cn } from "@maple/ui/lib/utils"
import * as A from "@maple/ui/styles/ui/autocomplete"
import * as CommandStyles from "@maple/ui/styles/ui/command"
import { Array } from "effect"
import { Block } from "foldkit"
import { type ChildAttribute, childAttributes, type Html, type HtmlBuilder } from "foldkit/html"
import {
	ComboboxComposition,
	type ComboboxViewBuilder,
	itemId,
	listId,
	Message as ListMessage,
	type Model as ListModel,
} from "../../ui/combobox"
import {
	type CommandGroup,
	type CommandItem,
	commandFooter,
	commandHiddenInput,
	commandInput,
} from "../../ui/command"
import { kbd } from "../../ui/display"
import { icon } from "../../ui/icon"
import { manifestGlyph } from "../../ui/manifest-glyph"
import { serviceDot } from "../../ui/values"
import { type Glyph, groupEntries, type PaletteEntry } from "./entries"
import { MeasurePaletteList } from "./command"
import { Message, Model } from "./model"
import {
	type Context,
	DialogBinding,
	EffectsLayer,
	init,
	ListBinding,
	operations,
	PaletteComposition,
	shownEntries,
	update,
} from "./update"
import { scrollArea } from "../../ui/scroll-area"

/**
 * Layout-free wrapper: group labels take the sidebar's uppercase tracked style, and a short scroll
 * fade keeps the last visible row from reading as disabled.
 */
const PALETTE_LIST_CLASS =
	"contents [&_[data-slot=command-group-label]]:text-2xs [&_[data-slot=command-group-label]]:font-semibold [&_[data-slot=command-group-label]]:uppercase [&_[data-slot=command-group-label]]:tracking-widest [&_[data-slot=scroll-area-viewport]]:[--fade-size:0.5rem]"

// `CommandPalette`'s popup: the input, the grouped entries (or "No results"), the footer hints.

export type ViewInputs = Readonly<{ context: Context; visibleFlagged: ReadonlyArray<string> }>

const GLYPH_CLASS = "shrink-0 text-muted-foreground"

const glyph = <M>(h: HtmlBuilder<M>, value: Glyph): Html => {
	switch (value._tag) {
		case "Icon":
			return icon(h, value.name, { size: 16, className: GLYPH_CLASS })
		case "Manifest":
			return manifestGlyph(h, value.icon, 16, { className: GLYPH_CLASS, monochrome: true })
		case "Service":
			return serviceDot(h, { serviceName: value.serviceName })
	}
}

const groupsOf = <M>(h: HtmlBuilder<M>, entries: ReadonlyArray<PaletteEntry>): ReadonlyArray<CommandGroup> =>
	groupEntries(entries).map((section) => ({
		label: section.group,
		items: section.entries.map((entry) => ({
			title: entry.title,
			value: entry.id,
			leading: glyph(h, entry.glyph),
			shortcut: entry.shortcut,
			href: entry.target._tag === "Href" ? entry.target.href : undefined,
		})),
	}))

const hint = <M>(h: HtmlBuilder<M>, key: string, text: string): Html =>
	h.span(
		[h.Class("flex items-center gap-1.5 text-muted-foreground")],
		[kbd(h, "text-muted-foreground", [key]), text],
	)

/** `CommandEmpty`: `No results for “{query}”.`, the query its own text run. */
const empty = <M>(h: HtmlBuilder<M>, query: string): Html =>
	h.div(
		[
			h.AriaAtomic(true),
			h.AriaLive("polite"),
			h.Class(cn(A.autocompleteEmptyStyles, CommandStyles.commandEmptyStyles)),
			h.DataAttribute("slot", "command-empty"),
			h.Role("status"),
		],
		["No results for “", query, "”."],
	)

const PLACEHOLDER = "Search pages, dashboards, actions…"

// THE LIST: alternate Combobox views, so the input's and the list's events reach the list's Block.

/** The large borderless autocomplete input, focused when the dialog opens. */
const listInputView = ComboboxComposition.makeView.withInputs<
	Readonly<{ groups: ReadonlyArray<CommandGroup> }>
>((model, inputs, h) =>
	commandInput(
		h,
		model,
		{ placeholder: PLACEHOLDER, groups: inputs.groups, hasDismissButton: true, isUnfiltered: true },
		(message) => message,
	),
)

/** The autocomplete's hidden input, last in the popup. */
const listHiddenInputView = ComboboxComposition.makeView((model, h) => commandHiddenInput(h, model))

type ListInputs = Readonly<{
	groups: ReadonlyArray<CommandGroup>
	empty: Html
	/** The palette's own click on an entry (its value), spread on the entry. */
	entryClick: (value: string) => ReadonlyArray<ChildAttribute>
}>

const valueOf = (item: CommandItem): string => item.value ?? item.title

/** `CommandItem`: keyed like cmdk's items, so a re-ranked row keeps its node (a pending click stays on it). */
const listItem = (
	h: ComboboxViewBuilder,
	model: ListModel,
	item: CommandItem,
	index: number,
	inputs: ListInputs,
): Html => {
	const attributes = [
		h.Key(valueOf(item)),
		h.Class(cn(A.autocompleteItemStyles, CommandStyles.commandItemStyles, "flex items-center gap-2")),
		...(model.highlighted === index ? [h.DataAttribute("highlighted", "")] : []),
		h.DataAttribute("slot", "command-item"),
		...(item.href === undefined ? [] : [h.Href(item.href)]),
		h.Id(itemId(model.id, index)),
		h.Role("option"),
		h.OnMouseMove(ListMessage.HighlightedItem({ index })),
		...inputs.entryClick(valueOf(item)),
	]
	const children = [
		...(item.leading === undefined ? [] : [item.leading]),
		h.span([h.Class("truncate text-sm")], [item.title]),
		...(item.shortcut === undefined
			? []
			: [
					h.kbd(
						[
							h.Class(CommandStyles.commandShortcutStyles),
							h.DataAttribute("slot", "command-shortcut"),
						],
						[item.shortcut],
					),
				]),
	]
	return item.href === undefined ? h.div(attributes, children) : h.a(attributes, children)
}

/** `CommandList` in its ScrollArea, unfiltered (the groups are what the query matched), numbered in order. */
const listView = ComboboxComposition.makeView.withInputs<ListInputs>((model, inputs, h) => {
	const groups = Array.filter(inputs.groups, (group) => group.items.length > 0)
	const rendered = Array.mapAccum(groups, 0, (start, group, groupIndex): [number, Html] => {
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
					...group.items.map((item, offset) => listItem(h, model, item, start + offset, inputs)),
				],
			),
		]
	})[1]
	const body = rendered.length === 0 && inputs.empty !== null ? [inputs.empty] : rendered
	return scrollArea(
		h,
		{
			idPrefix: `${model.id}-scroll`,
			scrollFade: true,
			scrollbarGutter: true,
			hasMeasuredScrollbar: true,
		},
		[
			h.div(
				[
					...(model.highlighted === null
						? []
						: [h.AriaActiveDescendant(itemId(model.id, model.highlighted))]),
					h.Class(cn(A.autocompleteListStyles, CommandStyles.commandListStyles)),
					h.DataAttribute("empty", ""),
					h.DataAttribute("slot", "command-list"),
					h.Id(listId(model.id)),
					h.Role("listbox"),
					h.Tabindex(-1),
				],
				body,
			),
		],
	)
})

/** The palette's dialog portal, placed by the shell's overlay layer. */
export const view = PaletteComposition.makeView.withInputs<ViewInputs>((model, inputs, h) => {
	const shown = shownEntries(model, inputs.context, inputs.visibleFlagged)
	const groups = groupsOf(h, shown.entries)
	return h.block(
		DialogBinding.embedView({
			slotId: "command-palette",
			model: model.dialog,
			viewInputs: {
				hasTrigger: false,
				toView: ({ portal }) => portal,
				toContent: () => [
					h.block(
						ListBinding.embedView({
							slotId: "command-palette-input",
							model: model.list,
							view: listInputView,
							viewInputs: { groups },
						}),
					),
					h.div(
						[h.Class(PALETTE_LIST_CLASS), h.OnMount(MeasurePaletteList())],
						[
							h.block(
								ListBinding.embedView({
									slotId: "command-palette-list",
									model: model.list,
									view: listView,
									viewInputs: {
										groups,
										empty: shown.isSearch ? empty(h, model.list.inputValue) : null,
										entryClick: (id) =>
											childAttributes([h.OnClick(Message.ClickedEntry({ id }))]),
									},
								}),
							),
						],
					),
					commandFooter(h, [hint(h, "↵", " to open"), hint(h, "Esc", " to close")]),
					h.block(
						ListBinding.embedView({
							slotId: "command-palette-hidden-input",
							model: model.list,
							view: listHiddenInputView,
						}),
					),
				],
			},
		}),
	)
})

const prepare = () => PaletteComposition.prepareBlock({ init, update, view, operations, EffectsLayer })
export const PaletteBlock: Block.FromAssemblyWithViewAndOutMessage<typeof Model, typeof prepare> =
	Block.assemble(prepare)

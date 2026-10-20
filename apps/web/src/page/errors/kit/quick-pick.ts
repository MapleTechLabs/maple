import { cn } from "@maple/ui/lib/utils"
import {
	autocompleteEmptyStyles,
	autocompleteItemStyles,
	autocompleteListStyles,
} from "@maple/ui/styles/ui/autocomplete"
import { commandEmptyStyles, commandItemStyles, commandListStyles } from "@maple/ui/styles/ui/command"
import { Option, Schema } from "effect"
import { Command, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { kbd } from "../../../ui/display"
import { icon } from "../../../ui/icon"
import * as Popover from "../../../ui/popover"
import { scrollArea } from "../../../ui/scroll-area"

// A quick-pick menu: a popover with a type-to-filter input
// (an inline, always-open Autocomplete, first match highlighted) and one row per choice; a digit
// picks a row outright while nothing is typed.

export type QuickPickItem = Readonly<{
	value: string
	label: string
	icon: Html
	shortcut?: string
	isDisabled?: boolean
	keywords?: string
}>

// MODEL

export const Model = Schema.Struct({
	popover: Popover.Model,
	query: Schema.String,
	highlighted: Schema.NullOr(Schema.Number),
})
export type Model = typeof Model.Type

/** Opened at once: the trigger was pressed (or its hotkey), so there is nothing to wait for. */
export const init = (id: string): Model => ({
	popover: Popover.init(id, { isOpen: true, align: "start", sideOffset: 6, isBare: true }),
	query: "",
	highlighted: 0,
})

/** The rows the filter keeps: label and keywords contain the query. */
export const visibleOf = <T extends Readonly<{ label: string; keywords?: string | undefined }>>(
	items: ReadonlyArray<T>,
	query: string,
): ReadonlyArray<T> => {
	const needle = query.trim().toLowerCase()
	return items.filter((item) => `${item.label} ${item.keywords ?? ""}`.toLowerCase().includes(needle))
}

// MESSAGE

const ItemFacts = Schema.Struct({
	value: Schema.String,
	label: Schema.String,
	shortcut: Schema.optional(Schema.String),
	isDisabled: Schema.optional(Schema.Boolean),
	keywords: Schema.optional(Schema.String),
})

export const Message = defineMessageUnion({
	GotPopoverMessage: { message: Popover.Message },
	ChangedQuery: { value: Schema.String },
	/** `items` unfiltered: `update` filters by the current query, as a key typed in the same frame needs. */
	PressedInputKey: { key: Schema.String, items: Schema.Array(ItemFacts) },
	HoveredItem: { index: Schema.Number },
	ClickedItem: { value: Schema.String },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({ Picked: { value: Schema.String }, Closed: {} })
export type OutMessage = typeof OutMessage.Type

type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage>

const closed = (model: Model): Return => ({
	model: { ...model, popover: { ...model.popover, isOpen: false } },
	outMessage: OutMessage.Closed(),
})

const picked = (model: Model, value: string): Return => ({
	...closed(model),
	outMessage: OutMessage.Picked({ value }),
})

const step = (model: Model, items: ReadonlyArray<typeof ItemFacts.Type>, delta: 1 | -1): Return => {
	const visible = visibleOf(items, model.query)
	if (visible.length === 0) return { model }
	const start = model.highlighted ?? (delta === 1 ? -1 : visible.length)
	const next = Math.min(Math.max(start + delta, 0), visible.length - 1)
	return { model: { ...model, highlighted: next } }
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotPopoverMessage: ({ message: inner }) => {
			const next = Popover.update(model.popover, inner)
			const lifted: Return = {
				model: { ...model, popover: next.model },
				commands: Command.mapMessages(next.commands ?? [], (popover) =>
					Message.GotPopoverMessage({ message: popover }),
				),
			}
			return next.model.isOpen ? lifted : { ...lifted, outMessage: OutMessage.Closed() }
		},
		ChangedQuery: ({ value }) => ({ model: { ...model, query: value, highlighted: 0 } }),
		PressedInputKey: ({ key, items }) => {
			if (key === "Escape") return closed(model)
			if (key === "ArrowDown") return step(model, items, 1)
			if (key === "ArrowUp") return step(model, items, -1)
			const visible = visibleOf(items, model.query)
			if (key === "Enter") {
				const item = model.highlighted === null ? undefined : visible[model.highlighted]
				return item === undefined || item.isDisabled === true ? { model } : picked(model, item.value)
			}
			if (model.query === "" && /^[0-9]$/.test(key)) {
				const item = items.find(
					(candidate) => candidate.shortcut === key && candidate.isDisabled !== true,
				)
				return item === undefined ? { model } : picked(model, item.value)
			}
			return { model }
		},
		HoveredItem: ({ index }) => ({ model: { ...model, highlighted: index } }),
		ClickedItem: ({ value }) => picked(model, value),
	})

// VIEW

const INPUT_KEYS = new Set([
	"Escape",
	"ArrowDown",
	"ArrowUp",
	"Enter",
	"0",
	"1",
	"2",
	"3",
	"4",
	"5",
	"6",
	"7",
	"8",
	"9",
])

export type ViewOptions<M> = Readonly<{
	model: Model
	items: ReadonlyArray<QuickPickItem>
	current: string | null
	placeholder: string
	hotkey: string
	label: string
	toMessage: (message: Message) => M
	/** The trigger button, given the Popover's trigger attributes. */
	trigger: (attributes: Popover.RenderInfo["trigger"]) => Html
	toView: (parts: ReadonlyArray<Html>) => Html
	/** `fallbackAnchor`: the row, used while the trigger is hidden (narrow page). */
	fallbackAnchorSelector?: string
}>

const listId = (id: string) => `${id}-list`
const optionId = (id: string, index: number) => `${id}-option-${index}`

const row = <M>(h: HtmlBuilder<M>, options: ViewOptions<M>, item: QuickPickItem, index: number): Html => {
	const { model, toMessage } = options
	const isHighlighted = model.highlighted === index
	const isDisabled = item.isDisabled ?? false
	return h.div(
		[
			...(isDisabled ? [h.AriaDisabled(true)] : []),
			h.Class(
				cn(
					autocompleteItemStyles,
					cn(
						commandItemStyles,
						"gap-2 rounded-md px-2 py-1.5 text-xs text-foreground data-disabled:opacity-40",
					),
				),
			),
			...(isDisabled ? [h.DataAttribute("disabled", "")] : []),
			...(isHighlighted ? [h.DataAttribute("highlighted", "")] : []),
			h.DataAttribute("slot", "command-item"),
			h.Id(optionId(model.popover.id, index)),
			h.Role("option"),
			...(isDisabled
				? []
				: [
						h.OnMouseMove(toMessage(Message.HoveredItem({ index }))),
						h.OnClick(toMessage(Message.ClickedItem({ value: item.value }))),
					]),
		],
		[
			h.span([h.Class("flex size-4 shrink-0 items-center justify-center")], [item.icon]),
			h.span([h.Class("min-w-0 flex-1 truncate")], [item.label]),
			...(item.value === options.current
				? [icon(h, "CheckIcon", { size: 14, className: "shrink-0 text-foreground" })]
				: []),
			...(item.shortcut === undefined
				? []
				: [
						h.span(
							[
								h.Class(
									"w-3 shrink-0 text-right text-2xs tabular-nums text-muted-foreground/70",
								),
							],
							[item.shortcut],
						),
					]),
		],
	)
}

const content = <M>(h: HtmlBuilder<M>, options: ViewOptions<M>): ReadonlyArray<Html> => {
	const { model, toMessage } = options
	const visible = visibleOf(options.items, model.query)
	const facts = options.items.map(({ value, label, shortcut, isDisabled, keywords }) => ({
		value,
		label,
		shortcut,
		isDisabled,
		keywords,
	}))
	const activeDescendant =
		model.highlighted !== null && visible[model.highlighted] !== undefined
			? [h.AriaActiveDescendant(optionId(model.popover.id, model.highlighted))]
			: []
	return [
		h.div(
			[h.Class("flex items-center gap-2 border-b border-border/60 px-3")],
			[
				h.input([
					...activeDescendant,
					h.AriaAutocomplete("list"),
					h.AriaControls(listId(model.popover.id)),
					h.AriaExpanded(true),
					h.AriaHasPopup("listbox"),
					h.AriaLabel(options.label),
					h.Attribute("autocapitalize", "none"),
					h.Attribute("autocomplete", "off"),
					h.Attribute("autocorrect", "off"),
					h.Class(
						"h-9 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground",
					),
					h.DataAttribute("popup-open", ""),
					h.DataAttribute("pressed", ""),
					h.Placeholder(options.placeholder),
					h.Role("combobox"),
					h.Attribute("spellcheck", "false"),
					h.Value(model.query),
					h.OnInput((value) => toMessage(Message.ChangedQuery({ value }))),
					h.OnKeyDownPreventDefault((key) =>
						INPUT_KEYS.has(key) && (key.length > 1 || model.query === "")
							? Option.some(toMessage(Message.PressedInputKey({ key, items: facts })))
							: Option.none(),
					),
				]),
				kbd(h, "h-4.5 min-w-4.5 text-3xs", [options.hotkey]),
			],
		),
		scrollArea(h, { idPrefix: `${model.popover.id}-scroll`, className: "size-full min-h-0" }, [
			h.div(
				[
					...activeDescendant,
					h.Class(cn(autocompleteListStyles, cn(commandListStyles, "not-empty:p-1"))),
					h.DataAttribute("slot", "command-list"),
					h.Id(listId(model.popover.id)),
					h.Role("listbox"),
					h.Tabindex(-1),
				],
				[
					h.div(
						[
							h.AriaAtomic(true),
							h.AriaLive("polite"),
							h.Class(
								cn(autocompleteEmptyStyles, cn(commandEmptyStyles, "not-empty:py-4 text-xs")),
							),
							h.DataAttribute("slot", "command-empty"),
							h.Role("status"),
						],
						visible.length === 0 ? ["No match"] : [],
					),
					...visible.map((item, index) => row(h, options, item, index)),
				],
			),
		]),
	]
}

/** The trigger and, while open, its popover (Base UI's guards and portal around it). */
export const view = <M>(h: HtmlBuilder<M>, options: ViewOptions<M>): Html =>
	h.submodel({
		slotId: options.model.popover.id,
		model: options.model.popover,
		view: Popover.view,
		toParentMessage: (message) => options.toMessage(Message.GotPopoverMessage({ message })),
		viewInputs: {
			bare: {
				positionerClassName: "isolate z-55 outline-none",
				popupClassName: cn(
					"w-60 origin-(--transform-origin) overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none",
					"duration-100 transition-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
				),
			},
			toContent: () => content(h, options),
			fallbackAnchorSelector: options.fallbackAnchorSelector,
			toView: ({ trigger, withTrigger }) => options.toView(withTrigger(options.trigger(trigger))),
		},
	})

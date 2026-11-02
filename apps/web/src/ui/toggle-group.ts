import { cn } from "@maple/ui/lib/utils"
import { toggleVariants } from "@maple/ui/styles/ui/toggle"
import {
	toggleGroupConnectedStyles,
	toggleGroupHorizontalStyles,
	toggleGroupStandaloneStyles,
	toggleGroupStyles,
	toggleGroupTrackStyles,
} from "@maple/ui/styles/ui/toggle-group"
import { Effect, Option, Schema } from "effect"
import { Command, Dom, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import { segmentItemHeight, togglePrimitive } from "./toggle"

/**
 * Base UI `ToggleGroup`: the pressed values and the roving tab stop (the composite's highlighted
 * index). Arrow keys move the tab stop and focus, Space/Enter press through the native button.
 */

// MODEL

export const Model = Schema.Struct({
	label: Schema.String,
	isMultiple: Schema.Boolean,
	values: Schema.Array(Schema.String),
	highlightedIndex: Schema.Finite,
})
export type Model = typeof Model.Type

export const init = (config: {
	label: string
	isMultiple?: boolean
	values: ReadonlyArray<string>
}): Model => ({
	label: config.label,
	isMultiple: config.isMultiple ?? false,
	values: config.values,
	highlightedIndex: 0,
})

// MESSAGE

export const Message = defineMessageUnion({
	ClickedItem: { value: Schema.String, index: Schema.Finite },
	PressedArrowKey: { index: Schema.Finite },
	CompletedFocusItem: {},
})
export type Message = typeof Message.Type

// COMMAND

const itemSelector = (label: string, index: number) =>
	`[data-slot="toggle-group"][aria-label="${label}"] > :nth-child(${index + 1})`

export const FocusItem = Command.define("FocusToggleGroupItem", {
	args: { selector: Schema.String },
	messages: [Message.CompletedFocusItem],
	execute: ({ selector }) =>
		Dom.focus(selector).pipe(Effect.ignore, Effect.as(Message.CompletedFocusItem())),
})

// UPDATE

const toggled = (model: Model, value: string): ReadonlyArray<string> => {
	const isPressed = model.values.includes(value)
	if (model.isMultiple)
		return isPressed ? model.values.filter((v) => v !== value) : [...model.values, value]
	return isPressed ? [] : [value]
}

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
	Message.match<Update.Return<Model, Message>>(message, {
		ClickedItem: ({ value, index }) => ({
			model: modifyFields(model, {
				values: () => toggled(model, value),
				highlightedIndex: () => index,
			}),
		}),
		PressedArrowKey: ({ index }) => ({
			model: modifyFields(model, { highlightedIndex: () => index }),
			commands: [FocusItem({ selector: itemSelector(model.label, index) })],
		}),
		CompletedFocusItem: () => ({ model }),
	})

// VIEW

/** `children` replaces the plain label (a dot and a count); `className` is the item's own. */
export type ToggleGroupItem = Readonly<{
	value: string
	label: string
	children?: ReadonlyArray<Html | string>
	className?: string
}>

export type ToggleGroupViewConfig<ParentMessage> = Readonly<{
	model: Model
	toParentMessage: (message: Message) => ParentMessage
	items: ReadonlyArray<ToggleGroupItem>
	variant?: "default" | "outline"
	size?: "xs" | "sm" | "default" | "lg"
	isConnected?: boolean
	/** Each `<ToggleGroupItem className>`. */
	itemClassName?: string
	className?: string
}>

const arrowTarget = (key: string, index: number, count: number): Option.Option<number> => {
	if (key === "ArrowRight" || key === "ArrowDown") return Option.some((index + 1) % count)
	if (key === "ArrowLeft" || key === "ArrowUp") return Option.some((index - 1 + count) % count)
	if (key === "Home") return Option.some(0)
	if (key === "End") return Option.some(count - 1)
	return Option.none()
}

/** `<ToggleGroup>` + `<ToggleGroupItem>`s from @maple/ui, horizontal. */
export const view = <ParentMessage>(
	h: HtmlBuilder<ParentMessage>,
	config: ToggleGroupViewConfig<ParentMessage>,
): Html => {
	const { model, toParentMessage, items } = config
	const variant = config.variant ?? "default"
	const size = config.size ?? "default"
	const isConnected = config.isConnected ?? true
	const isSegmented = isConnected && variant !== "default"
	// Inside a track an `outline` item drops its own frame and becomes a segment.
	const itemVariant = isConnected && variant === "outline" ? "segment" : variant
	const trackStyles = isSegmented
		? toggleGroupTrackStyles
		: isConnected
			? toggleGroupConnectedStyles
			: toggleGroupStandaloneStyles
	return h.div(
		[
			h.Role("group"),
			// An empty label is a group with no accessible name, as a bare `<ToggleGroup>`.
			...(model.label === "" ? [] : [h.AriaLabel(model.label)]),
			h.Class(cn(toggleGroupStyles, toggleGroupHorizontalStyles, trackStyles, config.className)),
			...(model.isMultiple ? [h.DataAttribute("multiple", "")] : []),
			h.DataAttribute("orientation", "horizontal"),
			h.DataAttribute("size", size),
			h.DataAttribute("slot", "toggle-group"),
			h.DataAttribute("variant", variant),
		],
		items.map((item, index) =>
			togglePrimitive(
				h,
				{
					isPressed: model.values.includes(item.value),
					onClick: toParentMessage(Message.ClickedItem({ value: item.value, index })),
					className: cn(
						toggleVariants({ size, variant: itemVariant }),
						isSegmented && segmentItemHeight[size],
						item.className,
						config.itemClassName,
					),
					slot: "toggle",
					tabIndex: index === model.highlightedIndex ? 0 : -1,
					attributes: [
						h.AriaDisabled(false),
						h.DataAttribute("size", size),
						h.DataAttribute("variant", itemVariant),
						h.OnKeyDownPreventDefault((key) =>
							Option.map(arrowTarget(key, index, items.length), (target) =>
								toParentMessage(Message.PressedArrowKey({ index: target })),
							),
						),
					],
				},
				item.children ?? [item.label],
			),
		),
	)
}

/** One item of a `controlledView`: its pressed state and click Message come from the owner. */
export type ControlledToggleGroupItem<M> = Readonly<{
	isPressed: boolean
	onClick: M
	children: ReadonlyArray<Html | string>
}>

/**
 * A connected `<ToggleGroup>` whose pressed item lives in the owner's Model (a tab strip of
 * toggles): no Submodel, and the pressed item is the tab stop.
 */
export const controlledView = <M>(
	h: HtmlBuilder<M>,
	config: Readonly<{
		label: string
		items: ReadonlyArray<ControlledToggleGroupItem<M>>
		size?: "xs" | "sm" | "default" | "lg"
		className?: string
		itemClassName?: string
	}>,
): Html => {
	const size = config.size ?? "default"
	return h.div(
		[
			h.Role("group"),
			h.AriaLabel(config.label),
			h.Class(
				cn(toggleGroupStyles, toggleGroupHorizontalStyles, toggleGroupConnectedStyles, config.className),
			),
			h.DataAttribute("orientation", "horizontal"),
			h.DataAttribute("size", size),
			h.DataAttribute("slot", "toggle-group"),
			h.DataAttribute("variant", "default"),
		],
		config.items.map((item) =>
			togglePrimitive(
				h,
				{
					isPressed: item.isPressed,
					onClick: item.onClick,
					className: cn(toggleVariants({ size, variant: "default" }), config.itemClassName),
					slot: "toggle",
					tabIndex: item.isPressed ? 0 : -1,
					attributes: [
						h.AriaDisabled(false),
						h.DataAttribute("size", size),
						h.DataAttribute("variant", "default"),
					],
				},
				item.children,
			),
		),
	)
}

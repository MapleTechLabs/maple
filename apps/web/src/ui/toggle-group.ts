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
import { Block, Dom } from "foldkit"
import type { Html } from "foldkit/html"
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

export type InitConfig = Readonly<{
	label: string
	isMultiple?: boolean
	values: ReadonlyArray<string>
}>

/** The initial Model alone, for parents that build their own Model outside a Binding init. */
export const initialModel = (config: InitConfig): Model => ({
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
	RequestedValues: { values: Schema.Array(Schema.String) },
})
export type Message = typeof Message.Type

// OUT MESSAGE

/** A click toggled `value`; `values` is the pressed set after the click. */
export const OutMessage = defineMessageUnion({
	ToggledItem: { value: Schema.String, values: Schema.Array(Schema.String) },
})
export type OutMessage = typeof OutMessage.Type

const ToggleGroupDefinition = Block.makeDefinition("ToggleGroup", { Model, Message, OutMessage })

const ToggleGroupComposition = ToggleGroupDefinition.makeComposition()

export const init = ToggleGroupComposition.makeInit((config: InitConfig) => ({
	model: initialModel(config),
}))

// COMMAND

const itemSelector = (label: string, index: number) =>
	`[data-slot="toggle-group"][aria-label="${label}"] > :nth-child(${index + 1})`

export const FocusItem = ToggleGroupDefinition.makeCommand("FocusToggleGroupItem", {
	args: { selector: Schema.String },
	messages: [Message.CompletedFocusItem],
	handler: function* () {
		return ({ selector }) =>
			Dom.focus(selector).pipe(Effect.ignore, Effect.as(Message.CompletedFocusItem()))
	},
})

// UPDATE

const toggled = (model: Model, value: string): ReadonlyArray<string> => {
	const isPressed = model.values.includes(value)
	if (model.isMultiple)
		return isPressed ? model.values.filter((v) => v !== value) : [...model.values, value]
	return isPressed ? [] : [value]
}

export const update = ToggleGroupComposition.makeUpdate({
	ClickedItem: (model, { value, index }) => {
		const values = toggled(model, value)
		return {
			model: modifyFields(model, {
				values: () => values,
				highlightedIndex: () => index,
			}),
			outMessage: OutMessage.ToggledItem({ value, values }),
		}
	},
	PressedArrowKey: (model, { index }) => ({
		model: modifyFields(model, { highlightedIndex: () => index }),
		commands: [FocusItem({ selector: itemSelector(model.label, index) })],
	}),
	CompletedFocusItem: ToggleGroupDefinition.makeNoopStep(),
	RequestedValues: (model, { values }) => ({
		model: modifyFields(model, { values: () => values }),
	}),
})

// VIEW

/** `children` replaces the plain label (a dot and a count); `className` is the item's own. */
export type ToggleGroupItem = Readonly<{
	value: string
	label: string
	children?: ReadonlyArray<Html | string>
	className?: string
}>

export type ViewInputs = Readonly<{
	items: ReadonlyArray<ToggleGroupItem>
	/** Overrides the Model's pressed values when the parent controls them (e.g. from the URL). */
	selectedValues?: ReadonlyArray<string>
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
export const view = ToggleGroupComposition.makeView.withInputs<ViewInputs>((model, config, h) => {
	const { items } = config
	const values = config.selectedValues ?? model.values
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
					isPressed: values.includes(item.value),
					onClick: Message.ClickedItem({ value: item.value, index }),
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
								Message.PressedArrowKey({ index: target }),
							),
						),
					],
				},
				item.children ?? [item.label],
			),
		),
	)
})

const prepare = () =>
	ToggleGroupComposition.prepareBlock({
		init,
		update,
		view,
		operations: { requestValues: Message.RequestedValues },
		EffectsLayer: FocusItem.layer,
	})
export const ToggleGroupBlock: Block.FromAssemblyWithViewAndOutMessage<typeof Model, typeof prepare> =
	Block.assemble(prepare)

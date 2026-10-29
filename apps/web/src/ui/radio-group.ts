import { cn } from "@maple/ui/lib/utils"
import { radioGroupStyles, radioIndicatorStyles, radioStyles } from "@maple/ui/styles/ui/radio-group"
import { Effect, Option, Schema } from "effect"
import { Block, Dom } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { hiddenInput, labelIdOf, toggleKey } from "./choice"

/**
 * Base UI `RadioGroup`. The parent owns the checked value and passes it in as `selectedValue`;
 * the group reports picks through the `Selected` OutMessage. The checked radio is the group's tab
 * stop; arrow keys move to the next enabled radio and check it, as a native radio group does.
 */

// MODEL

export const Model = Schema.Struct({})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
	SelectedRadio: { value: Schema.String },
	PressedArrowKey: { value: Schema.String, id: Schema.String },
	CompletedFocusRadio: {},
})
export type Message = typeof Message.Type

// OUT MESSAGE

export const OutMessage = defineMessageUnion({
	Selected: { value: Schema.String },
})
export type OutMessage = typeof OutMessage.Type

const RadioGroupDefinition = Block.makeDefinition("RadioGroup", { Model, Message, OutMessage })

const RadioGroupComposition = RadioGroupDefinition.makeComposition()
type RadioGroupViewBuilder = Block.ViewBuilderFor<typeof RadioGroupComposition>

// COMMAND

export const FocusRadio = RadioGroupDefinition.makeCommand("FocusRadio", {
	args: { id: Schema.String },
	messages: [Message.CompletedFocusRadio],
	handler: function* () {
		return ({ id }) =>
			Dom.focus(`#${CSS.escape(id)}`).pipe(Effect.ignore, Effect.as(Message.CompletedFocusRadio()))
	},
})

// INIT

const init = RadioGroupComposition.makeInit(() => ({ model: Model.make({}) }))

// UPDATE

const update = RadioGroupComposition.makeUpdate({
	SelectedRadio: (model, { value }) => ({
		model,
		outMessage: OutMessage.Selected({ value }),
	}),
	PressedArrowKey: (model, { value, id }) => ({
		model,
		commands: [FocusRadio({ id })],
		outMessage: OutMessage.Selected({ value }),
	}),
	CompletedFocusRadio: RadioGroupDefinition.makeNoopStep(),
})

// VIEW

/**
 * One radio. `className` lands on the radio span. `primitive` is `RadioPrimitive.Root` with its
 * own classes and children (no label, slot or indicator).
 */
export type RadioItem = Readonly<{
	value: string
	id: string
	inputId: string
	isDisabled?: boolean
	className?: string
	primitive?: Readonly<{ children: ReadonlyArray<Html | string> }>
}>

/** Per-render inputs passed through `RadioGroupBinding.embedView({ viewInputs })`. */
export type ViewInputs = Readonly<{
	items: ReadonlyArray<RadioItem>
	selectedValue: Option.Option<string>
	toView: (render: RenderInfo) => Html
}>

/** Published to `toView`: `radio(value)` returns the prebuilt radio span and hidden native radio. */
export type RenderInfo = Readonly<{
	radio: (value: string) => ReadonlyArray<Html>
	selectedValue: Option.Option<string>
}>

/** `<RadioGroup>`: the `role="radiogroup"` container. */
export const radioGroup = <ParentMessage>(
	h: HtmlBuilder<ParentMessage>,
	options: Readonly<{ label?: string; className?: string }>,
	children: ReadonlyArray<Html>,
): Html =>
	h.div(
		[
			...(options.label === undefined ? [] : [h.AriaLabel(options.label)]),
			h.Class(cn(radioGroupStyles, options.className)),
			h.DataAttribute("slot", "radio-group"),
			h.Role("radiogroup"),
		],
		children,
	)

/** The tab stop: the checked radio, else the first enabled one. */
const tabStop = (viewInputs: ViewInputs): Option.Option<string> =>
	Option.isSome(viewInputs.selectedValue)
		? viewInputs.selectedValue
		: Option.map(
				Option.fromNullishOr(viewInputs.items.find((item) => item.isDisabled !== true)),
				(item) => item.value,
			)

const arrowTarget = (viewInputs: ViewInputs, value: string, key: string): Option.Option<RadioItem> => {
	const enabled = viewInputs.items.filter((item) => item.isDisabled !== true)
	const index = enabled.findIndex((item) => item.value === value)
	const step =
		key === "ArrowRight" || key === "ArrowDown" ? 1 : key === "ArrowLeft" || key === "ArrowUp" ? -1 : 0
	if (step === 0 || index === -1) return Option.none()
	return Option.fromNullishOr(enabled[(index + step + enabled.length) % enabled.length])
}

export const labelId = labelIdOf

/** `<Radio>`: the `role="radio"` span, its indicator while checked, and the hidden native radio. */
const radioNodes = (h: RadioGroupViewBuilder, viewInputs: ViewInputs, item: RadioItem): ReadonlyArray<Html> => {
	const { value, className, primitive } = item
	const isDisabled = item.isDisabled ?? false
	const checked = Option.contains(viewInputs.selectedValue, value)
	const isTabStop = !isDisabled && Option.contains(tabStop(viewInputs), value)
	const select = Message.SelectedRadio({ value })
	const stateAttribute = h.DataAttribute(checked ? "checked" : "unchecked", "")
	return [
		h.span(
			[
				h.Id(item.id),
				h.Role("radio"),
				h.AriaChecked(checked),
				...(primitive === undefined ? [h.AriaLabelledBy(labelIdOf(item.inputId))] : []),
				...(isDisabled ? [h.AriaDisabled(true), h.DataAttribute("disabled", "")] : []),
				h.Class(primitive === undefined ? cn(radioStyles, className) : (className ?? "")),
				stateAttribute,
				...(checked ? [h.DataAttribute("composite-item-active", "")] : []),
				...(primitive === undefined ? [h.DataAttribute("slot", "radio")] : []),
				h.Tabindex(isTabStop ? 0 : -1),
				...(isDisabled
					? []
					: [
							h.OnClick(select, { defaultAction: "Prevent" }),
							h.OnKeyDownPreventDefault((key) =>
								Option.orElse(toggleKey<Message>(key, select), () =>
									Option.map(arrowTarget(viewInputs, value, key), (target) =>
										Message.PressedArrowKey({ value: target.value, id: target.id }),
									),
								),
							),
						]),
			],
			primitive !== undefined
				? primitive.children
				: checked
					? [
							h.span([
								h.Class(radioIndicatorStyles),
								stateAttribute,
								h.DataAttribute("slot", "radio-indicator"),
							]),
						]
					: [],
		),
		hiddenInput(h, {
			id: item.inputId,
			type: "radio",
			value,
			isChecked: checked,
			isDisabled,
			onActivate: Option.some(select),
		}),
	]
}

// Radios are built here, in the group's boundary, so their handlers dispatch the group's
// Messages; `toView` runs in the parent's boundary and only places them.
const view = RadioGroupComposition.makeView.withInputs<ViewInputs>((_model, viewInputs, h) => {
	const nodes = new Map(viewInputs.items.map((item) => [item.value, radioNodes(h, viewInputs, item)]))
	return viewInputs.toView({
		radio: (value) => nodes.get(value) ?? [],
		selectedValue: viewInputs.selectedValue,
	})
})

const prepare = () =>
	RadioGroupComposition.prepareBlock({
		init,
		update,
		view,
		EffectsLayer: FocusRadio.layer,
	})
export const RadioGroupBlock: Block.FromAssemblyWithViewAndOutMessage<typeof Model, typeof prepare> =
	Block.assemble(prepare)

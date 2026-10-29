import { cn } from "@maple/ui/lib/utils"
import {
	tooltipPopupStyles,
	tooltipPositionerStyles,
	tooltipViewportStyles,
} from "@maple/ui/styles/ui/tooltip"
import { Duration, Effect, Layer, Number, Option, Schema, Stream } from "effect"
import { Block, Update } from "foldkit"
import { type ChildAttribute, childAttributes, type Html } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { anchoredPopup } from "./overlay/anchored"
import { fitPositionerToPopup } from "./overlay/auto-resize"
import {
	initPopup,
	PopupState,
	PopupTransitionBlock,
	popupId,
	portalId,
	triggerId,
} from "./overlay/popup-state"
import { Align, positionDefaults, Side } from "./overlay/position"
import { isMounted, stateAttributes } from "./overlay/transition"

/**
 * Base UI `Tooltip` (`@maple/ui/tooltip`): opens after the pointer rests on a trigger (600 ms),
 * closes when it leaves (no close delay), on a press of the trigger and on Escape. One Model can
 * serve many triggers (a collapsed sidebar rail): `triggerId` is the one it is anchored to.
 */

// MODEL

export const Model = Schema.Struct({
	...PopupState.fields,
	hoverGeneration: Schema.Number,
	triggerId: Schema.String,
	requestedSide: Side,
	requestedAlign: Align,
	sideOffset: Schema.Number,
	/** The provider's `delay` (`TooltipProvider delay={250}`); Base UI's default is 600. */
	openDelayMs: Schema.Number,
	/** A press on a trigger is under way: the focus it brings is not keyboard focus. */
	isPressingTrigger: Schema.Boolean,
})
export type Model = typeof Model.Type

export const OPEN_DELAY = Duration.millis(600)

export type InitOptions = Readonly<{
	isOpen?: boolean
	side?: Side
	align?: Align
	sideOffset?: number
	openDelayMs?: number
}>

/** `<TooltipPopup>`'s defaults: above the trigger, centred, 4px away. */
const initialModel = (id: string, options: InitOptions = {}): Model => {
	const side = options.side ?? "top"
	const align = options.align ?? "center"
	return {
		...initPopup(id, { isOpen: options.isOpen, side, align }),
		hoverGeneration: 0,
		isPressingTrigger: false,
		triggerId: triggerId(id),
		requestedSide: side,
		requestedAlign: align,
		sideOffset: options.sideOffset ?? 4,
		openDelayMs: options.openDelayMs ?? Duration.toMillis(OPEN_DELAY),
	}
}

// MESSAGE

export const Message = defineMessageUnion({
	EnteredTrigger: { triggerId: Schema.String },
	LeftTrigger: {},
	PressedTrigger: {},
	FocusedTrigger: { triggerId: Schema.String },
	BlurredTrigger: {},
	CheckedFocusVisible: { triggerId: Schema.String, isFocusVisible: Schema.Boolean },
	ElapsedOpenDelay: { generation: Schema.Number },
	PressedEscape: {},
	CompletedMountTooltip: {},
	ChangedPlacement: { side: Side, align: Align },
	RequestedReset: {},
})
export type Message = typeof Message.Type

// DEFINITION

const TooltipDefinition = Block.makeDefinition("Tooltip", { Model, Message })
const { makeStep, makeFieldsStep, makeNoopStep } = TooltipDefinition

/** The enter/exit transition; `initialModel` builds it, so the Binding does not init it. */
const AnimationBinding = TooltipDefinition.makeBinding(PopupTransitionBlock, { field: "animation", init: false })

// COMMAND

/** The open delay; a newer pointer move bumps the generation and drops this one. */
export const WaitOpenDelay = TooltipDefinition.makeCommand("WaitOpenDelay", {
	args: { generation: Schema.Number, millis: Schema.Number },
	messages: [Message.ElapsedOpenDelay],
	handler: function* () {
		return ({ generation, millis }) =>
			Effect.sleep(Duration.millis(millis)).pipe(Effect.as(Message.ElapsedOpenDelay({ generation })))
	},
})

/** Base UI opens on focus only when it is `:focus-visible`: focus returned by a closing popup is not. */
export const CheckFocusVisible = TooltipDefinition.makeCommand("CheckTooltipFocusVisible", {
	args: { triggerId: Schema.String },
	messages: [Message.CheckedFocusVisible],
	handler: function* () {
		return ({ triggerId: focusedId }) =>
			Effect.sync(() =>
				Message.CheckedFocusVisible({
					triggerId: focusedId,
					isFocusVisible: document.getElementById(focusedId)?.matches(":focus-visible") === true,
				}),
			)
	},
})

// MOUNT

/** Portal and placement only: a tooltip neither marks the page nor moves focus. */
export const MountTooltip = TooltipDefinition.makeMountStream("MountTooltip", {
	args: {
		id: Schema.String,
		triggerId: Schema.String,
		side: Side,
		align: Align,
		sideOffset: Schema.Number,
	},
	messages: [Message.CompletedMountTooltip, Message.ChangedPlacement],
	handler: function* () {
		return ({ element, id, triggerId: anchorId, side, align, sideOffset }) =>
			anchoredPopup(element, {
				positionerSelector: "[data-slot=tooltip-positioner]",
				popupSelector: `#${CSS.escape(popupId(id))}`,
				config: {
					...positionDefaults,
					anchor: { _tag: "Element", id: anchorId },
					side,
					align,
					sideOffset,
					adaptiveOrigin: true,
				},
				insideSelectors: [],
				markOutside: Option.none(),
				lockScroll: false,
				focus: Option.none(),
				afterPlace: fitPositionerToPopup,
			}).pipe(
				Stream.filter((event) => event._tag !== "PressedOutside"),
				Stream.map((event) =>
					event._tag === "Placed"
						? Message.ChangedPlacement({ side: event.placed.side, align: event.placed.align })
						: Message.CompletedMountTooltip(),
				),
			)
	},
})

/** The handlers this Block owns; the Animation Binding brings its own. */
const EffectsLayer = Layer.mergeAll(WaitOpenDelay.layer, CheckFocusVisible.layer, MountTooltip.layer)

// COMPOSITION

const TooltipComposition = TooltipDefinition.makeComposition({
	bindings: [AnimationBinding],
	mounts: [MountTooltip],
})
type H = Block.ViewBuilderFor<typeof TooltipComposition>

// INIT

const init = TooltipComposition.makeInit((id: string, options: InitOptions = {}) => ({
	model: initialModel(id, options),
}))

// UPDATE

const cancelledStep = makeFieldsStep(() => ({ hoverGeneration: Number.increment }))

const openStep = makeStep((model) =>
	model.isOpen
		? makeNoopStep()
		: Update.combineSteps([makeFieldsStep(() => ({ isOpen: () => true })), AnimationBinding.requestShow()]),
)

const closeStep = makeStep((model) =>
	model.isOpen
		? Update.combineSteps([makeFieldsStep(() => ({ isOpen: () => false })), AnimationBinding.requestHide()])
		: makeNoopStep(),
)

/** Closes and drops any pending open. */
const cancelAndCloseStep = Update.combineSteps([cancelledStep, closeStep])

const enterStep = makeStep((model, nextTriggerId: string) => {
	// Moving between triggers of one open tooltip re-anchors it at once, like a Base UI handle.
	const generation = Number.increment(model.hoverGeneration)
	if (model.isOpen) return { model: { ...model, hoverGeneration: generation, triggerId: nextTriggerId } }
	return {
		model: { ...model, hoverGeneration: generation, triggerId: nextTriggerId },
		commands: [WaitOpenDelay({ generation, millis: model.openDelayMs })],
	}
})

const update = TooltipComposition.makeUpdate({
	EnteredTrigger: (model, { triggerId: nextTriggerId }) => enterStep(model, nextTriggerId),
	LeftTrigger: (model) =>
		Update.combineSteps([makeFieldsStep(() => ({ isPressingTrigger: () => false })), cancelAndCloseStep])(model),
	PressedTrigger: (model) =>
		Update.combineSteps([makeFieldsStep(() => ({ isPressingTrigger: () => true })), cancelAndCloseStep])(model),
	// Base UI opens on keyboard focus (focus-visible) at once; a press's focus does not open it.
	FocusedTrigger: (model, { triggerId: focusedId }) =>
		model.isPressingTrigger
			? { model: { ...model, isPressingTrigger: false } }
			: { model, commands: [CheckFocusVisible({ triggerId: focusedId })] },
	CheckedFocusVisible: (model, { triggerId: focusedId, isFocusVisible }) =>
		isFocusVisible
			? Update.combineSteps([
					cancelledStep,
					makeFieldsStep(() => ({ triggerId: () => focusedId })),
					openStep,
				])(model)
			: makeNoopStep()(model),
	BlurredTrigger: (model) => (model.isOpen ? cancelAndCloseStep(model) : makeNoopStep()(model)),
	ElapsedOpenDelay: (model, { generation }) =>
		generation === model.hoverGeneration ? openStep(model) : makeNoopStep()(model),
	PressedEscape: (model) => cancelAndCloseStep(model),
	CompletedMountTooltip: (model) => ({ model }),
	ChangedPlacement: (model, { side, align }) => ({ model: { ...model, side, align } }),
	// Back to its initial state at once (no exit transition), keeping its placement options.
	RequestedReset: (model) => ({
		model: initialModel(model.id, {
			side: model.requestedSide,
			align: model.requestedAlign,
			sideOffset: model.sideOffset,
			openDelayMs: model.openDelayMs,
		}),
	}),
})


// VIEW

export type RenderInfo = Readonly<{
	/** `<TooltipTrigger>`'s attributes for the trigger with this id (the default trigger without one). */
	trigger: (id?: string) => ReadonlyArray<ChildAttribute>
	/** The portal while open (or closing), else null; the parent places it last. */
	portal: Html | null
}>

export type ViewInputs = Readonly<{
	toView: (render: RenderInfo) => Html
	/** The popup's content for the trigger it is anchored to. */
	toContent: (triggerId: string) => ReadonlyArray<Html | string>
	/** Every trigger id `trigger(id)` is asked for; the default trigger alone without it. */
	triggerIds?: ReadonlyArray<string>
	/** Overrides the Model's requested side, for one Model shared by triggers on different sides. */
	side?: Side
	className?: string
}>

const portalView = (h: H, model: Model, inputs: ViewInputs) => {
	const state = stateAttributes(h, model.isOpen, model.animation)
	const placement = [h.DataAttribute("align", model.align), ...state, h.DataAttribute("side", model.side)]
	return h.div(
		[
			// Keyed by the trigger, so moving to another trigger re-runs the Mount against it.
			h.Key(`${portalId(model.id)}-${model.triggerId}`),
			h.DataAttribute("base-ui-portal", ""),
			h.Id(portalId(model.id)),
			h.OnMount(
				MountTooltip({
					id: model.id,
					triggerId: model.triggerId,
					side: inputs.side ?? model.requestedSide,
					align: model.requestedAlign,
					sideOffset: model.sideOffset,
				}),
			),
		],
		[
			h.div(
				[
					h.Class(tooltipPositionerStyles),
					...placement,
					h.DataAttribute("slot", "tooltip-positioner"),
					h.Role("presentation"),
				],
				[
					h.div(
						[
							h.Class(cn(tooltipPopupStyles, inputs.className)),
							...placement,
							h.DataAttribute("base-ui-focusable", ""),
							h.DataAttribute("slot", "tooltip-popup"),
							h.Id(popupId(model.id)),
							h.Style({ "--popup-width": "auto", "--popup-height": "auto" }),
							h.Tabindex(-1),
							h.OnKeyDownPreventDefault((key) =>
								key === "Escape" ? Option.some(Message.PressedEscape()) : Option.none(),
							),
						],
						[
							h.div(
								[h.Class(tooltipViewportStyles), h.DataAttribute("slot", "tooltip-viewport")],
								[
									h.div(
										[h.DataAttribute("current", "true")],
										inputs.toContent(model.triggerId),
									),
								],
							),
						],
					),
				],
			),
		],
	)
}

const view = TooltipComposition.makeView.withInputs<ViewInputs>((model, inputs, h) => {
	const attributesOf = (id: string) =>
		childAttributes([
			h.DataAttribute("base-ui-tooltip-trigger", ""),
			...(model.isOpen && id === model.triggerId ? [h.DataAttribute("popup-open", "")] : []),
			h.Id(id),
			h.OnMouseEnter(Message.EnteredTrigger({ triggerId: id })),
			h.OnMouseLeave(Message.LeftTrigger()),
			h.OnPointerDown(() => Option.some(Message.PressedTrigger())),
			h.OnFocus(Message.FocusedTrigger({ triggerId: id })),
			h.OnBlur(Message.BlurredTrigger()),
		])
	// Built here, not when `toView` asks: handlers bind to the boundary that builds them.
	const triggers = new Map(
		(inputs.triggerIds ?? [triggerId(model.id)]).map(
			(id): readonly [string, ReadonlyArray<ChildAttribute>] => [id, attributesOf(id)],
		),
	)
	const trigger = (id: string = triggerId(model.id)) => triggers.get(id) ?? []
	const portal = isMounted(model.isOpen, model.animation) ? portalView(h, model, inputs) : null
	return inputs.toView({ trigger, portal })
})

// BLOCK

const prepare = () =>
	TooltipComposition.prepareBlock({
		init,
		update,
		view,
		operations: { requestReset: Message.RequestedReset },
		EffectsLayer,
	})
export const TooltipBlock: Block.FromAssemblyWithView<typeof Model, typeof prepare> = Block.assemble(prepare)

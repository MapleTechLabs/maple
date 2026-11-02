import * as Animation from "@foldkit/ui/animation"
import { iconButtonTooltipStyles } from "@maple/ui/styles/ui/icon-button"
import { cn } from "@maple/ui/lib/utils"
import {
	tooltipPopupStyles,
	tooltipPositionerStyles,
	tooltipViewportStyles,
} from "@maple/ui/styles/ui/tooltip"
import { Duration, Effect, Number, Option, Schema, Stream } from "effect"
import { Command, Mount, Submodel, type Update } from "foldkit"
import {
	type Attribute,
	type ChildAttribute,
	childAttributes,
	type Html,
	type HtmlBuilder,
} from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { anchoredPopup } from "./overlay/anchored"
import { fitPositionerToPopup } from "./overlay/auto-resize"
import { initPopup, makeTransition, PopupState, popupId, portalId, triggerId } from "./overlay/popup-state"
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
export const init = (id: string, options: InitOptions = {}): Model => {
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
	GotAnimationMessage: { message: Animation.Message },
})
export type Message = typeof Message.Type

// UPDATE

/** The open delay; a newer pointer move bumps the generation and drops this one. */
export const WaitOpenDelay = Command.define("WaitOpenDelay", {
	args: { generation: Schema.Number, millis: Schema.Number },
	messages: [Message.ElapsedOpenDelay],
	execute: ({ generation, millis }) =>
		Effect.sleep(Duration.millis(millis)).pipe(Effect.as(Message.ElapsedOpenDelay({ generation }))),
})

/** Base UI opens on focus only when it is `:focus-visible`: focus returned by a closing popup is not. */
export const CheckFocusVisible = Command.define("CheckTooltipFocusVisible", {
	args: { triggerId: Schema.String },
	messages: [Message.CheckedFocusVisible],
	execute: ({ triggerId: focusedId }) =>
		Effect.sync(() =>
			Message.CheckedFocusVisible({
				triggerId: focusedId,
				isFocusVisible: document.getElementById(focusedId)?.matches(":focus-visible") === true,
			}),
		),
})

const transition = makeTransition<Model, Message>(
	(message) => Message.GotAnimationMessage({ message }),
	"WaitForTooltipExit",
)
type UpdateReturn = Update.Return<Model, Message>

const cancelled = (model: Model): Model => ({
	...model,
	hoverGeneration: Number.increment(model.hoverGeneration),
})

/** Closes and drops any pending open. */
const close = (model: Model): UpdateReturn => transition.close(cancelled(model))

const enter = (model: Model, nextTriggerId: string): UpdateReturn => {
	// Moving between triggers of one open tooltip re-anchors it at once, like a Base UI handle.
	if (model.isOpen) return { model: { ...cancelled(model), triggerId: nextTriggerId } }
	const generation = Number.increment(model.hoverGeneration)
	return {
		model: { ...model, hoverGeneration: generation, triggerId: nextTriggerId },
		commands: [WaitOpenDelay({ generation, millis: model.openDelayMs })],
	}
}

export const update = (model: Model, message: Message): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		EnteredTrigger: ({ triggerId: nextTriggerId }) => enter(model, nextTriggerId),
		LeftTrigger: () => close({ ...model, isPressingTrigger: false }),
		PressedTrigger: () => close({ ...model, isPressingTrigger: true }),
		// Base UI opens on keyboard focus (focus-visible) at once; a press's focus does not open it.
		FocusedTrigger: ({ triggerId: focusedId }) =>
			model.isPressingTrigger
				? { model: { ...model, isPressingTrigger: false } }
				: { model, commands: [CheckFocusVisible({ triggerId: focusedId })] },
		CheckedFocusVisible: ({ triggerId: focusedId, isFocusVisible }) =>
			isFocusVisible ? transition.open({ ...cancelled(model), triggerId: focusedId }) : { model },
		BlurredTrigger: () => (model.isOpen ? close(model) : { model }),
		ElapsedOpenDelay: ({ generation }) =>
			generation === model.hoverGeneration ? transition.open(model) : { model },
		PressedEscape: () => close(model),
		CompletedMountTooltip: () => ({ model }),
		ChangedPlacement: ({ side, align }) => ({ model: { ...model, side, align } }),
		GotAnimationMessage: ({ message: animationMessage }) =>
			transition.foldAnimation(model, animationMessage),
	})

// MOUNT

/** Portal and placement only: a tooltip neither marks the page nor moves focus. */
export const MountTooltip = Mount.defineStream("MountTooltip", {
	args: {
		id: Schema.String,
		triggerId: Schema.String,
		side: Side,
		align: Align,
		sideOffset: Schema.Number,
	},
	messages: [Message.CompletedMountTooltip, Message.ChangedPlacement],
	execute: ({ element, id, triggerId: anchorId, side, align, sideOffset }) =>
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
		),
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
	/** `"icon-button"`: `IconButton`'s popup layout (its label beside a shortcut). */
	layout?: "icon-button"
	className?: string
}>

type H = HtmlBuilder<Message>

const portalView = (h: H, model: Model, inputs: ViewInputs, placement: ReadonlyArray<Attribute<Message>>) =>
	h.div(
		[
			// Keyed by the trigger, so moving to another trigger re-runs the Mount against it.
			h.Key(`${portalId(model.id)}-${model.triggerId}`),
			h.DataAttribute("base-ui-portal", ""),
			h.Id(portalId(model.id)),
			h.OnMount(
				MountTooltip({
					id: model.id,
					triggerId: model.triggerId,
					side: model.requestedSide,
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
							h.Class(
								cn(
									tooltipPopupStyles,
									inputs.layout === "icon-button" && iconButtonTooltipStyles,
									inputs.className,
								),
							),
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

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) => {
	const state = stateAttributes(h, model.isOpen, model.animation)
	const placement = [h.DataAttribute("align", model.align), ...state, h.DataAttribute("side", model.side)]
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
	const portal = isMounted(model.isOpen, model.animation) ? portalView(h, model, inputs, placement) : null
	return inputs.toView({ trigger, portal })
})

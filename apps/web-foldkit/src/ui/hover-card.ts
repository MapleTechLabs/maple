import * as Animation from "@foldkit/ui/animation"
import { cn } from "@maple/ui/lib/utils"
import { hoverCardContentStyles, hoverCardPositionerStyles } from "@maple/ui/styles/ui/hover-card"
import { Duration, Effect, Number, Option, Schema, Stream } from "effect"
import { Command, Mount, Submodel, type Update } from "foldkit"
import { type ChildAttribute, childAttributes, type Html } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { anchoredPopup } from "./overlay/anchored"
import { initPopup, makeTransition, PopupState, popupId, portalId, triggerId } from "./overlay/popup-state"
import { Align, positionDefaults, Side } from "./overlay/position"
import { isMounted, stateAttributes } from "./overlay/transition"

/**
 * Base UI `PreviewCard` (`@maple/ui/hover-card`): opens after the pointer rests on the trigger
 * (600 ms), closes after it leaves trigger and card (300 ms), placed below with offsets 4 and 4.
 */

// MODEL

export const Model = Schema.Struct({ ...PopupState.fields, hoverGeneration: Schema.Number })
export type Model = typeof Model.Type

export const OPEN_DELAY = Duration.millis(600)
export const CLOSE_DELAY = Duration.millis(300)

export const init = (id: string, options: Readonly<{ isOpen?: boolean }> = {}): Model => ({
	...initPopup(id, { ...options, side: "bottom", align: "center" }),
	hoverGeneration: 0,
})

// MESSAGE

export const Message = defineMessageUnion({
	EnteredTrigger: {},
	LeftTrigger: {},
	EnteredCard: {},
	LeftCard: {},
	ElapsedHoverDelay: { generation: Schema.Number, isOpening: Schema.Boolean },
	PressedEscape: {},
	CompletedMountHoverCard: {},
	ChangedPlacement: { side: Side, align: Align },
	GotAnimationMessage: { message: Animation.Message },
})
export type Message = typeof Message.Type

// UPDATE

/** The open or close delay; a newer pointer move bumps the generation and drops this one. */
export const WaitHoverDelay = Command.define("WaitHoverDelay", {
	args: { generation: Schema.Number, isOpening: Schema.Boolean },
	messages: [Message.ElapsedHoverDelay],
	execute: ({ generation, isOpening }) =>
		Effect.sleep(isOpening ? OPEN_DELAY : CLOSE_DELAY).pipe(
			Effect.as(Message.ElapsedHoverDelay({ generation, isOpening })),
		),
})

const transition = makeTransition<Model, Message>(
	(message) => Message.GotAnimationMessage({ message }),
	"WaitForHoverCardExit",
)
export const WaitForHoverCardExit = transition.WaitForExit

type UpdateReturn = Update.Return<Model, Message>

const schedule = (model: Model, isOpening: boolean): UpdateReturn => {
	const generation = Number.increment(model.hoverGeneration)
	return {
		model: { ...model, hoverGeneration: generation },
		commands: [WaitHoverDelay({ generation, isOpening })],
	}
}

/** Entering cancels a pending close; leaving cancels a pending open. */
const cancel = (model: Model): UpdateReturn => ({
	model: { ...model, hoverGeneration: Number.increment(model.hoverGeneration) },
})

export const update = (model: Model, message: Message): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		EnteredTrigger: () => (model.isOpen ? cancel(model) : schedule(model, true)),
		LeftTrigger: () => (model.isOpen ? schedule(model, false) : cancel(model)),
		EnteredCard: () => cancel(model),
		LeftCard: () => schedule(model, false),
		ElapsedHoverDelay: ({ generation, isOpening }) =>
			generation !== model.hoverGeneration
				? { model }
				: isOpening
					? transition.open(model)
					: transition.close(model),
		PressedEscape: () => transition.close(model),
		CompletedMountHoverCard: () => ({ model }),
		ChangedPlacement: ({ side, align }) => ({ model: { ...model, side, align } }),
		GotAnimationMessage: ({ message: animationMessage }) =>
			transition.foldAnimation(model, animationMessage),
	})

// MOUNT

/** Portal and placement only: a preview card neither marks the page nor moves focus. */
export const MountHoverCard = Mount.defineStream("MountHoverCard", {
	args: { id: Schema.String },
	messages: [Message.CompletedMountHoverCard, Message.ChangedPlacement],
	execute: ({ element, id }) =>
		anchoredPopup(element, {
			positionerSelector: "[role=presentation]",
			popupSelector: "[data-slot=hover-card-content]",
			config: {
				...positionDefaults,
				anchor: { _tag: "Element", id: triggerId(id) },
				side: "bottom",
				align: "center",
				sideOffset: 4,
				alignOffset: 4,
			},
			insideSelectors: [],
			markOutside: Option.none(),
			lockScroll: false,
			focus: Option.none(),
		}).pipe(
			Stream.filter((event) => event._tag !== "PressedOutside"),
			Stream.map((event) =>
				event._tag === "Placed"
					? Message.ChangedPlacement({ side: event.placed.side, align: event.placed.align })
					: Message.CompletedMountHoverCard(),
			),
		),
})

// VIEW

export type RenderInfo = Readonly<{ trigger: ReadonlyArray<ChildAttribute>; portal: Html }>

export type ViewInputs = Readonly<{
	toView: (render: RenderInfo) => Html
	toContent: () => ReadonlyArray<Html>
	className?: string
}>

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) => {
	const state = stateAttributes(h, model.isOpen, model.animation)
	const placement = [h.DataAttribute("align", model.align)]
	const side = [h.DataAttribute("side", model.side)]
	const trigger = childAttributes([
		...(model.isOpen ? [h.DataAttribute("popup-open", "")] : []),
		h.DataAttribute("slot", "hover-card-trigger"),
		h.Id(triggerId(model.id)),
		h.OnMouseEnter(Message.EnteredTrigger()),
		h.OnMouseLeave(Message.LeftTrigger()),
	])
	const portal = isMounted(model.isOpen, model.animation)
		? h.div(
				[
					h.Key(portalId(model.id)),
					h.DataAttribute("base-ui-portal", ""),
					h.DataAttribute("slot", "hover-card-portal"),
					h.Id(portalId(model.id)),
					h.OnMount(MountHoverCard({ id: model.id })),
				],
				[
					h.div(
						[
							h.Class(hoverCardPositionerStyles),
							...placement,
							...state,
							...side,
							h.Role("presentation"),
						],
						[
							h.div(
								[
									h.Class(cn(hoverCardContentStyles, inputs.className)),
									...placement,
									h.DataAttribute("base-ui-focusable", ""),
									...state,
									...side,
									h.DataAttribute("slot", "hover-card-content"),
									h.Id(popupId(model.id)),
									h.Tabindex(-1),
									h.OnMouseEnter(Message.EnteredCard()),
									h.OnMouseLeave(Message.LeftCard()),
									h.OnKeyDownPreventDefault((key) =>
										key === "Escape"
											? Option.some(Message.PressedEscape())
											: Option.none(),
									),
								],
								inputs.toContent(),
							),
						],
					),
				],
			)
		: null
	return inputs.toView({ trigger, portal })
})

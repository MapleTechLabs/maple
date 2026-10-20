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
 * (600 ms, or the trigger's `delay`), closes after it leaves trigger and card (300 ms), placed
 * below with offsets 4 and 4 unless `HoverCardContent` says otherwise. One Model can serve many
 * triggers (a table's commit cells): `triggerId` is the one it is anchored to.
 */

// MODEL

export const Model = Schema.Struct({
	...PopupState.fields,
	hoverGeneration: Schema.Number,
	triggerId: Schema.String,
	openDelayMs: Schema.Number,
	requestedSide: Side,
	requestedAlign: Align,
	sideOffset: Schema.Number,
	alignOffset: Schema.Number,
})
export type Model = typeof Model.Type

export const OPEN_DELAY = Duration.millis(600)
export const CLOSE_DELAY = Duration.millis(300)

export type InitOptions = Readonly<{
	isOpen?: boolean
	/** `HoverCardTrigger delay` */
	openDelayMs?: number
	side?: Side
	align?: Align
	sideOffset?: number
	alignOffset?: number
}>

export const init = (id: string, options: InitOptions = {}): Model => {
	const side = options.side ?? "bottom"
	const align = options.align ?? "center"
	return {
		...initPopup(id, { isOpen: options.isOpen, side, align }),
		hoverGeneration: 0,
		triggerId: triggerId(id),
		openDelayMs: options.openDelayMs ?? Duration.toMillis(OPEN_DELAY),
		requestedSide: side,
		requestedAlign: align,
		sideOffset: options.sideOffset ?? 4,
		alignOffset: options.alignOffset ?? 4,
	}
}

// MESSAGE

export const Message = defineMessageUnion({
	EnteredTrigger: { triggerId: Schema.String },
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
	args: { generation: Schema.Number, isOpening: Schema.Boolean, openDelayMs: Schema.Number },
	messages: [Message.ElapsedHoverDelay],
	execute: ({ generation, isOpening, openDelayMs }) =>
		Effect.sleep(isOpening ? Duration.millis(openDelayMs) : CLOSE_DELAY).pipe(
			Effect.as(Message.ElapsedHoverDelay({ generation, isOpening })),
		),
})

const transition = makeTransition<Model, Message>(
	(message) => Message.GotAnimationMessage({ message }),
	"WaitForHoverCardExit",
)
type UpdateReturn = Update.Return<Model, Message>

const schedule = (model: Model, isOpening: boolean): UpdateReturn => {
	const generation = Number.increment(model.hoverGeneration)
	return {
		model: { ...model, hoverGeneration: generation },
		commands: [WaitHoverDelay({ generation, isOpening, openDelayMs: model.openDelayMs })],
	}
}

/** Entering cancels a pending close; leaving cancels a pending open. */
const cancel = (model: Model): UpdateReturn => ({
	model: { ...model, hoverGeneration: Number.increment(model.hoverGeneration) },
})

export const update = (model: Model, message: Message): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		// Moving to another trigger of an open card re-anchors it at once.
		EnteredTrigger: ({ triggerId: nextTriggerId }) =>
			model.isOpen
				? cancel({ ...model, triggerId: nextTriggerId })
				: schedule({ ...model, triggerId: nextTriggerId }, true),
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
	args: {
		id: Schema.String,
		triggerId: Schema.String,
		side: Side,
		align: Align,
		sideOffset: Schema.Number,
		alignOffset: Schema.Number,
	},
	messages: [Message.CompletedMountHoverCard, Message.ChangedPlacement],
	execute: ({ element, id, triggerId: anchorId, side, align, sideOffset, alignOffset }) =>
		anchoredPopup(element, {
			positionerSelector: "[role=presentation]",
			popupSelector: `#${CSS.escape(popupId(id))}`,
			config: {
				...positionDefaults,
				anchor: { _tag: "Element", id: anchorId },
				side,
				align,
				sideOffset,
				alignOffset,
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

export type RenderInfo = Readonly<{
	/** The default trigger's attributes. */
	trigger: ReadonlyArray<ChildAttribute>
	/** The attributes of the trigger with this id (one of `triggerIds`). */
	triggerFor: (id: string) => ReadonlyArray<ChildAttribute>
	portal: Html
}>

export type ViewInputs = Readonly<{
	toView: (render: RenderInfo) => Html
	/** The card's content for the trigger it is anchored to. */
	toContent: (triggerId: string) => ReadonlyArray<Html>
	/** Every trigger id `triggerFor(id)` is asked for, besides the default one. */
	triggerIds?: ReadonlyArray<string>
	className?: string
}>

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) => {
	const state = stateAttributes(h, model.isOpen, model.animation)
	const placement = [h.DataAttribute("align", model.align)]
	const side = [h.DataAttribute("side", model.side)]
	const attributesOf = (id: string) =>
		childAttributes([
			...(model.isOpen && id === model.triggerId ? [h.DataAttribute("popup-open", "")] : []),
			h.DataAttribute("slot", "hover-card-trigger"),
			h.Id(id),
			h.OnMouseEnter(Message.EnteredTrigger({ triggerId: id })),
			h.OnMouseLeave(Message.LeftTrigger()),
		])
	// Built here, not when `toView` asks: handlers bind to the boundary that builds them.
	const triggers = new Map(
		[triggerId(model.id), ...(inputs.triggerIds ?? [])].map(
			(id): readonly [string, ReadonlyArray<ChildAttribute>] => [id, attributesOf(id)],
		),
	)
	const trigger = triggers.get(triggerId(model.id)) ?? []
	const triggerFor = (id: string) => triggers.get(id) ?? []
	const portal = isMounted(model.isOpen, model.animation)
		? h.div(
				[
					// Keyed by the trigger, so moving to another trigger re-runs the Mount against it.
					h.Key(`${portalId(model.id)}-${model.triggerId}`),
					h.DataAttribute("base-ui-portal", ""),
					h.DataAttribute("slot", "hover-card-portal"),
					h.Id(portalId(model.id)),
					h.OnMount(
						MountHoverCard({
							id: model.id,
							triggerId: model.triggerId,
							side: model.requestedSide,
							align: model.requestedAlign,
							sideOffset: model.sideOffset,
							alignOffset: model.alignOffset,
						}),
					),
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
								inputs.toContent(model.triggerId),
							),
						],
					),
				],
			)
		: null
	return inputs.toView({ trigger, triggerFor, portal })
})

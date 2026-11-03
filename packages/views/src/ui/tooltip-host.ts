import { Duration, Effect, Option, Queue, Schema, Stream } from "effect"
import { Command, Dom, type Update } from "foldkit"
import { type Attribute, type Html, type HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { Side } from "./overlay/position"
import * as Tooltip from "./tooltip"

/**
 * The app's one tooltip: any element carrying `tooltipTrigger` opens it, through events delegated
 * on `document`, so stateless kit helpers get Base UI's tooltip without a Model of their own.
 */

const CONTENT_ATTRIBUTE = "data-tooltip"
const LAYOUT_ATTRIBUTE = "data-tooltip-layout"
const SIDE_ATTRIBUTE = "data-tooltip-side"
const OVERFLOW_ATTRIBUTE = "data-tooltip-overflow"
const ID_PREFIX = "maple-tooltip-trigger-"

export type TriggerOptions = Readonly<{
	/** `Tooltip.view`'s `layout`. */
	layout?: "icon-button"
	/** `<TooltipPopup side>`; above the trigger by default. */
	side?: Side
	/** Opens only while the trigger's text is cut off (`TruncatedText tooltip="overflow"`). */
	isOverflowOnly?: boolean
}>

/** `<TooltipTrigger>` + `<TooltipPopup>{content}</TooltipPopup>`. */
export const tooltipTrigger = <Message>(
	h: HtmlBuilder<Message>,
	content: string,
	options: TriggerOptions = {},
): ReadonlyArray<Attribute<Message>> => [
	h.DataAttribute("tooltip", content),
	...(options.layout === undefined ? [] : [h.DataAttribute("tooltip-layout", options.layout)]),
	...(options.side === undefined ? [] : [h.DataAttribute("tooltip-side", options.side)]),
	...(options.isOverflowOnly === true ? [h.DataAttribute("tooltip-overflow", "")] : []),
]

// MODEL

const Shown = Schema.Struct({ text: Schema.String, isIconButton: Schema.Boolean, side: Side })
type Shown = typeof Shown.Type

export const Model = Schema.Struct({
	tooltip: Tooltip.Model,
	/** The content by trigger id: the anchored trigger's and the one taking over. */
	shown: Schema.Record(Schema.String, Shown),
	/** A tooltip closed by leaving its trigger moments ago: the next trigger opens at once. */
	isWarm: Schema.Boolean,
	warmGeneration: Schema.Number,
	/** A trigger is hovered or focused: its tooltip is pending or open. */
	isEngaged: Schema.Boolean,
})
export type Model = typeof Model.Type

/** `TooltipProvider`'s `timeout`: how long after a close the next trigger skips the delay. */
const WARM_WINDOW_MS = 400

export const init = (id: string, options: Tooltip.InitOptions = {}): Model => ({
	tooltip: Tooltip.init(id, options),
	shown: {},
	isWarm: false,
	warmGeneration: 0,
	isEngaged: false,
})

// MESSAGE

export const Message = defineMessageUnion({
	EnteredTrigger: { triggerId: Schema.String, shown: Shown },
	FocusedTrigger: { triggerId: Schema.String, shown: Shown },
	/** A shown trigger's text changed under it (Copy, then Copied). */
	ChangedTriggerText: { triggerId: Schema.String, text: Schema.String },
	/** A trigger left the page without a leave or blur: a re-render or a closing panel. */
	RemovedTrigger: { triggerId: Schema.String },
	ElapsedWarmWindow: { generation: Schema.Number },
	GotTooltipMessage: { message: Tooltip.Message },
})
export type Message = typeof Message.Type

// UPDATE

type UpdateReturn = Update.Return<Model, Message>

const lift = (model: Model, step: ReturnType<typeof Tooltip.update>): UpdateReturn => ({
	model: { ...model, tooltip: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotTooltipMessage({ message })),
})

/** Keeps the anchored trigger's content until the next one is anchored, and drops the rest. */
const remember = (model: Model, triggerId: string, shown: Shown): Model => {
	const anchored = model.shown[model.tooltip.triggerId]
	const kept: ReadonlyArray<readonly [string, Shown]> =
		anchored === undefined
			? [[triggerId, shown]]
			: [
					[model.tooltip.triggerId, anchored],
					[triggerId, shown],
				]
	return {
		...model,
		isEngaged: true,
		tooltip: { ...model.tooltip, requestedSide: shown.side },
		shown: Object.fromEntries(kept),
	}
}

const WaitWarmWindow = Command.define("WaitTooltipWarmWindow", {
	args: { generation: Schema.Number },
	messages: [Message.ElapsedWarmWindow],
	execute: ({ generation }) =>
		Effect.sleep(Duration.millis(WARM_WINDOW_MS)).pipe(
			Effect.as(Message.ElapsedWarmWindow({ generation })),
		),
})

/** Enters the trigger; while warm, opens at once instead of waiting the delay. */
const enter = (model: Model, triggerId: string): UpdateReturn => {
	const entered = Tooltip.update(model.tooltip, Tooltip.Message.EnteredTrigger({ triggerId }))
	if (!model.isWarm || entered.model.isOpen) return lift(model, entered)
	const opened = Tooltip.update(
		entered.model,
		Tooltip.Message.ElapsedOpenDelay({ generation: entered.model.hoverGeneration }),
	)
	return lift({ ...model, isWarm: false }, opened)
}

/** Leaving an open tooltip's trigger closes it and warms the next trigger for a moment. */
const leave = (model: Model): UpdateReturn => {
	const left = lift(model, Tooltip.update(model.tooltip, Tooltip.Message.LeftTrigger()))
	if (!model.tooltip.isOpen) return left
	const generation = model.warmGeneration + 1
	return {
		model: { ...left.model, isWarm: true, warmGeneration: generation },
		commands: [...(left.commands ?? []), WaitWarmWindow({ generation })],
	}
}

const DISENGAGING: ReadonlySet<Tooltip.Message["_tag"]> = new Set([
	"LeftTrigger",
	"PressedTrigger",
	"BlurredTrigger",
	"PressedEscape",
])

export const update = (model: Model, message: Message): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		EnteredTrigger: ({ triggerId, shown }) => {
			return enter(remember(model, triggerId, shown), triggerId)
		},
		FocusedTrigger: ({ triggerId, shown }) => {
			const next = remember(model, triggerId, shown)
			return lift(next, Tooltip.update(next.tooltip, Tooltip.Message.FocusedTrigger({ triggerId })))
		},
		ChangedTriggerText: ({ triggerId, text }) => {
			const shown = model.shown[triggerId]
			return shown === undefined
				? { model }
				: { model: { ...model, shown: { ...model.shown, [triggerId]: { ...shown, text } } } }
		},
		RemovedTrigger: ({ triggerId }) =>
			triggerId === model.tooltip.triggerId && model.isEngaged
				? lift(
						{ ...model, isEngaged: false },
						Tooltip.update(model.tooltip, Tooltip.Message.LeftTrigger()),
					)
				: { model },
		ElapsedWarmWindow: ({ generation }) =>
			generation === model.warmGeneration ? { model: { ...model, isWarm: false } } : { model },
		GotTooltipMessage: ({ message: inner }) => {
			const disengaged = DISENGAGING.has(inner._tag) ? { ...model, isEngaged: false } : model
			return inner._tag === "LeftTrigger"
				? leave(disengaged)
				: lift(disengaged, Tooltip.update(model.tooltip, inner))
		},
	})

// SUBSCRIPTION

/** The trigger an event lands in, carrying its own text. */
const closestTrigger = (target: EventTarget | null): Option.Option<HTMLElement> => {
	if (!(target instanceof Element)) return Option.none()
	const trigger = target.closest(`[${CONTENT_ATTRIBUTE}]`)
	return trigger instanceof HTMLElement && trigger.getAttribute(CONTENT_ATTRIBUTE) !== ""
		? Option.some(trigger)
		: Option.none()
}

/** A trigger that may open now: an overflow-only one only while its text is cut off. */
const openableTrigger = (target: EventTarget | null): Option.Option<HTMLElement> =>
	Option.filter(
		closestTrigger(target),
		(trigger) => !trigger.hasAttribute(OVERFLOW_ATTRIBUTE) || trigger.scrollWidth > trigger.clientWidth,
	)

/** The trigger's id to anchor to, assigned once when the view gave it none. */
const anchorIdOf = (trigger: HTMLElement): string => {
	if (trigger.id === "")
		trigger.id = `${ID_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
	return trigger.id
}

const isInside = (trigger: Element, node: EventTarget | null) =>
	node instanceof Node && trigger.contains(node)

const decodeSide = Schema.decodeUnknownOption(Side)

const shownOf = (trigger: HTMLElement) => ({
	triggerId: anchorIdOf(trigger),
	shown: {
		text: trigger.getAttribute(CONTENT_ATTRIBUTE) ?? "",
		isIconButton: trigger.getAttribute(LAYOUT_ATTRIBUTE) === "icon-button",
		side: Option.getOrElse(decodeSide(trigger.getAttribute(SIDE_ATTRIBUTE)), (): Side => "top"),
	},
})

const toTooltip = (message: Tooltip.Message) => Message.GotTooltipMessage({ message })

/** Base UI opens on a mouse or pen resting on the trigger, never on touch. */
const isHoverPointer = (event: PointerEvent) => event.pointerType !== "touch"

const triggerStreams: ReadonlyArray<Stream.Stream<Message>> = [
	Dom.streamFromEventFilterMap({
		target: () => document,
		type: "pointerover",
		filterMapEvent: (event) =>
			Option.map(
				Option.filter(
					openableTrigger(event.target),
					(trigger) => isHoverPointer(event) && !isInside(trigger, event.relatedTarget),
				),
				(trigger) => Message.EnteredTrigger(shownOf(trigger)),
			),
	}),
	Dom.streamFromEventFilterMap({
		target: () => document,
		type: "pointerout",
		filterMapEvent: (event) =>
			Option.map(
				Option.filter(
					closestTrigger(event.target),
					(trigger) => !isInside(trigger, event.relatedTarget),
				),
				() => toTooltip(Tooltip.Message.LeftTrigger()),
			),
	}),
	Dom.streamFromEventFilterMap({
		target: () => document,
		type: "pointerdown",
		filterMapEvent: (event) =>
			Option.map(closestTrigger(event.target), () => toTooltip(Tooltip.Message.PressedTrigger())),
	}),
	Dom.streamFromEventFilterMap({
		target: () => document,
		type: "focusin",
		filterMapEvent: (event) =>
			Option.map(openableTrigger(event.target), (trigger) => Message.FocusedTrigger(shownOf(trigger))),
	}),
	Dom.streamFromEventFilterMap({
		target: () => document,
		type: "focusout",
		filterMapEvent: (event) =>
			Option.map(
				Option.filter(
					closestTrigger(event.target),
					(trigger) => !isInside(trigger, event.relatedTarget),
				),
				() => toTooltip(Tooltip.Message.BlurredTrigger()),
			),
	}),
]

/** Pointer, press and focus on any trigger; children moving under the pointer do not count. */
export const triggerEvents: Stream.Stream<Message> = Stream.mergeAll(triggerStreams, {
	concurrency: "unbounded",
})

const escapes: Stream.Stream<Message> = Dom.streamFromEventFilterMap({
	target: () => document,
	type: "keydown",
	filterMapEvent: (event) =>
		event.key === "Escape" ? Option.some(toTooltip(Tooltip.Message.PressedEscape())) : Option.none(),
})

/** The triggers in a removed subtree that have an id to match. */
const removedTriggerIds = (node: Node): ReadonlyArray<string> =>
	node instanceof Element
		? [node, ...node.querySelectorAll(`[${CONTENT_ATTRIBUTE}]`)]
				.filter((element) => element.matches(`[${CONTENT_ATTRIBUTE}]`) && element.id !== "")
				.map((element) => element.id)
		: []

/** Trigger text changes and removals; the update keeps only the shown trigger's. */
const triggerMutations: Stream.Stream<Message> = Stream.callback<Message>((queue) =>
	Effect.acquireRelease(
		Effect.sync(() => {
			const observer = new MutationObserver((records) =>
				records.forEach((record) => {
					if (record.type === "childList") {
						record.removedNodes.forEach((node) =>
							removedTriggerIds(node).forEach((triggerId) =>
								Queue.offerUnsafe(queue, Message.RemovedTrigger({ triggerId })),
							),
						)
						return
					}
					const { target } = record
					if (!(target instanceof HTMLElement) || target.id === "") return
					Queue.offerUnsafe(
						queue,
						Message.ChangedTriggerText({
							triggerId: target.id,
							text: target.getAttribute(CONTENT_ATTRIBUTE) ?? "",
						}),
					)
				}),
			)
			observer.observe(document.body, {
				subtree: true,
				childList: true,
				attributeFilter: [CONTENT_ATTRIBUTE],
			})
			return observer
		}),
		(observer) => Effect.sync(() => observer.disconnect()),
	).pipe(Effect.flatMap(() => Effect.never)),
)

/** Escape, text changes and removal of the trigger; subscribe only while `isEngaged`. */
export const whileEngaged: Stream.Stream<Message> = Stream.merge(escapes, triggerMutations)

/** A tooltip is pending or open, so its trigger is worth watching. */
export const isEngaged = (model: Model): boolean => model.isEngaged || model.tooltip.isOpen

// VIEW

/**
 * The portal, inside a wrapper that keeps its place in the parent: place it before any sibling
 * whose children change, since the portal itself moves to `<body>`.
 */
export const view = <ParentMessage>(
	h: HtmlBuilder<ParentMessage>,
	model: Model,
	toParentMessage: (message: Message) => ParentMessage,
): Html =>
	h.div(
		[h.Class("contents"), h.DataAttribute("slot", "tooltip-host")],
		[
			h.submodel({
				slotId: `${model.tooltip.id}-host`,
				model: model.tooltip,
				view: Tooltip.view,
				toParentMessage: (message: Tooltip.Message) => toParentMessage(toTooltip(message)),
				viewInputs: {
					// Every trigger is delegated: the triggers' attributes are never asked for.
					triggerIds: [],
					layout:
						model.shown[model.tooltip.triggerId]?.isIconButton === true
							? "icon-button"
							: undefined,
					// A description's lines (a legend) stay lines.
					className: "whitespace-pre-line",
					toContent: (triggerId) => [model.shown[triggerId]?.text ?? ""],
					toView: ({ portal }) => portal ?? h.empty,
				},
			}),
		],
	)

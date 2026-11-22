import {
	Duration,
	Effect,
	Option,
	Queue,
	Schema,
	Stream,
	Array as Arr,
	Record as Rec,
	String as Str,
} from "effect"
import { Command, Dom, type Update } from "foldkit"
import { type Attribute, type Html, type HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { Side } from "./overlay/position"
import { personCard } from "./person-avatar"
import { timestampCard } from "./timestamp"
import { typography } from "./typography"
import { icon } from "./icon"
import { ICON_TREES, type IconName } from "./icons.generated"
import { cn } from "@maple/ui/lib/utils"
import { TONE_SOFT, type Tone } from "@maple/ui/lib/tone"
import * as Tooltip from "./tooltip"

/**
 * The app's one tooltip: any element carrying `tooltipTrigger` opens it, through events delegated
 * on `document`, so stateless kit helpers get Base UI's tooltip without a Model of their own.
 */

const CONTENT_ATTRIBUTE = "data-tooltip"
const LAYOUT_ATTRIBUTE = "data-tooltip-layout"
const TITLE_ATTRIBUTE = "data-tooltip-title"
const ICON_ATTRIBUTE = "data-tooltip-icon"
const TONE_ATTRIBUTE = "data-tooltip-tone"
const SIDE_ATTRIBUTE = "data-tooltip-side"
const OVERFLOW_ATTRIBUTE = "data-tooltip-overflow"
const INSTANT_ATTRIBUTE = "data-tooltip-instant"
const ZONE_ATTRIBUTE = "data-tooltip-zone"
const NOW_ATTRIBUTE = "data-tooltip-now"
const PERSON_ATTRIBUTE = "data-tooltip-person"
const PERSON_IMAGE_ATTRIBUTE = "data-tooltip-person-image"
const PERSON_DETAIL_ATTRIBUTE = "data-tooltip-person-detail"
const ID_PREFIX = "maple-tooltip-trigger-"

export type TriggerOptions = Readonly<{
	/** `Tooltip.view`'s `layout`. */
	layout?: "icon-button"
	/** `<TooltipPopup side>`; above the trigger by default. */
	side?: Side
	/** Opens only while the trigger's text is cut off (`TruncatedText tooltip="overflow"`). */
	isOverflowOnly?: boolean
	/** A bold first line; the content becomes its muted description, wrapped at a reading width. */
	title?: string
	/** With `title`: a tinted tile beside it, in `tone` (the shared status colours, neutral by default). */
	icon?: IconName
	tone?: Tone
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
	...(options.title === undefined ? [] : [h.DataAttribute("tooltip-title", options.title)]),
	...(options.icon === undefined ? [] : [h.DataAttribute("tooltip-icon", options.icon)]),
	...(options.tone === undefined ? [] : [h.DataAttribute("tooltip-tone", options.tone)]),
]

/** A `timestampTrigger`'s instant, zone and the page clock its text read (else the hover's). */
const Instant = Schema.Struct({ epochMs: Schema.Number, timeZone: Schema.String, nowMs: Schema.Number })

/** A `personTrigger`'s person, drawn as the person card. */
const Person = Schema.Struct({
	name: Schema.String,
	imageUrl: Schema.optionalKey(Schema.String),
	detail: Schema.optionalKey(Schema.String),
})
type Person = { -readonly [K in keyof typeof Person.Type]: (typeof Person.Type)[K] }

const Shown = Schema.Struct({
	text: Schema.String,
	title: Schema.optionalKey(Schema.String),
	icon: Schema.optionalKey(Schema.String),
	tone: Schema.optionalKey(Schema.String),
	isIconButton: Schema.Boolean,
	side: Side,
	instant: Schema.optionalKey(Instant),
	person: Schema.optionalKey(Person),
})
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

export const Message = defineMessageUnion({
	EnteredTrigger: { triggerId: Schema.String, shown: Shown },
	FocusedTrigger: { triggerId: Schema.String, shown: Shown },
	/** A shown trigger's text changed under it (Copy, then Copied). */
	ChangedTriggerText: { triggerId: Schema.String, text: Schema.String },
	/** A trigger left the page without a leave or blur: a re-render or a closing panel. */
	RemovedTrigger: { triggerId: Schema.String },
	/** Leave, press and blur name their trigger: another trigger's never closes this one. */
	LeftTrigger: { triggerId: Schema.String },
	PressedTrigger: { triggerId: Schema.String },
	BlurredTrigger: { triggerId: Schema.String },
	/** The press ended: a trigger that took no focus no longer holds its press. */
	ReleasedPointer: {},
	ElapsedWarmWindow: { generation: Schema.Number },
	GotTooltipMessage: { message: Tooltip.Message },
})
export type Message = typeof Message.Type

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
		shown: Rec.fromEntries(kept),
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

/** A dismissal for the trigger the tooltip belongs to, which also ends the engagement. */
const dismiss = (model: Model, triggerId: string, step: (model: Model) => UpdateReturn): UpdateReturn =>
	triggerId === model.tooltip.triggerId ? step({ ...model, isEngaged: false }) : { model }

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
		LeftTrigger: ({ triggerId }) => dismiss(model, triggerId, leave),
		PressedTrigger: ({ triggerId }) =>
			dismiss(model, triggerId, (next) =>
				lift(next, Tooltip.update(next.tooltip, Tooltip.Message.PressedTrigger())),
			),
		BlurredTrigger: ({ triggerId }) =>
			dismiss(model, triggerId, (next) =>
				lift(next, Tooltip.update(next.tooltip, Tooltip.Message.BlurredTrigger())),
			),
		ReleasedPointer: () =>
			model.tooltip.isPressingTrigger
				? { model: { ...model, tooltip: { ...model.tooltip, isPressingTrigger: false } } }
				: { model },
		GotTooltipMessage: ({ message: inner }) =>
			lift(
				inner._tag === "PressedEscape" ? { ...model, isEngaged: false } : model,
				Tooltip.update(model.tooltip, inner),
			),
	})

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
		// @effect-diagnostics-next-line globalRandom:off -- a DOM id suffix, not a seeded value
		trigger.id = `${ID_PREFIX}${Date.now().toString(36)}-${Str.slice(2)(Math.random().toString(36))}`
	return trigger.id
}

const isInside = (trigger: Element, node: EventTarget | null) =>
	node instanceof Node && trigger.contains(node)

const decodeSide = Schema.decodeUnknownOption(Side)

const instantOf = (trigger: HTMLElement): Option.Option<typeof Instant.Type> => {
	const epochMs = Number(trigger.getAttribute(INSTANT_ATTRIBUTE) ?? Number.NaN)
	const pageNowMs = Number(trigger.getAttribute(NOW_ATTRIBUTE) ?? Number.NaN)
	const nowMs = Number.isFinite(pageNowMs) ? pageNowMs : Date.now()
	return Number.isFinite(epochMs)
		? Option.some({ epochMs, timeZone: trigger.getAttribute(ZONE_ATTRIBUTE) ?? "", nowMs })
		: Option.none()
}

const personOf = (trigger: HTMLElement): Option.Option<Person> => {
	const name = trigger.getAttribute(PERSON_ATTRIBUTE)
	if (name === null || name === "") return Option.none()
	const person: Person = { name }
	const imageUrl = trigger.getAttribute(PERSON_IMAGE_ATTRIBUTE)
	if (imageUrl !== null) person.imageUrl = imageUrl
	const detail = trigger.getAttribute(PERSON_DETAIL_ATTRIBUTE)
	if (detail !== null) person.detail = detail
	return Option.some(person)
}

const shownOf = (trigger: HTMLElement) => ({
	triggerId: anchorIdOf(trigger),
	shown: {
		text: trigger.getAttribute(CONTENT_ATTRIBUTE) ?? "",
		...Option.match(Option.fromNullishOr(trigger.getAttribute(TITLE_ATTRIBUTE)), {
			onNone: () => ({}),
			onSome: (title) => ({ title }),
		}),
		...Option.match(Option.fromNullishOr(trigger.getAttribute(ICON_ATTRIBUTE)), {
			onNone: () => ({}),
			onSome: (icon) => ({ icon }),
		}),
		...Option.match(Option.fromNullishOr(trigger.getAttribute(TONE_ATTRIBUTE)), {
			onNone: () => ({}),
			onSome: (tone) => ({ tone }),
		}),
		isIconButton: trigger.getAttribute(LAYOUT_ATTRIBUTE) === "icon-button",
		side: Option.getOrElse(decodeSide(trigger.getAttribute(SIDE_ATTRIBUTE)), (): Side => "top"),
		...Option.match(instantOf(trigger), { onNone: () => ({}), onSome: (instant) => ({ instant }) }),
		...Option.match(personOf(trigger), { onNone: () => ({}), onSome: (person) => ({ person }) }),
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
				(trigger) => Message.LeftTrigger({ triggerId: trigger.id }),
			),
	}),
	Dom.streamFromEventFilterMap({
		target: () => document,
		type: "pointerdown",
		filterMapEvent: (event) =>
			Option.map(closestTrigger(event.target), (trigger) =>
				Message.PressedTrigger({ triggerId: trigger.id }),
			),
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
				(trigger) => Message.BlurredTrigger({ triggerId: trigger.id }),
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

/** The triggers in a removed subtree that have an id to match; a moved node is still connected. */
const removedTriggerIds = (node: Node): ReadonlyArray<string> =>
	node instanceof Element && !node.isConnected
		? Arr.map(
				Arr.filter(
					[node, ...node.querySelectorAll(`[${CONTENT_ATTRIBUTE}]`)],
					(element) => element.matches(`[${CONTENT_ATTRIBUTE}]`) && element.id !== "",
				),
				(element) => element.id,
			)
		: []

/** Trigger text changes and removals; the update keeps only the shown trigger's. */
const triggerMutations: Stream.Stream<Message> = Stream.callback<Message>((queue) =>
	Effect.acquireRelease(
		Effect.sync(() => {
			const observer = new MutationObserver((records) =>
				Arr.forEach(records, (record) => {
					if (record.type === "childList") {
						record.removedNodes.forEach((node) =>
							Arr.forEach(removedTriggerIds(node), (triggerId) =>
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

/** Escape, text changes, removal of the trigger and the end of a press; only while `isEngaged`. */
const releases: Stream.Stream<Message> = Dom.streamFromEvent({
	target: () => document,
	type: "pointerup",
	mapEvent: () => Message.ReleasedPointer(),
})

export const whileEngaged: Stream.Stream<Message> = Stream.mergeAll([escapes, triggerMutations, releases], {
	concurrency: "unbounded",
})

/** A tooltip is pending or open, so its trigger is worth watching. */
export const isEngaged = (model: Model): boolean =>
	model.isEngaged || model.tooltip.isOpen || model.tooltip.isPressingTrigger

// The attributes carry plain strings; only a known icon or tone is drawn.
const ICON_NAMES: ReadonlySet<string> = new Set(Rec.keys(ICON_TREES))
const TONES: ReadonlySet<string> = new Set(Rec.keys(TONE_SOFT))
const isIconName = (name: string): name is IconName => ICON_NAMES.has(name)
const isTone = (tone: string): tone is Tone => TONES.has(tone)

/** A titled tooltip: an optional tinted icon tile, the title, its description muted below. */
const titledCard = <M>(h: HtmlBuilder<M>, shown: Shown & { title: string }): Html => {
	const tone: Tone = shown.tone !== undefined && isTone(shown.tone) ? shown.tone : "neutral"
	const tile =
		shown.icon !== undefined && isIconName(shown.icon)
			? [
					h.span(
						[
							h.Class(
								cn(
									"flex size-6 shrink-0 items-center justify-center rounded-md",
									TONE_SOFT[tone],
								),
							),
							h.AriaHidden(true),
						],
						[icon(h, shown.icon, { size: 14 })],
					),
				]
			: []
	return h.div(
		[
			h.Class("flex max-w-72 items-start gap-2.5 px-0.5 py-1.5 text-left text-pretty"),
			h.DataAttribute("slot", "tooltip-card"),
		],
		[
			...tile,
			h.div(
				[h.Class("flex min-w-0 flex-col gap-0.5")],
				[
					typography(h, { size: "xs", weight: "medium", as: "div" }, [shown.title]),
					...(shown.text === ""
						? []
						: [typography(h, { size: "xs", tone: "muted", as: "div" }, [shown.text])]),
				],
			),
		],
	)
}

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
					toContent: (triggerId) => {
						const shown = model.shown[triggerId]
						if (shown?.instant !== undefined) return [timestampCard(h, shown.instant)]
						if (shown?.person !== undefined) return [personCard(h, shown.person)]
						if (shown?.title !== undefined)
							return [titledCard(h, { ...shown, title: shown.title })]
						return [shown?.text ?? ""]
					},
					toView: ({ portal }) => portal ?? h.empty,
				},
			}),
		],
	)

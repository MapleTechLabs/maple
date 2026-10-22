import * as Animation from "@foldkit/ui/animation"
import { cn } from "@maple/ui/lib/utils"
import {
	popoverDescriptionStyles,
	popoverPopupStyles,
	popoverPositionerStyles,
	popoverTitleStyles,
	popoverViewportScrollStyles,
	popoverViewportStyles,
} from "@maple/ui/styles/ui/popover"
import { Duration, Effect, Option, Schema, Stream } from "effect"
import { Command, Mount, Submodel, type Update } from "foldkit"
import { type ChildAttribute, childAttributes, type Html, type HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { anchoredPopup } from "./overlay/anchored"
import { fitPositionerToPopup } from "./overlay/auto-resize"
import { initPopup, makeTransition, PopupState, popupId, portalId, triggerId } from "./overlay/popup-state"
import { Align, positionDefaults, Side } from "./overlay/position"
import { focusGuard, isMounted, SR_ONLY_STYLE, stateAttributes } from "./overlay/transition"

/**
 * Base UI `Popover` (`@maple/ui/popover`, non-modal): the trigger toggles it, Escape and a press
 * outside close it, and it is placed under the trigger with `sideOffset` 4 and collision padding 5.
 */

// MODEL

export const Model = Schema.Struct({
	...PopupState.fields,
	/** `openOnHover`: the delay before a hover opens it, 0 for click only. */
	hoverDelayMs: Schema.Number,
	hoverGeneration: Schema.Number,
	/** A press on the trigger opened it (Base UI's `trigger-press` open reason): `data-pressed`. */
	isPressOpened: Schema.Boolean,
	/** The Positioner's `sideOffset` (4 for `PopoverContent`). */
	sideOffset: Schema.Number,
	/** A bare `PopoverPrimitive.Positioner` + `Popup` (no `PopoverContent`): translate placement. */
	isBare: Schema.Boolean,
	/** Base UI `initialFocus`: the popup itself (default) or its first tabbable element. */
	initialFocus: Schema.Literals(["popup", "first-tabbable"]),
	/** `PopoverContent`'s side and align; `side`/`align` are where it last landed (after a flip). */
	requestedSide: Side,
	requestedAlign: Align,
})
export type Model = typeof Model.Type

export const titleId = (id: string): string => `${id}-title`
export const descriptionId = (id: string): string => `${id}-description`

/** `align` and `side` are `PopoverContent`'s; `hoverDelayMs` is the trigger's `openOnHover` delay. */
export const init = (
	id: string,
	options: Readonly<{
		isOpen?: boolean
		align?: Align
		side?: Side
		hoverDelayMs?: number
		sideOffset?: number
		isBare?: boolean
		initialFocus?: "popup" | "first-tabbable"
	}> = {},
): Model => ({
	...initPopup(id, {
		isOpen: options.isOpen,
		side: options.side ?? "bottom",
		align: options.align ?? "center",
	}),
	hoverDelayMs: options.hoverDelayMs ?? 0,
	hoverGeneration: 0,
	isPressOpened: false,
	sideOffset: options.sideOffset ?? 4,
	isBare: options.isBare ?? false,
	initialFocus: options.initialFocus ?? "popup",
	requestedSide: options.side ?? "bottom",
	requestedAlign: options.align ?? "center",
})

// MESSAGE

export const Message = defineMessageUnion({
	ClickedTrigger: {},
	ClickedClose: {},
	PressedEscape: {},
	PressedOutside: {},
	CompletedMountPopover: {},
	ChangedPlacement: { side: Side, align: Align },
	GotAnimationMessage: { message: Animation.Message },
	EnteredTrigger: {},
	LeftHoverArea: {},
	EnteredPopup: {},
	ElapsedHoverDelay: { generation: Schema.Number, isOpening: Schema.Boolean },
})
export type Message = typeof Message.Type

/** The hover open delay, or the grace period for crossing from the trigger into the popup. */
export const WaitHoverDelay = Command.define("WaitPopoverHoverDelay", {
	args: { generation: Schema.Number, millis: Schema.Number, isOpening: Schema.Boolean },
	messages: [Message.ElapsedHoverDelay],
	execute: ({ generation, millis, isOpening }) =>
		Effect.sleep(Duration.millis(millis)).pipe(
			Effect.as(Message.ElapsedHoverDelay({ generation, isOpening })),
		),
})

const HOVER_CLOSE_GRACE_MS = 100

const waitHover = (model: Model, millis: number, isOpening: boolean): Update.Return<Model, Message> => {
	const generation = model.hoverGeneration + 1
	return {
		model: { ...model, hoverGeneration: generation },
		commands: [WaitHoverDelay({ generation, millis, isOpening })],
	}
}

// UPDATE

const transition = makeTransition<Model, Message>(
	(message) => Message.GotAnimationMessage({ message }),
	"WaitForPopoverExit",
)
/** Each opening is placed afresh from the requested side, as Base UI's positioner does. */
export const open = (model: Model): Update.Return<Model, Message> =>
	transition.open(
		model.isOpen ? model : { ...model, side: model.requestedSide, align: model.requestedAlign },
	)
export const WaitForPopoverExit = transition.WaitForExit
export const close = transition.close

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
	Message.match<Update.Return<Model, Message>>(message, {
		ClickedTrigger: () => (model.isOpen ? close(model) : open({ ...model, isPressOpened: true })),
		ClickedClose: () => close(model),
		PressedEscape: () => close(model),
		PressedOutside: () => close(model),
		CompletedMountPopover: () => ({ model }),
		ChangedPlacement: ({ side, align }) => ({ model: { ...model, side, align } }),
		GotAnimationMessage: ({ message: animationMessage }) =>
			transition.foldAnimation(model, animationMessage),
		EnteredTrigger: () =>
			model.hoverDelayMs === 0 || model.isOpen
				? { model: { ...model, hoverGeneration: model.hoverGeneration + 1 } }
				: waitHover(model, model.hoverDelayMs, true),
		EnteredPopup: () => ({ model: { ...model, hoverGeneration: model.hoverGeneration + 1 } }),
		LeftHoverArea: () =>
			model.hoverDelayMs === 0 ? { model } : waitHover(model, HOVER_CLOSE_GRACE_MS, false),
		ElapsedHoverDelay: ({ generation, isOpening }) =>
			generation !== model.hoverGeneration
				? { model }
				: isOpening
					? open({ ...model, isPressOpened: false })
					: model.isOpen
						? close(model)
						: { model },
	})

// MOUNT

/** Portal, marker on the page outside, placement under the trigger and outside presses. */
export const MountPopover = Mount.defineStream("MountPopover", {
	args: {
		id: Schema.String,
		align: Align,
		side: Side,
		sideOffset: Schema.Number,
		isBare: Schema.Boolean,
		initialFocus: Schema.Literals(["popup", "first-tabbable"]),
		fallbackAnchorSelector: Schema.NullOr(Schema.String),
	},
	messages: [Message.CompletedMountPopover, Message.ChangedPlacement, Message.PressedOutside],
	execute: ({ element, id, align, side, sideOffset, isBare, initialFocus, fallbackAnchorSelector }) =>
		anchoredPopup(element, {
			positionerSelector: "[data-slot=popover-positioner]",
			popupSelector: `#${CSS.escape(popupId(id))}`,
			config: {
				...positionDefaults,
				anchor: {
					_tag: "Element",
					id: triggerId(id),
					fallbackSelector: fallbackAnchorSelector ?? undefined,
				},
				side,
				align,
				sideOffset,
				adaptiveOrigin: !isBare,
			},
			// A child popup portalled out of this one (`nestedIn`) counts as inside, as a FloatingTree child does.
			insideSelectors: [`#${CSS.escape(triggerId(id))}`, `[data-nested-in="${CSS.escape(id)}"]`],
			markOutside: Option.some({ mark: true, ariaHidden: false }),
			lockScroll: false,
			focus: Option.some({ returnFocusId: Option.some(triggerId(id)), initialFocus }),
			afterPlace: (positioner, popup, placedSide) => {
				if (isBare) return
				// Top and left popups anchor to the trigger-facing edge, measured as Base UI does.
				if (placedSide === "top" || placedSide === "left")
					return fitPositionerToPopup(positioner, popup, placedSide)
				positioner.style.setProperty("--positioner-width", `${popup.offsetWidth}px`)
				positioner.style.setProperty("--positioner-height", `${popup.offsetHeight}px`)
			},
		}).pipe(
			Stream.map((event) => {
				switch (event._tag) {
					case "Mounted":
						return Message.CompletedMountPopover()
					case "Placed":
						return Message.ChangedPlacement({
							side: event.placed.side,
							align: event.placed.align,
						})
					case "PressedOutside":
						return Message.PressedOutside()
				}
			}),
		),
})

// VIEW

/**
 * `trigger` goes on the parent's button; `withTrigger(button)` returns it with Base UI's focus
 * guards and `aria-owns` owner around it, and the portal last, as the parent's children.
 */
export type RenderInfo = Readonly<{
	trigger: ReadonlyArray<ChildAttribute>
	withTrigger: (button: Html) => ReadonlyArray<Html>
}>

export type ViewInputs = Readonly<{
	toView: (render: RenderInfo) => Html
	toContent: (close: ReadonlyArray<ChildAttribute>) => ReadonlyArray<Html>
	className?: string
	/** With `isBare`: the Positioner's and the Popup's own classes. */
	bare?: Readonly<{ positionerClassName: string; popupClassName: string }>
	/** `QuickPickMenu`'s `fallbackAnchor`: placed against it while the trigger is hidden. */
	fallbackAnchorSelector?: string | undefined
}>

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) => {
	const isVisible = isMounted(model.isOpen, model.animation)
	const state = stateAttributes(h, model.isOpen, model.animation)
	const placement = [h.DataAttribute("align", model.align)]
	const side = [h.DataAttribute("side", model.side)]
	const trigger = childAttributes([
		...(isVisible ? [h.AriaControls(popupId(model.id))] : []),
		h.AriaExpanded(model.isOpen),
		h.AriaHasPopup("dialog"),
		h.DataAttribute("base-ui-click-trigger", ""),
		...(model.isOpen ? [h.DataAttribute("popup-open", "")] : []),
		// Base UI marks a trigger pressed when a press opened it (`pressableTriggerOpenStateMapping`).
		...(model.isOpen && model.isPressOpened ? [h.DataAttribute("pressed", "")] : []),
		h.DataAttribute("slot", "popover-trigger"),
		h.Id(triggerId(model.id)),
		h.Tabindex(0),
		h.OnClick(Message.ClickedTrigger()),
		...(model.hoverDelayMs > 0
			? [h.OnMouseEnter(Message.EnteredTrigger()), h.OnMouseLeave(Message.LeftHoverArea())]
			: []),
	])
	const portal = h.div(
		[
			h.Key(portalId(model.id)),
			h.DataAttribute("base-ui-portal", ""),
			h.Id(portalId(model.id)),
			h.OnMount(
				MountPopover({
					id: model.id,
					align: model.requestedAlign,
					side: model.requestedSide,
					sideOffset: model.sideOffset,
					isBare: model.isBare,
					initialFocus: model.initialFocus,
					fallbackAnchorSelector: inputs.fallbackAnchorSelector ?? null,
				}),
			),
			h.OnKeyDownPreventDefault((key) =>
				key === "Escape" ? Option.some(Message.PressedEscape()) : Option.none(),
			),
		],
		[
			h.div(
				[
					h.Class(
						cn(
							inputs.bare?.positionerClassName ?? popoverPositionerStyles,
							!model.isOpen && "pointer-events-none",
						),
					),
					...placement,
					...state,
					...side,
					h.DataAttribute("slot", "popover-positioner"),
					h.Role("presentation"),
				],
				[
					focusGuard(h, "inside"),
					h.div(
						[
							...(inputs.bare === undefined
								? [
										h.AriaDescribedBy(descriptionId(model.id)),
										h.AriaLabelledBy(titleId(model.id)),
									]
								: []),
							h.Class(inputs.bare?.popupClassName ?? cn(popoverPopupStyles, inputs.className)),
							...placement,
							h.DataAttribute("base-ui-focusable", ""),
							...state,
							...side,
							h.DataAttribute("slot", "popover-popup"),
							h.Id(popupId(model.id)),
							h.Role("dialog"),
							...(model.hoverDelayMs > 0
								? [
										h.OnMouseEnter(Message.EnteredPopup()),
										h.OnMouseLeave(Message.LeftHoverArea()),
									]
								: []),
							...(inputs.bare === undefined
								? [h.Style({ "--popup-width": "auto", "--popup-height": "auto" })]
								: []),
							h.Tabindex(-1),
						],
						inputs.bare !== undefined
							? inputs.toContent(childAttributes([h.OnClick(Message.ClickedClose())]))
							: [
									h.div(
										[
											h.Class(cn(popoverViewportStyles, popoverViewportScrollStyles)),
											h.DataAttribute("slot", "popover-viewport"),
										],
										[
											h.div(
												[h.DataAttribute("current", "true")],
												inputs.toContent(
													childAttributes([h.OnClick(Message.ClickedClose())]),
												),
											),
										],
									),
								],
					),
					focusGuard(h, "inside"),
				],
			),
		],
	)
	const withTrigger = (button: Html): ReadonlyArray<Html> =>
		isVisible
			? [
					focusGuard(h, undefined, [h.Key("guard-before")]),
					button,
					focusGuard(h, undefined, [h.Key("guard-after")]),
					focusGuard(h, "outside", [h.Key("guard-outside-before")]),
					h.span([
						h.Key("owner"),
						h.AriaOwns(portalId(model.id)),
						h.Style({
							clipPath: SR_ONLY_STYLE.clipPath,
							position: "fixed",
							top: "0px",
							left: "0px",
						}),
					]),
					focusGuard(h, "outside", [h.Key("guard-outside-after")]),
					portal,
				]
			: [button]
	return inputs.toView({ trigger, withTrigger })
})

export const popoverTitle = <M>(h: HtmlBuilder<M>, id: string, text: string, className?: string): Html =>
	h.h2(
		[
			h.Class(cn(popoverTitleStyles, className)),
			h.DataAttribute("slot", "popover-title"),
			h.Id(titleId(id)),
		],
		[text],
	)

export const popoverDescription = <M>(
	h: HtmlBuilder<M>,
	id: string,
	text: string,
	className?: string,
): Html =>
	h.p(
		[
			h.Class(cn(popoverDescriptionStyles, className)),
			h.DataAttribute("slot", "popover-description"),
			h.Id(descriptionId(id)),
		],
		[text],
	)

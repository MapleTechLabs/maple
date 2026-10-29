import { cn } from "@maple/ui/lib/utils"
import {
	popoverDescriptionStyles,
	popoverPopupStyles,
	popoverPositionerStyles,
	popoverTitleStyles,
	popoverViewportScrollStyles,
	popoverViewportStyles,
} from "@maple/ui/styles/ui/popover"
import { Duration, Effect, Layer, Option, Schema, Stream } from "effect"
import { Block, Update } from "foldkit"
import { type ChildAttribute, childAttributes, type Html, type HtmlBuilder } from "foldkit/html"
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

export type InitOptions = Readonly<{
	isOpen?: boolean
	align?: Align
	side?: Side
	hoverDelayMs?: number
	sideOffset?: number
	isBare?: boolean
	initialFocus?: "popup" | "first-tabbable"
}>

/**
 * The Model alone (also `PopoverBlock.init(id, options)`). `align` and `side` are
 * `PopoverContent`'s; `hoverDelayMs` is the trigger's `openOnHover` delay.
 */
export const init = (id: string, options: InitOptions = {}): Model => ({
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
	EnteredTrigger: {},
	LeftHoverArea: {},
	EnteredPopup: {},
	ElapsedHoverDelay: { generation: Schema.Number, isOpening: Schema.Boolean },
	/** Parent-initiated: opens it; `isPressOpened` marks the trigger `data-pressed`. */
	RequestedOpen: { isPressOpened: Schema.Boolean },
	/** Parent-initiated: closes it. */
	RequestedClose: {},
})
export type Message = typeof Message.Type

const PopoverDefinition = Block.makeDefinition("Popover", { Model, Message })

/** `animation` starts in `init` (via `initPopup`), so the Binding does not initialise it. */
const AnimationBinding = PopoverDefinition.makeBinding(PopupTransitionBlock, {
	field: "animation",
	init: false,
})

/** The hover open delay, or the grace period for crossing from the trigger into the popup. */
export const WaitHoverDelay = PopoverDefinition.makeCommand("WaitPopoverHoverDelay", {
	args: { generation: Schema.Number, millis: Schema.Number, isOpening: Schema.Boolean },
	messages: [Message.ElapsedHoverDelay],
	handler: function* () {
		return ({ generation, millis, isOpening }) =>
			Effect.sleep(Duration.millis(millis)).pipe(
				Effect.as(Message.ElapsedHoverDelay({ generation, isOpening })),
			)
	},
})

const HOVER_CLOSE_GRACE_MS = 100

const waitHoverStep = PopoverDefinition.makeStep((model, millis: number, isOpening: boolean) => {
	const generation = model.hoverGeneration + 1
	return {
		model: { ...model, hoverGeneration: generation },
		commands: [WaitHoverDelay({ generation, millis, isOpening })],
	}
})

const bumpHoverGenerationStep = PopoverDefinition.makeFieldsStep(() => ({
	hoverGeneration: (generation: number) => generation + 1,
}))

// UPDATE

/** Each opening is placed afresh from the requested side, as Base UI's positioner does. */
const openStep = PopoverDefinition.makeStep((model) =>
	model.isOpen
		? PopoverDefinition.makeNoopStep()
		: Update.combineSteps([
				PopoverDefinition.makeFieldsStep((current) => ({
					isOpen: () => true,
					side: () => current.requestedSide,
					align: () => current.requestedAlign,
				})),
				AnimationBinding.requestShow(),
			]),
)

const closeStep = PopoverDefinition.makeStep((model) =>
	model.isOpen
		? Update.combineSteps([
				PopoverDefinition.makeFieldsStep(() => ({ isOpen: () => false })),
				AnimationBinding.requestHide(),
			])
		: PopoverDefinition.makeNoopStep(),
)

/** Sets `isPressOpened` first, as the old `open({ ...model, isPressOpened })` did. */
const openWithPressStep = PopoverDefinition.makeStep((_model, isPressOpened: boolean) =>
	Update.combineSteps([
		PopoverDefinition.makeFieldsStep(() => ({ isPressOpened: () => isPressOpened })),
		openStep,
	]),
)

// MOUNT

/** Portal, marker on the page outside, placement under the trigger and outside presses. */
export const MountPopover = PopoverDefinition.makeMountStream("MountPopover", {
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
	handler: function* () {
		return ({ element, id, align, side, sideOffset, isBare, initialFocus, fallbackAnchorSelector }) =>
			mountPopoverStream(element, {
				id,
				align,
				side,
				sideOffset,
				isBare,
				initialFocus,
				fallbackAnchorSelector,
			})
	},
})

type MountPopoverArgs = Readonly<{
	id: string
	align: Align
	side: Side
	sideOffset: number
	isBare: boolean
	initialFocus: "popup" | "first-tabbable"
	fallbackAnchorSelector: string | null
}>

const mountPopoverStream = (
	element: Element,
	{ id, align, side, sideOffset, isBare, initialFocus, fallbackAnchorSelector }: MountPopoverArgs,
) =>
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
	)

const PopoverComposition = PopoverDefinition.makeComposition({
	bindings: [AnimationBinding],
	mounts: [MountPopover],
})

const blockInit = PopoverComposition.makeInit((id: string, options: InitOptions = {}) => ({
	model: init(id, options),
}))

const update = PopoverComposition.makeUpdate({
	ClickedTrigger: (model) => (model.isOpen ? closeStep(model) : openWithPressStep(model, true)),
	ClickedClose: closeStep,
	PressedEscape: closeStep,
	PressedOutside: closeStep,
	CompletedMountPopover: PopoverDefinition.makeNoopStep(),
	ChangedPlacement: (model, { side, align }) => ({ model: { ...model, side, align } }),
	EnteredTrigger: (model) =>
		model.hoverDelayMs === 0 || model.isOpen
			? bumpHoverGenerationStep(model)
			: waitHoverStep(model, model.hoverDelayMs, true),
	EnteredPopup: bumpHoverGenerationStep,
	LeftHoverArea: (model) =>
		model.hoverDelayMs === 0
			? PopoverDefinition.makeNoopStep()(model)
			: waitHoverStep(model, HOVER_CLOSE_GRACE_MS, false),
	ElapsedHoverDelay: (model, { generation, isOpening }) =>
		generation !== model.hoverGeneration
			? PopoverDefinition.makeNoopStep()(model)
			: isOpening
				? openWithPressStep(model, false)
				: closeStep(model),
	RequestedOpen: (model, { isPressOpened }) => openWithPressStep(model, isPressOpened),
	RequestedClose: closeStep,
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

const view = PopoverComposition.makeView.withInputs<ViewInputs>((model, inputs, h) => {
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
	// Built here, in this Block's boundary: `withTrigger` itself runs in the parent's.
	const guardBefore = focusGuard(h, undefined, [h.Key("guard-before")])
	const afterTrigger = [
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
	const withTrigger = (button: Html): ReadonlyArray<Html> =>
		isVisible ? [guardBefore, button, ...afterTrigger] : [button]
	return inputs.toView({ trigger, withTrigger })
})

const prepare = () =>
	PopoverComposition.prepareBlock({
		init: blockInit,
		update,
		view,
		operations: {
			requestOpen: Message.RequestedOpen,
			requestClose: Message.RequestedClose,
		},
		EffectsLayer: Layer.mergeAll(WaitHoverDelay.layer, MountPopover.layer),
	})
export const PopoverBlock: Block.FromAssemblyWithView<typeof Model, typeof prepare> = Block.assemble(prepare)

export const popoverTitle = <M>(h: HtmlBuilder<M>, id: string, text: string, className?: string): Html =>
	h.h2(
		[
			h.Class(cn(popoverTitleStyles, "font-display tracking-tight", className)),
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
			h.Class(cn(popoverDescriptionStyles, "font-prose", className)),
			h.DataAttribute("slot", "popover-description"),
			h.Id(descriptionId(id)),
		],
		[text],
	)

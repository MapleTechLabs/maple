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
import { Option, Schema, Stream } from "effect"
import { Mount, Submodel, type Update } from "foldkit"
import { type ChildAttribute, childAttributes, type Html, type HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { anchoredPopup } from "./overlay/anchored"
import { initPopup, makeTransition, PopupState, popupId, portalId, triggerId } from "./overlay/popup-state"
import { Align, positionDefaults, Side } from "./overlay/position"
import { focusGuard, isMounted, SR_ONLY_STYLE, stateAttributes } from "./overlay/transition"

/**
 * Base UI `Popover` (`@maple/ui/popover`, non-modal): the trigger toggles it, Escape and a press
 * outside close it, and it is placed under the trigger with `sideOffset` 4 and collision padding 5.
 */

// MODEL

export const Model = PopupState
export type Model = PopupState

export const titleId = (id: string): string => `${id}-title`
export const descriptionId = (id: string): string => `${id}-description`

export const init = (id: string, options: Readonly<{ isOpen?: boolean }> = {}): Model =>
	initPopup(id, { ...options, side: "bottom", align: "center" })

// MESSAGE

export const Message = defineMessageUnion({
	ClickedTrigger: {},
	ClickedClose: {},
	PressedEscape: {},
	PressedOutside: {},
	CompletedMountPopover: {},
	ChangedPlacement: { side: Side, align: Align },
	GotAnimationMessage: { message: Animation.Message },
})
export type Message = typeof Message.Type

// UPDATE

const transition = makeTransition<Model, Message>(
	(message) => Message.GotAnimationMessage({ message }),
	"WaitForPopoverExit",
)
export const open = transition.open
export const close = transition.close

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
	Message.match<Update.Return<Model, Message>>(message, {
		ClickedTrigger: () => (model.isOpen ? close(model) : open(model)),
		ClickedClose: () => close(model),
		PressedEscape: () => close(model),
		PressedOutside: () => close(model),
		CompletedMountPopover: () => ({ model }),
		ChangedPlacement: ({ side, align }) => ({ model: { ...model, side, align } }),
		GotAnimationMessage: ({ message: animationMessage }) =>
			transition.foldAnimation(model, animationMessage),
	})

// MOUNT

/** Portal, marker on the page outside, placement under the trigger and outside presses. */
export const MountPopover = Mount.defineStream("MountPopover", {
	args: { id: Schema.String },
	messages: [Message.CompletedMountPopover, Message.ChangedPlacement, Message.PressedOutside],
	execute: ({ element, id }) =>
		anchoredPopup(element, {
			positionerSelector: "[data-slot=popover-positioner]",
			popupSelector: `#${CSS.escape(popupId(id))}`,
			config: {
				...positionDefaults,
				anchor: { _tag: "Element", id: triggerId(id) },
				side: "bottom",
				align: "center",
				sideOffset: 4,
				adaptiveOrigin: true,
			},
			insideIds: [triggerId(id)],
			markOutside: Option.some({ ariaHidden: false }),
			lockScroll: false,
			focus: Option.some({ returnFocusId: Option.some(triggerId(id)), initialFocus: "popup" }),
			afterPlace: (positioner, popup) => {
				positioner.style.setProperty("--positioner-width", `${popup.offsetWidth}px`)
				positioner.style.setProperty("--positioner-height", `${popup.offsetHeight}px`)
			},
		}).pipe(
			Stream.map((event) => {
				switch (event._tag) {
					case "Mounted":
						return Message.CompletedMountPopover()
					case "Placed":
						return Message.ChangedPlacement(event.placed)
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
		h.DataAttribute("slot", "popover-trigger"),
		h.Id(triggerId(model.id)),
		h.Tabindex(0),
		h.OnClick(Message.ClickedTrigger()),
	])
	const portal = h.div(
		[
			h.Key(portalId(model.id)),
			h.DataAttribute("base-ui-portal", ""),
			h.Id(portalId(model.id)),
			h.OnMount(MountPopover({ id: model.id })),
			h.OnKeyDownPreventDefault((key) =>
				key === "Escape" ? Option.some(Message.PressedEscape()) : Option.none(),
			),
		],
		[
			h.div(
				[
					h.Class(popoverPositionerStyles),
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
							h.AriaDescribedBy(descriptionId(model.id)),
							h.AriaLabelledBy(titleId(model.id)),
							h.Class(cn(popoverPopupStyles, inputs.className)),
							...placement,
							h.DataAttribute("base-ui-focusable", ""),
							...state,
							...side,
							h.DataAttribute("slot", "popover-popup"),
							h.Id(popupId(model.id)),
							h.Role("dialog"),
							h.Style({ "--popup-width": "auto", "--popup-height": "auto" }),
							h.Tabindex(-1),
						],
						[
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

export const popoverTitle = <M>(h: HtmlBuilder<M>, id: string, text: string): Html =>
	h.h2([h.Class(popoverTitleStyles), h.DataAttribute("slot", "popover-title"), h.Id(titleId(id))], [text])

export const popoverDescription = <M>(h: HtmlBuilder<M>, id: string, text: string): Html =>
	h.p(
		[
			h.Class(popoverDescriptionStyles),
			h.DataAttribute("slot", "popover-description"),
			h.Id(descriptionId(id)),
		],
		[text],
	)

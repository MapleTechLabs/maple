import * as Animation from "@foldkit/ui/animation"
import { cn } from "@maple/ui/lib/utils"
import {
	navigationMenuContentStyles,
	navigationMenuItemStyles,
	navigationMenuLinkStyles,
	navigationMenuListStyles,
	navigationMenuPopupStyles,
	navigationMenuPositionerStyles,
	navigationMenuStyles,
	navigationMenuTriggerGroupStyles,
	navigationMenuTriggerIconStyles,
	navigationMenuTriggerStyle,
	navigationMenuViewportStyles,
} from "@maple/ui/styles/ui/navigation-menu"
import { Duration, Effect, Number, Option, Schema, Stream } from "effect"
import { Command, Mount, Submodel, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { icon } from "./icon"
import { anchoredPopup } from "./overlay/anchored"
import { initPopup, makeTransition, PopupState, popupId, portalId } from "./overlay/popup-state"
import { Align, positionDefaults, Side } from "./overlay/position"
import { focusGuard, isMounted, SR_ONLY_STYLE, stateAttributes } from "./overlay/transition"

/**
 * Base UI `NavigationMenu` (`@maple/ui/navigation-menu`): a trigger opens its content in one shared
 * popup below the list (offset 8, start-aligned) on click, or after the pointer rests on it
 * (50 ms); leaving trigger and popup closes it after 50 ms, as do Escape and a press outside.
 */

// MODEL

export const Model = Schema.Struct({
	...PopupState.fields,
	/** The open item's value; kept while the popup plays its exit. */
	value: Schema.NullOr(Schema.String),
	hoverGeneration: Schema.Number,
})
export type Model = typeof Model.Type

export const HOVER_DELAY = Duration.millis(50)

export const triggerIdOf = (id: string, value: string): string => `${id}-trigger-${value}`
export const viewportId = (id: string): string => `${id}-viewport`
export const rootId = (id: string): string => `${id}-root`

/** `defaultValue`: the item open on mount. */
export const init = (id: string, options: Readonly<{ value?: string }> = {}): Model => ({
	...initPopup(id, { isOpen: options.value !== undefined, side: "bottom", align: "start" }),
	value: options.value ?? null,
	hoverGeneration: 0,
})

// MESSAGE

export const Message = defineMessageUnion({
	ClickedTrigger: { value: Schema.String },
	EnteredTrigger: { value: Schema.String },
	LeftTrigger: {},
	EnteredPopup: {},
	LeftPopup: {},
	ElapsedHoverDelay: { generation: Schema.Number, value: Schema.NullOr(Schema.String) },
	PressedEscape: {},
	PressedOutside: {},
	CompletedMountNavigationMenu: {},
	ChangedPlacement: { side: Side, align: Align },
	GotAnimationMessage: { message: Animation.Message },
})
export type Message = typeof Message.Type

// UPDATE

/** The hover delay towards `value` (null closes); a newer pointer move drops it. */
export const WaitHoverDelay = Command.define("WaitHoverDelay", {
	args: { generation: Schema.Number, value: Schema.NullOr(Schema.String) },
	messages: [Message.ElapsedHoverDelay],
	execute: (args) => Effect.sleep(HOVER_DELAY).pipe(Effect.as(Message.ElapsedHoverDelay(args))),
})

const transition = makeTransition<Model, Message>(
	(message) => Message.GotAnimationMessage({ message }),
	"WaitForNavigationMenuExit",
)
type UpdateReturn = Update.Return<Model, Message>

const bumped = (model: Model): Model => ({
	...model,
	hoverGeneration: Number.increment(model.hoverGeneration),
})

const schedule = (model: Model, value: string | null): UpdateReturn => {
	const generation = Number.increment(model.hoverGeneration)
	return {
		model: { ...model, hoverGeneration: generation },
		commands: [WaitHoverDelay({ generation, value })],
	}
}

/** Opens `value`, or switches the open popup's content to it. */
const show = (model: Model, value: string): UpdateReturn =>
	model.isOpen ? { model: { ...bumped(model), value } } : transition.open({ ...bumped(model), value })

const close = (model: Model): UpdateReturn => transition.close(bumped(model))

export const update = (model: Model, message: Message): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		ClickedTrigger: ({ value }) =>
			model.isOpen && model.value === value ? close(model) : show(model, value),
		EnteredTrigger: ({ value }) =>
			model.isOpen && model.value === value ? { model: bumped(model) } : schedule(model, value),
		LeftTrigger: () => (model.isOpen ? schedule(model, null) : { model: bumped(model) }),
		EnteredPopup: () => ({ model: bumped(model) }),
		LeftPopup: () => schedule(model, null),
		ElapsedHoverDelay: ({ generation, value }) =>
			generation !== model.hoverGeneration
				? { model }
				: value === null
					? close(model)
					: show(model, value),
		PressedEscape: () => close(model),
		PressedOutside: () => close(model),
		CompletedMountNavigationMenu: () => ({ model }),
		ChangedPlacement: ({ side, align }) => ({ model: { ...model, side, align } }),
		GotAnimationMessage: ({ message: animationMessage }) =>
			transition.foldAnimation(model, animationMessage),
	})

// MOUNT

/** Base UI sizes the positioner to the popup's fractional box (`--positioner-width/height`). */
const sizePositioner = (positioner: HTMLElement, popup: HTMLElement): void => {
	const box = popup.getBoundingClientRect()
	positioner.style.setProperty("--positioner-width", `${box.width}px`)
	positioner.style.setProperty("--positioner-height", `${box.height}px`)
}

/** Portal, placement under the open trigger and presses outside the menu (no marking, no focus move). */
export const MountNavigationMenu = Mount.defineStream("MountNavigationMenu", {
	args: { id: Schema.String, value: Schema.String, align: Align },
	messages: [Message.CompletedMountNavigationMenu, Message.ChangedPlacement, Message.PressedOutside],
	execute: ({ element, id, value, align }) =>
		anchoredPopup(element, {
			positionerSelector: ":scope > [role=presentation]",
			popupSelector: `#${CSS.escape(popupId(id))}`,
			config: {
				...positionDefaults,
				anchor: { _tag: "Element", id: triggerIdOf(id, value) },
				side: "bottom",
				align,
				sideOffset: 8,
				adaptiveOrigin: true,
			},
			insideSelectors: [`#${CSS.escape(rootId(id))}`],
			markOutside: Option.none(),
			lockScroll: false,
			focus: Option.none(),
			afterPlace: sizePositioner,
		}).pipe(
			Stream.map((event) =>
				event._tag === "Mounted"
					? Message.CompletedMountNavigationMenu()
					: event._tag === "Placed"
						? Message.ChangedPlacement({ side: event.placed.side, align: event.placed.align })
						: Message.PressedOutside(),
			),
		),
})

// VIEW

export type NavigationMenuItem =
	| Readonly<{ _tag: "Trigger"; value: string; label: string; content: ReadonlyArray<Html> }>
	| Readonly<{ _tag: "Link"; label: string; href: string }>

export type ViewInputs = Readonly<{
	items: ReadonlyArray<NavigationMenuItem>
	/** `<NavigationMenu align>` (the positioner's alignment). */
	align?: Align
	className?: string
}>

/** `<NavigationMenuLink href>`. */
export const navigationMenuLink = <M>(
	h: HtmlBuilder<M>,
	href: string,
	children: ReadonlyArray<Html | string>,
): Html =>
	h.a(
		[
			h.Class(cn(navigationMenuLinkStyles)),
			h.DataAttribute("slot", "navigation-menu-link"),
			h.Href(href),
		],
		children,
	)

type H = HtmlBuilder<Message>

const escapeKey = (h: H) =>
	h.OnKeyDownPreventDefault((key) =>
		key === "Escape" ? Option.some(Message.PressedEscape()) : Option.none(),
	)

const trigger = (
	h: H,
	model: Model,
	item: Extract<NavigationMenuItem, { _tag: "Trigger" }>,
): ReadonlyArray<Html> => {
	const isOpen = model.isOpen && model.value === item.value
	const button = h.button(
		[
			...(isOpen ? [h.AriaControls(popupId(model.id))] : []),
			h.AriaDisabled(false),
			h.AriaExpanded(isOpen),
			h.Class(cn(navigationMenuTriggerStyle(), navigationMenuTriggerGroupStyles)),
			h.DataAttribute("base-ui-navigation-menu-trigger", ""),
			...(isOpen ? [h.DataAttribute("popup-open", ""), h.DataAttribute("pressed", "")] : []),
			h.DataAttribute("slot", "navigation-menu-trigger"),
			h.Id(triggerIdOf(model.id, item.value)),
			h.Tabindex(0),
			h.Type("button"),
			h.OnClick(Message.ClickedTrigger({ value: item.value })),
			h.OnMouseEnter(Message.EnteredTrigger({ value: item.value })),
			h.OnMouseLeave(Message.LeftTrigger()),
			escapeKey(h),
		],
		[
			item.label,
			" ",
			icon(h, "ChevronDownIcon", {
				className: navigationMenuTriggerIconStyles,
				attributes: [h.Attribute("stroke-width", "2"), h.AriaHidden(true)],
			}),
		],
	)
	if (!isOpen) return [button]
	return [
		button,
		focusGuard(h, undefined, [h.Key("guard-before")]),
		h.span([
			h.Key("owner"),
			h.AriaOwns(viewportId(model.id)),
			h.Style({ clipPath: SR_ONLY_STYLE.clipPath, position: "fixed", top: "0px", left: "0px" }),
		]),
		focusGuard(h, undefined, [h.Key("guard-after")]),
	]
}

const portal = (h: H, model: Model, inputs: ViewInputs, value: string): Html => {
	const state = stateAttributes(h, model.isOpen, model.animation)
	const placement = [h.DataAttribute("align", model.align), ...state, h.DataAttribute("side", model.side)]
	const content = inputs.items.flatMap((item) =>
		item._tag === "Trigger" && item.value === value ? item.content : [],
	)
	return h.div(
		[
			// Keyed by the open item, so switching items re-anchors the Mount to the new trigger.
			h.Key(`${portalId(model.id)}-${value}`),
			h.DataAttribute("base-ui-portal", ""),
			h.Id(portalId(model.id)),
			h.OnMount(MountNavigationMenu({ id: model.id, value, align: inputs.align ?? "start" })),
		],
		[
			h.div(
				[
					h.Class(cn(navigationMenuPositionerStyles)),
					h.DataAttribute("align", model.align),
					h.DataAttribute("instant", ""),
					...state,
					h.DataAttribute("side", model.side),
					h.Role("presentation"),
				],
				[
					h.nav(
						[
							h.Class(navigationMenuPopupStyles),
							...placement,
							h.Id(popupId(model.id)),
							h.Style({ "--popup-width": "auto", "--popup-height": "auto" }),
							h.Tabindex(-1),
							h.OnMouseEnter(Message.EnteredPopup()),
							h.OnMouseLeave(Message.LeftPopup()),
							escapeKey(h),
						],
						[
							focusGuard(h, undefined),
							h.div(
								[h.Class(navigationMenuViewportStyles), h.Id(viewportId(model.id))],
								[
									h.div(
										[
											h.Class(cn(navigationMenuContentStyles)),
											...state,
											h.DataAttribute("slot", "navigation-menu-content"),
										],
										content,
									),
								],
							),
							focusGuard(h, undefined),
						],
					),
				],
			),
		],
	)
}

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) => {
	const openAttribute = model.isOpen ? [h.DataAttribute("open", "")] : []
	const isVisible = isMounted(model.isOpen, model.animation) && model.value !== null
	return h.nav(
		[
			h.Class(cn(navigationMenuStyles, inputs.className)),
			...openAttribute,
			h.DataAttribute("slot", "navigation-menu"),
			h.Id(rootId(model.id)),
		],
		[
			h.ul(
				[
					h.Class(cn(navigationMenuListStyles)),
					...openAttribute,
					h.DataAttribute("slot", "navigation-menu-list"),
				],
				inputs.items.map((item) =>
					h.li(
						[
							h.Class(cn(navigationMenuItemStyles)),
							h.DataAttribute("slot", "navigation-menu-item"),
						],
						item._tag === "Trigger"
							? trigger(h, model, item)
							: [navigationMenuLink(h, item.href, [item.label])],
					),
				),
			),
			...(isVisible && model.value !== null ? [portal(h, model, inputs, model.value)] : []),
		],
	)
})

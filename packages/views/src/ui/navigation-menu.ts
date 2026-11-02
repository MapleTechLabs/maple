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
import { Array, Duration, Effect, Number, Option, Queue, Schema, Stream } from "effect"
import { Command, Dom, Mount, Submodel, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { ChevronDownIcon } from "./control-icons"
import { iconNode } from "./icon"
import { anchoredPopup } from "./overlay/anchored"
import { tabbables } from "./overlay/portal"
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
const guardId = (id: string, place: "before" | "after" | "popup-start" | "popup-end"): string =>
	`${id}-guard-${place}`

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
	/** Tab past the popup's last link: focus moves on to what follows the trigger. */
	TabbedOut: {},
	CompletedMountNavigationMenu: {},
	CompletedFocusTrigger: {},
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

/** Escape hands focus back to the trigger, as Base UI's menu does. */
export const FocusTrigger = Command.define("FocusNavigationMenuTrigger", {
	args: { id: Schema.String },
	messages: [Message.CompletedFocusTrigger],
	execute: ({ id }) =>
		Dom.focus(`#${CSS.escape(id)}`).pipe(Effect.ignore, Effect.as(Message.CompletedFocusTrigger())),
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
		PressedEscape: () => {
			const closed = close(model)
			return model.value === null
				? closed
				: {
						...closed,
						commands: [...(closed.commands ?? []), FocusTrigger({ id: triggerIdOf(model.id, model.value) })],
					}
		},
		PressedOutside: () => close(model),
		TabbedOut: () => close(model),
		CompletedMountNavigationMenu: () => ({ model }),
		CompletedFocusTrigger: () => ({ model }),
		ChangedPlacement: ({ side, align }) => ({ model: { ...model, side, align } }),
		GotAnimationMessage: ({ message: animationMessage }) =>
			transition.foldAnimation(model, animationMessage),
	})

// MOUNT

/**
 * Base UI sizes the positioner to the popup's fractional box (`--positioner-width/height`). The
 * popup is measured at its content's own size, untransformed: a shrink-to-fit positioner near the
 * viewport edge, or a popup still scaled by its enter transition, would lock in a smaller box.
 */
const sizePositioner = (positioner: HTMLElement, popup: HTMLElement): void => {
	positioner.style.removeProperty("--positioner-width")
	positioner.style.removeProperty("--positioner-height")
	positioner.style.setProperty("width", "max-content")
	const style = getComputedStyle(popup)
	const width = style.width
	const height = style.height
	positioner.style.removeProperty("width")
	positioner.style.setProperty("--positioner-width", width)
	positioner.style.setProperty("--positioner-height", height)
}

const isFollowing = (anchor: Node, node: Node): boolean =>
	(anchor.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

/**
 * Base UI's focus guards around the portaled popup: Tab from the open trigger enters it, Shift+Tab
 * from the item after enters at its last link; leaving it goes back to the trigger or on past it.
 */
const focusGuards = (id: string, value: string): Stream.Stream<void> =>
	Stream.callback<void>((queue) =>
		Effect.acquireRelease(
			Effect.sync(() => {
				const onFocusIn = (event: FocusEvent) => {
					const guard = event.target
					const popup = document.getElementById(popupId(id))
					if (!(guard instanceof HTMLElement) || popup === null) return
					const inside = tabbables(popup)
					const focus = (target: Option.Option<HTMLElement>) =>
						Option.map(target, (element) => element.focus({ preventScroll: true }))
					if (guard.id === guardId(id, "before")) focus(Array.head(inside))
					else if (guard.id === guardId(id, "after")) focus(Array.last(inside))
					else if (guard.id === guardId(id, "popup-start"))
						focus(Option.fromNullishOr(document.getElementById(triggerIdOf(id, value))))
					else if (guard.id === guardId(id, "popup-end")) {
						const after = document.getElementById(guardId(id, "after"))
						const trigger = Option.fromNullishOr(document.getElementById(triggerIdOf(id, value)))
						// Nothing focusable after the menu: back to the trigger rather than the body.
						focus(
							Option.orElse(
								Array.findFirst(
									tabbables(document.body),
									(element) =>
										after !== null && !popup.contains(element) && isFollowing(after, element),
								),
								() => trigger,
							),
						)
						Queue.offerUnsafe(queue, undefined)
					}
				}
				document.addEventListener("focusin", onFocusIn)
				return onFocusIn
			}),
			(onFocusIn) => Effect.sync(() => document.removeEventListener("focusin", onFocusIn)),
		).pipe(Effect.andThen(Effect.never)),
	)

/** Portal, placement under the open trigger and presses outside the menu (no marking, no focus move). */
export const MountNavigationMenu = Mount.defineStream("MountNavigationMenu", {
	args: { id: Schema.String, value: Schema.String, align: Align },
	messages: [
		Message.CompletedMountNavigationMenu,
		Message.ChangedPlacement,
		Message.PressedOutside,
		Message.TabbedOut,
	],
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
			Stream.merge(focusGuards(id, value).pipe(Stream.map(() => Message.TabbedOut()))),
		),
})

// VIEW

export type NavigationMenuItem =
	| Readonly<{
			_tag: "Trigger"
			value: string
			label: string
			content: ReadonlyArray<Html>
			/** `<NavigationMenuTrigger className>` and `<NavigationMenuContent className>`. */
			className?: string
			contentClassName?: string
	  }>
	| Readonly<{ _tag: "Link"; label: string; href: string }>
	/** `<NavigationMenuItem>` around the caller's own children (a plain anchor). */
	| Readonly<{ _tag: "Item"; content: ReadonlyArray<Html> }>

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
	className?: string,
): Html =>
	h.a(
		[
			h.Class(cn(navigationMenuLinkStyles, className)),
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
			h.Class(cn(navigationMenuTriggerStyle(), navigationMenuTriggerGroupStyles, item.className)),
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
			iconNode(h, ChevronDownIcon, "ChevronDownIcon", {
				className: navigationMenuTriggerIconStyles,
				attributes: [h.Attribute("stroke-width", "2"), h.AriaHidden(true)],
			}),
		],
	)
	if (!isOpen) return [button]
	return [
		button,
		focusGuard(h, undefined, [h.Key("guard-before"), h.Id(guardId(model.id, "before"))]),
		h.span([
			h.Key("owner"),
			h.AriaOwns(viewportId(model.id)),
			h.Style({ clipPath: SR_ONLY_STYLE.clipPath, position: "fixed", top: "0px", left: "0px" }),
		]),
		focusGuard(h, undefined, [h.Key("guard-after"), h.Id(guardId(model.id, "after"))]),
	]
}

const portal = (h: H, model: Model, inputs: ViewInputs, value: string): Html => {
	const state = stateAttributes(h, model.isOpen, model.animation)
	const placement = [h.DataAttribute("align", model.align), ...state, h.DataAttribute("side", model.side)]
	const open = Array.findFirst(
		inputs.items,
		(item): item is Extract<NavigationMenuItem, { _tag: "Trigger" }> =>
			item._tag === "Trigger" && item.value === value,
	)
	const content = Option.match(open, { onNone: () => [], onSome: (item) => item.content })
	const contentClassName = Option.match(open, { onNone: () => undefined, onSome: (item) => item.contentClassName })
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
							focusGuard(h, undefined, [h.Id(guardId(model.id, "popup-start"))]),
							h.div(
								[h.Class(navigationMenuViewportStyles), h.Id(viewportId(model.id))],
								[
									h.div(
										[
											h.Class(cn(navigationMenuContentStyles, contentClassName)),
											...state,
											h.DataAttribute("slot", "navigation-menu-content"),
										],
										content,
									),
								],
							),
							focusGuard(h, undefined, [h.Id(guardId(model.id, "popup-end"))]),
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
							: item._tag === "Item"
								? item.content
								: [navigationMenuLink(h, item.href, [item.label])],
					),
				),
			),
			...(isVisible && model.value !== null ? [portal(h, model, inputs, model.value)] : []),
		],
	)
})

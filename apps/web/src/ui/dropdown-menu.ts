import { cn } from "@maple/ui/lib/utils"
import {
	dropdownMenuCheckboxItemIndicatorStyles,
	dropdownMenuCheckboxItemStyles,
	dropdownMenuContentStyles,
	dropdownMenuItemStyles,
	dropdownMenuLabelStyles,
	dropdownMenuPositionerStyles,
	dropdownMenuRadioItemIndicatorStyles,
	dropdownMenuRadioItemStyles,
	dropdownMenuSeparatorStyles,
	dropdownMenuShortcutStyles,
	dropdownMenuSubTriggerIconStyles,
	dropdownMenuSubTriggerStyles,
} from "@maple/ui/styles/ui/dropdown-menu"
import { Option } from "effect"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import type { Align, PopupPosition, Side } from "./anchor"
import { icon } from "./icon"

// The Foldkit side of packages/ui/src/components/ui/dropdown-menu.tsx over Base UI's Menu DOM.

type Children = ReadonlyArray<Html | string>

/** `<Menu.Trigger>`'s attributes; spread onto whatever element renders the trigger. */
export const menuTriggerAttributes = <Message>(
	h: HtmlBuilder<Message>,
	options: Readonly<{ id: string; isOpen: boolean; onToggle: Message }>,
): ReadonlyArray<Attribute<Message>> => [
	h.AriaExpanded(options.isOpen),
	h.AriaHasPopup("menu"),
	h.Id(options.id),
	h.Tabindex(0),
	...(options.isOpen ? [h.DataAttribute("popup-open", ""), h.DataAttribute("pressed", "")] : []),
	h.OnClick(options.onToggle),
]

/** The positioner's inline style before and after the first measurement (`useAnchorPositioning`). */
export const positionerStyle = (maybePosition: Option.Option<PopupPosition>): Record<string, string> =>
	Option.match(maybePosition, {
		onNone: () => ({
			position: "fixed",
			top: "0px",
			left: "0px",
			"--available-width": "100vw",
			"--available-height": "100vh",
			opacity: "0",
			// Unmeasured and invisible at the origin: it must not catch the resting pointer either, or
			// Chromium's after-layout mouse events highlight whichever item sits under it.
			"pointer-events": "none",
		}),
		onSome: (position) => ({
			position: "absolute",
			top: "0px",
			left: "0px",
			"--available-width": `${position.availableWidth}px`,
			"--available-height": `${position.availableHeight}px`,
			"--anchor-width": `${position.anchorWidth}px`,
			"--anchor-height": `${position.anchorHeight}px`,
			"--transform-origin": position.transformOrigin,
			transform: `translate(${position.x}px, ${position.y}px)`,
		}),
	})

/** The modal backdrop: covers the page except the trigger, so the trigger keeps its hover state. */
const backdropStyle = (maybePosition: Option.Option<PopupPosition>): Record<string, string> => {
	const base = { position: "fixed", inset: "0px", "user-select": "none" }
	return Option.match(maybePosition, {
		onNone: () => base,
		onSome: ({ anchor }) => {
			const [left, top, right, bottom] = [
				anchor.x,
				anchor.y,
				anchor.x + anchor.width,
				anchor.y + anchor.height,
			]
			return {
				...base,
				"clip-path": `polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 0%, ${left}px ${top}px, ${left}px ${bottom}px, ${right}px ${bottom}px, ${right}px ${top}px, ${left}px ${top}px)`,
			}
		},
	})
}
// PORTAL

export type MenuPopupOptions<Message> = Readonly<{
	popupId: string
	triggerId: string
	side: Side
	align: Align
	className?: string
	maybePosition: Option.Option<PopupPosition>
	/** The positioning Mount: measures the trigger and this positioner, reports `PopupPosition`. */
	mount: Attribute<Message>
	onDismiss: Message
	onKeyDown: (key: string) => Option.Option<Message>
}>

/**
 * `<DropdownMenuContent>`: Base UI's portal (backdrop + positioner + popup), rendered last in the
 * app root. Before the Mount measures, the positioner sits hidden at the origin like Base UI's.
 */
export const menuPopup = <Message>(
	h: HtmlBuilder<Message>,
	options: MenuPopupOptions<Message>,
	children: Children,
): Html => {
	const position = Option.match(options.maybePosition, {
		onNone: () => ({ side: options.side, align: options.align }),
		onSome: ({ side, align }) => ({ side, align }),
	})
	return h.div(
		[h.DataAttribute("base-ui-portal", "")],
		[
			h.div(
				[
					h.DataAttribute("base-ui-inert", ""),
					h.Role("presentation"),
					h.Style(backdropStyle(options.maybePosition)),
					h.OnClick(options.onDismiss),
				],
				[],
			),
			h.div(
				[
					h.Class(dropdownMenuPositionerStyles),
					h.DataAttribute("align", position.align),
					h.DataAttribute("open", ""),
					h.DataAttribute("side", position.side),
					h.Role("presentation"),
					h.Style(positionerStyle(options.maybePosition)),
					options.mount,
				],
				[
					h.div(
						[
							h.AriaLabelledBy(options.triggerId),
							h.Class(cn(dropdownMenuContentStyles, options.className)),
							h.DataAttribute("align", position.align),
							h.DataAttribute("base-ui-focusable", ""),
							h.DataAttribute("open", ""),
							h.DataAttribute("side", position.side),
							h.DataAttribute("slot", "dropdown-menu-content"),
							h.Id(options.popupId),
							h.Role("menu"),
							h.Tabindex(-1),
							h.OnKeyDownPreventDefault(options.onKeyDown),
						],
						children,
					),
				],
			),
		],
	)
}
// PARTS

/** `<DropdownMenuGroup>`; with a label, Base UI points `aria-labelledby` at it. */
export const menuGroup = <Message>(
	h: HtmlBuilder<Message>,
	maybeLabelId: string | undefined,
	children: Children,
): Html =>
	h.div(
		[
			...(maybeLabelId === undefined ? [] : [h.AriaLabelledBy(maybeLabelId)]),
			h.DataAttribute("slot", "dropdown-menu-group"),
			h.Role("group"),
		],
		children,
	)

/** `<DropdownMenuLabel>` (Base UI `Menu.GroupLabel`, hidden from the accessibility tree). */
export const menuLabel = <Message>(
	h: HtmlBuilder<Message>,
	id: string,
	children: Children,
	className?: string,
): Html =>
	h.div(
		[
			h.AriaHidden(true),
			h.Class(cn(dropdownMenuLabelStyles, className)),
			h.DataAttribute("slot", "dropdown-menu-label"),
			h.Id(id),
		],
		children,
	)

export type MenuItemOptions<Message> = Readonly<{
	id: string
	className?: string
	/** `render={<Link to />}` or `<a href>`: the item is an anchor. */
	href?: string
	/** Extra anchor attributes (`target`, `rel`, `aria-label`) for external links. */
	attributes?: ReadonlyArray<Attribute<Message>>
	onSelect?: Message
	/** Base UI moves focus to the hovered item; the parent turns this into a focus Command. */
	onHighlight: Message
	variant?: "default" | "destructive"
	/** Base UI's `data-highlighted`, for a Model that tracks the highlight (`menu.ts`). */
	isHighlighted?: boolean
	/** Base UI's `disabled`: `aria-disabled` and `data-disabled`, no hover or select. */
	isDisabled?: boolean
}>

/** `<DropdownMenuItem>`: a `menuitem` focused on hover, so `focus:` styles mark the highlight. */
export const menuItem = <Message>(
	h: HtmlBuilder<Message>,
	options: MenuItemOptions<Message>,
	children: Children,
): Html => {
	const attributes: Array<Attribute<Message>> = [
		h.Class(cn(dropdownMenuItemStyles, options.className)),
		h.DataAttribute("slot", "dropdown-menu-item"),
		...(options.isHighlighted === true ? [h.DataAttribute("highlighted", "")] : []),
		h.DataAttribute("variant", options.variant ?? "default"),
		h.Id(options.id),
		h.Role("menuitem"),
		h.Tabindex(options.isHighlighted === true ? 0 : -1),
		...(options.isDisabled === true
			? [h.AriaDisabled(true), h.DataAttribute("disabled", "")]
			: [
					h.OnMouseEnter(options.onHighlight),
					...(options.onSelect === undefined ? [] : [h.OnClick(options.onSelect)]),
				]),
		...(options.attributes ?? []),
	]
	return options.href === undefined
		? h.div(attributes, children)
		: h.a([h.Href(options.href), ...attributes], children)
}

export const menuSeparator = <Message>(h: HtmlBuilder<Message>): Html =>
	h.div(
		[
			h.AriaOrientation("horizontal"),
			h.Class(cn(dropdownMenuSeparatorStyles)),
			h.DataAttribute("orientation", "horizontal"),
			h.DataAttribute("slot", "dropdown-menu-separator"),
			h.Role("separator"),
		],
		[],
	)

export const menuShortcut = <Message>(h: HtmlBuilder<Message>, children: Children): Html =>
	h.span(
		[h.Class(cn(dropdownMenuShortcutStyles)), h.DataAttribute("slot", "dropdown-menu-shortcut")],
		children,
	)
// CHECKABLE AND SUBMENU ITEMS

/** What a highlightable item needs beyond its content: id, highlight and its two handlers. */
export type MenuRowOptions<Message> = Readonly<{
	id: string
	isHighlighted: boolean
	onHighlight: Message
	onSelect: Message
}>

const rowAttributes = <Message>(
	h: HtmlBuilder<Message>,
	options: MenuRowOptions<Message>,
): ReadonlyArray<Attribute<Message>> => [
	...(options.isHighlighted ? [h.DataAttribute("highlighted", "")] : []),
	h.Id(options.id),
	h.Tabindex(options.isHighlighted ? 0 : -1),
	h.OnMouseEnter(options.onHighlight),
	h.OnClick(options.onSelect),
]

/** `<CheckIcon strokeWidth={2} />` inside Base UI's item indicator, rendered only while checked. */
const checkIndicator = <Message>(h: HtmlBuilder<Message>, slot: string, styles: string, isChecked: boolean) =>
	h.span(
		[h.Class(styles), h.DataAttribute("slot", slot)],
		isChecked
			? [
					h.span(
						[h.AriaHidden(true), h.DataAttribute("checked", "")],
						[icon(h, "CheckIcon", { attributes: [h.Attribute("stroke-width", "2")] })],
					),
				]
			: [],
	)

/** `<DropdownMenuCheckboxItem>` (and, with `kind: "radio"`, `<DropdownMenuRadioItem>`). */
export const menuCheckableItem = <Message>(
	h: HtmlBuilder<Message>,
	options: MenuRowOptions<Message> & Readonly<{ kind: "checkbox" | "radio"; isChecked: boolean }>,
	children: Children,
): Html => {
	const isCheckbox = options.kind === "checkbox"
	const slot = isCheckbox ? "dropdown-menu-checkbox-item" : "dropdown-menu-radio-item"
	return h.div(
		[
			h.AriaChecked(options.isChecked),
			h.Class(cn(isCheckbox ? dropdownMenuCheckboxItemStyles : dropdownMenuRadioItemStyles)),
			h.DataAttribute(options.isChecked ? "checked" : "unchecked", ""),
			h.DataAttribute("slot", slot),
			h.Role(isCheckbox ? "menuitemcheckbox" : "menuitemradio"),
			...rowAttributes(h, options),
		],
		[
			checkIndicator(
				h,
				`${slot}-indicator`,
				isCheckbox ? dropdownMenuCheckboxItemIndicatorStyles : dropdownMenuRadioItemIndicatorStyles,
				options.isChecked,
			),
			...children,
		],
	)
}

/** `<DropdownMenuRadioGroup>`. */
export const menuRadioGroup = <Message>(
	h: HtmlBuilder<Message>,
	maybeLabelId: string | undefined,
	children: Children,
): Html =>
	h.div(
		[
			...(maybeLabelId === undefined ? [] : [h.AriaLabelledBy(maybeLabelId)]),
			h.DataAttribute("slot", "dropdown-menu-radio-group"),
			h.Role("group"),
		],
		children,
	)

/** `<DropdownMenuSubTrigger>`: a `menuitem` that owns a submenu, with a trailing chevron. */
export const menuSubTrigger = <Message>(
	h: HtmlBuilder<Message>,
	options: MenuRowOptions<Message> & Readonly<{ isSubmenuOpen: boolean }>,
	children: Children,
): Html =>
	h.div(
		[
			h.AriaExpanded(options.isSubmenuOpen),
			h.AriaHasPopup("menu"),
			h.Class(cn(dropdownMenuSubTriggerStyles)),
			...(options.isSubmenuOpen ? [h.DataAttribute("popup-open", "")] : []),
			h.DataAttribute("slot", "dropdown-menu-sub-trigger"),
			h.Role("menuitem"),
			...rowAttributes(h, options),
		],
		[
			...children,
			icon(h, "ChevronRightIcon", {
				className: dropdownMenuSubTriggerIconStyles,
				attributes: [h.Attribute("stroke-width", "2")],
			}),
		],
	)

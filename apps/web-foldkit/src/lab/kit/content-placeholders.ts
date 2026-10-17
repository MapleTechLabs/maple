import { cn } from "@maple/ui/lib/utils"
import { avatarFallbackStyles, avatarStyles } from "@maple/ui/styles/ui/avatar"
import {
	scrollAreaStyles,
	scrollAreaThumbStyles,
	scrollAreaViewportStyles,
	scrollBarStyles,
} from "@maple/ui/styles/ui/scroll-area"
import { switchStyles, switchThumbStyles } from "@maple/ui/styles/ui/switch"
import type { Html, HtmlBuilder } from "foldkit/html"

// Static stand-ins for primitives other ports own, producing legacy's DOM for `/lab/kit/content`.

// TODO(app-shell): replace with src/ui/avatar.ts
export const avatarPlaceholder = <M>(h: HtmlBuilder<M>, fallback: string, className?: string): Html =>
	h.span(
		[h.Class(cn(avatarStyles, className)), h.DataAttribute("slot", "avatar")],
		[h.span([h.Class(avatarFallbackStyles), h.DataAttribute("slot", "avatar-fallback")], [fallback])],
	)

/** Base UI's visually hidden form input behind a switch. */
const HIDDEN_INPUT_STYLE =
	"clip-path: inset(50%); overflow: hidden; white-space: nowrap; border: 0px; padding: 0px; width: 1px; height: 1px; margin: -1px; position: fixed; top: 0px; left: 0px;"

export interface SwitchPlaceholderOptions {
	readonly id: string
	readonly inputId: string
	readonly labelledBy: string
	readonly describedBy?: string
	readonly checked?: boolean
	readonly disabled?: boolean
	/** The enclosing Base UI field's `data-filled`. */
	readonly filled?: boolean
}

// TODO(app-shell): replace with src/ui/switch.ts (static: it does not toggle)
export const switchPlaceholder = <M>(
	h: HtmlBuilder<M>,
	options: SwitchPlaceholderOptions,
): ReadonlyArray<Html> => {
	const checked = options.checked ?? false
	const disabled = options.disabled ?? false
	const state = [
		h.DataAttribute(checked ? "checked" : "unchecked", ""),
		...(disabled ? [h.DataAttribute("disabled", "")] : []),
		...((options.filled ?? false) ? [h.DataAttribute("filled", "")] : []),
	]
	const describedBy = options.describedBy === undefined ? [] : [h.AriaDescribedBy(options.describedBy)]
	return [
		h.span(
			[
				h.AriaChecked(checked),
				...describedBy,
				...(disabled ? [h.AriaDisabled(true)] : []),
				h.AriaLabelledBy(options.labelledBy),
				h.Class(switchStyles),
				...state,
				h.DataAttribute("slot", "switch"),
				h.Id(options.id),
				h.Role("switch"),
				h.Tabindex(disabled ? -1 : 0),
			],
			[h.span([h.Class(switchThumbStyles), ...state, h.DataAttribute("slot", "switch-thumb")], [])],
		),
		h.input([
			...describedBy,
			h.AriaHidden(true),
			...(checked ? [h.Checked(true)] : []),
			...(disabled ? [h.Disabled(true)] : []),
			h.Id(options.inputId),
			h.Attribute("style", HIDDEN_INPUT_STYLE),
			h.Tabindex(-1),
			h.Type("checkbox"),
		]),
	]
}

/** What Base UI's ScrollArea measured for the kit's 12-row list in a 160px box (static here). */
const SCROLL_STATE = ["has-overflow-y", "overflow-y-end"] as const
const ROOT_STYLE = "position: relative; --scroll-area-corner-height: 0px; --scroll-area-corner-width: 0px;"
const VIEWPORT_STYLE =
	"overflow: scroll; --scroll-area-overflow-x-start: 0px; --scroll-area-overflow-x-end: 0px; --scroll-area-overflow-y-start: 0px; --scroll-area-overflow-y-end: 146px;"
const SCROLLBAR_STYLE =
	"position: absolute; touch-action: none; user-select: none; top: 0px; bottom: var(--scroll-area-corner-height); inset-inline-end: 0px; --scroll-area-thumb-height: 77.96052631578948px;"
const THUMB_STYLE = "height: var(--scroll-area-thumb-height); transform: translate3d(0px, 0px, 0px);"

// TODO(app-shell): replace with src/ui/scroll-area.ts (measures nothing; the kit page's values)
export const scrollAreaPlaceholder = <M>(
	h: HtmlBuilder<M>,
	options: { readonly id: string; readonly className?: string },
	children: ReadonlyArray<Html>,
): Html => {
	const state = SCROLL_STATE.map((key) => h.DataAttribute(key, ""))
	const vertical = h.DataAttribute("orientation", "vertical")
	return h.div(
		[
			h.Class(cn(scrollAreaStyles, options.className)),
			...state,
			h.Role("presentation"),
			h.Attribute("style", ROOT_STYLE),
		],
		[
			h.div(
				[
					h.Class(cn(scrollAreaViewportStyles, "base-ui-disable-scrollbar")),
					...state,
					h.DataAttribute("id", `${options.id}-viewport`),
					h.DataAttribute("slot", "scroll-area-viewport"),
					h.Role("presentation"),
					h.Attribute("style", VIEWPORT_STYLE),
					h.Tabindex(0),
				],
				children,
			),
			h.div(
				[
					h.AriaHidden(true),
					h.Class(scrollBarStyles),
					...state,
					h.DataAttribute("id", `${options.id}-scrollbar`),
					vertical,
					h.DataAttribute("slot", "scroll-area-scrollbar"),
					h.Attribute("style", SCROLLBAR_STYLE),
				],
				[
					h.div(
						[
							h.Class(scrollAreaThumbStyles),
							vertical,
							h.DataAttribute("slot", "scroll-area-thumb"),
							h.Attribute("style", THUMB_STYLE),
						],
						[],
					),
				],
			),
		],
	)
}

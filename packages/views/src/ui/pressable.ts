import { cn } from "@maple/ui/lib/utils"
import { rowSelectedClass } from "@maple/ui/styles/ui/list-row"
import type { Attribute, ChildAttribute, Html, HtmlBuilder } from "foldkit/html"

// `Pressable`: a click target that draws its own look (a timeline lane, a chart bar, a colour
// swatch, a bespoke row). The kit owns the element, its type, focus ring, disabled state and
// `aria-pressed`; `className` owns the look. Use `button`, `iconButton`, `textLink`, `cardButton`
// or a clickable `listRow` first: this is for what none of them draws.

const BASE =
	"cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50"

export type PressableOptions<M> = Readonly<{
	onClick?: M
	type?: "button" | "submit"
	/** Sets `aria-pressed`, for a target that toggles. */
	isSelected?: boolean
	isDisabled?: boolean
	/** A bespoke row's selection lane (left bar and tint, as `listRow`); `false` keeps the lane clear. */
	selectedLane?: boolean
	/** `aria-label`, for a target without readable text. */
	label?: string
	className?: string
	attributes?: ReadonlyArray<Attribute<M> | ChildAttribute>
}>

export const pressable = <M>(
	h: HtmlBuilder<M>,
	options: PressableOptions<M>,
	children: ReadonlyArray<Html | string>,
): Html =>
	h.button(
		[
			h.Type(options.type ?? "button"),
			h.Class(
				cn(
					BASE,
					options.selectedLane !== undefined && rowSelectedClass(options.selectedLane),
					options.className,
				),
			),
			h.DataAttribute("slot", "pressable"),
			...(options.onClick === undefined ? [] : [h.OnClick(options.onClick)]),
			...(options.isSelected === undefined ? [] : [h.AriaPressed(options.isSelected ? "true" : "false")]),
			...(options.label === undefined ? [] : [h.AriaLabel(options.label)]),
			...((options.isDisabled ?? false) ? [h.Disabled(true)] : []),
			...(options.attributes ?? []),
		],
		children,
	)

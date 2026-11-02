import * as Animation from "@foldkit/ui/animation"
import type { Attribute, HtmlBuilder } from "foldkit/html"

/**
 * Base UI's transition status on a Foldkit Animation: `data-starting-style` on the first frame of
 * an open, `data-ending-style` while it closes, and `data-open` / `data-closed` throughout.
 */
export const isLeaving = (animation: Animation.Model): boolean =>
	animation.transitionState === "LeaveStart" || animation.transitionState === "LeaveAnimating"

/** Rendered while open or while its exit transition runs. */
export const isMounted = (isOpen: boolean, animation: Animation.Model): boolean =>
	isOpen || isLeaving(animation)

export const stateAttributes = <Message>(
	h: HtmlBuilder<Message>,
	isOpen: boolean,
	animation: Animation.Model,
): ReadonlyArray<Attribute<Message>> => [
	...(isOpen ? [h.DataAttribute("open", "")] : [h.DataAttribute("closed", "")]),
	...(animation.transitionState === "EnterStart" ? [h.DataAttribute("starting-style", "")] : []),
	...(isLeaving(animation) ? [h.DataAttribute("ending-style", "")] : []),
]

export const SR_ONLY_STYLE = {
	clipPath: "inset(50%)",
	overflow: "hidden",
	whiteSpace: "nowrap",
	border: "0px",
	padding: "0px",
	width: "1px",
	height: "1px",
	margin: "-1px",
	position: "fixed",
	top: "0px",
	left: "0px",
}

/** Base UI's `FocusGuard`: a visually hidden tabbable span that wraps focus at a popup's edges. */
export const focusGuard = <Message>(
	h: HtmlBuilder<Message>,
	type: "inside" | "outside" | undefined,
	extra: ReadonlyArray<Attribute<Message>> = [],
) =>
	h.span([
		h.AriaHidden(true),
		h.DataAttribute("base-ui-focus-guard", ""),
		...(type === undefined ? [] : [h.DataAttribute("type", type)]),
		...extra,
		h.Style(SR_ONLY_STYLE),
		h.Tabindex(0),
	])

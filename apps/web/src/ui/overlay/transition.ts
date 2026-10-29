import type { AnimationBlock } from "@foldkit/ui/animation"
import type { Attribute, HtmlBuilder } from "foldkit/html"

/** A popup's Animation state, as stored in `PopupState.animation`. */
export type AnimationModel = typeof AnimationBlock.Model.Type

/**
 * Base UI's transition status on a Foldkit Animation: `data-starting-style` on the first frame of
 * an open, `data-ending-style` while it closes, and `data-open` / `data-closed` throughout.
 */
export const isLeaving = (animation: AnimationModel): boolean =>
	animation.transitionState === "LeaveStart" || animation.transitionState === "LeaveAnimating"

/** Rendered while open or while its exit transition runs. */
export const isMounted = (isOpen: boolean, animation: AnimationModel): boolean =>
	isOpen || isLeaving(animation)

export const stateAttributes = <Message, MountRequirements = never>(
	h: HtmlBuilder<Message, MountRequirements>,
	isOpen: boolean,
	animation: AnimationModel,
): ReadonlyArray<Attribute<Message, MountRequirements>> => [
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
export const focusGuard = <Message, MountRequirements = never>(
	h: HtmlBuilder<Message, MountRequirements>,
	type: "inside" | "outside" | undefined,
	extra: ReadonlyArray<Attribute<Message, MountRequirements>> = [],
) =>
	h.span([
		h.AriaHidden(true),
		h.DataAttribute("base-ui-focus-guard", ""),
		...(type === undefined ? [] : [h.DataAttribute("type", type)]),
		...extra,
		h.Style(SR_ONLY_STYLE),
		h.Tabindex(0),
	])

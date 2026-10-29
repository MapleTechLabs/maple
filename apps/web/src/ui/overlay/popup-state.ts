import { Schema } from "effect"
import { Align, Side } from "./position"
import { PopupTransitionBlock } from "./popup-transition"

export { PopupTransitionBlock } from "./popup-transition"

/**
 * Open state shared by every anchored popup's Model: open flag, Base UI transition status and
 * the side and alignment the positioner rendered on (after any flip).
 */
export const PopupState = Schema.Struct({
	id: Schema.String,
	isOpen: Schema.Boolean,
	animation: PopupTransitionBlock.Model,
	side: Side,
	align: Align,
})
export type PopupState = typeof PopupState.Type

export const popupId = (id: string): string => `${id}-popup`
export const triggerId = (id: string): string => `${id}-trigger`
export const portalId = (id: string): string => `${id}-portal`

/** Builds the popup fields; bind `animation` with `init: false` since it starts here. */
export const initPopup = (
	id: string,
	options: Readonly<{ isOpen?: boolean; side: Side; align: Align }>,
): PopupState => ({
	id,
	isOpen: options.isOpen ?? false,
	animation: PopupTransitionBlock.init({ id: popupId(id), isShowing: options.isOpen ?? false }).model,
	side: options.side,
	align: options.align,
})

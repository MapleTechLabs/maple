import type { Side } from "./position"

/**
 * Base UI's `usePopupAutoResize`: the popup is measured static inside a `max-content` positioner
 * (a long label near the viewport edge must not wrap), the positioner takes that fractional size,
 * and a popup on the top or left side is pinned to the positioner edge facing the trigger.
 */
export const fitPositionerToPopup = (positioner: HTMLElement, popup: HTMLElement, side: Side): void => {
	positioner.style.setProperty("--positioner-width", "max-content")
	positioner.style.setProperty("--positioner-height", "max-content")
	popup.style.position = "static"
	// The layout size: unlike the bounding box, an entry transition's `scale-98` does not shrink it.
	const style = getComputedStyle(popup)
	const box = { width: Number.parseFloat(style.width), height: Number.parseFloat(style.height) }
	positioner.style.setProperty("--positioner-width", `${box.width}px`)
	positioner.style.setProperty("--positioner-height", `${box.height}px`)
	const isTop = side === "top"
	const isLeft = side === "left"
	if (!isTop && !isLeft) {
		popup.style.removeProperty("position")
		return
	}
	popup.style.position = "absolute"
	popup.style.removeProperty(isTop ? "top" : "bottom")
	popup.style.removeProperty(isLeft ? "left" : "right")
	popup.style.setProperty(isTop ? "bottom" : "top", "0px")
	popup.style.setProperty(isLeft ? "right" : "left", "0px")
}

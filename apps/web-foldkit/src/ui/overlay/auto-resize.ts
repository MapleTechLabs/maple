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
	// Measured at rest: an entry transition's `scale-98` would shrink the box.
	const transform = popup.style.getPropertyValue("transform")
	const scale = popup.style.getPropertyValue("scale")
	popup.style.setProperty("transform", "none")
	popup.style.setProperty("scale", "1")
	const box = popup.getBoundingClientRect()
	popup.style.setProperty("transform", transform)
	popup.style.setProperty("scale", scale)
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

/**
 * Base UI Select's `alignItemWithTrigger` (select/popup/SelectPopup.mjs, @base-ui/react 1.8): the
 * popup opens over the trigger so the selected item's text sits on the trigger's value. Returns
 * false where Base UI falls back to anchoring below the trigger (too close to an edge, too short).
 */
const SCROLL_EDGE_TOLERANCE_PX = 1
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)
const maxScrollTop = (element: HTMLElement) => Math.max(0, element.scrollHeight - element.clientHeight)

export type AlignElements = Readonly<{
	trigger: HTMLElement
	positioner: HTMLElement
	popup: HTMLElement
	scroller: HTMLElement
	value: HTMLElement | null
	text: HTMLElement | null
}>

export const alignItemWithTrigger = (elements: AlignElements): boolean => {
	const { trigger, positioner, popup, scroller } = elements
	const positionerStyles = getComputedStyle(positioner)
	const popupStyles = getComputedStyle(popup)
	const triggerRect = trigger.getBoundingClientRect()
	const positionerRect = positioner.getBoundingClientRect()
	const scrollHeight = scroller.scrollHeight
	const borderBottom = parseFloat(popupStyles.borderBottomWidth)
	const marginTop = parseFloat(positionerStyles.marginTop) || 10
	const marginBottom = parseFloat(positionerStyles.marginBottom) || 10
	const minHeight = parseFloat(positionerStyles.minHeight) || 100
	const viewportHeight = document.documentElement.clientHeight - marginTop - marginBottom
	const viewportWidth = document.documentElement.clientWidth
	const availableSpaceBeneathTrigger = viewportHeight - triggerRect.bottom + triggerRect.height
	const textRect = elements.text?.getBoundingClientRect()
	const valueRect = elements.value?.getBoundingClientRect()
	const isTextAligned = textRect !== undefined && valueRect !== undefined
	const alignedLeft = isTextAligned
		? positionerRect.left + (valueRect.left - textRect.left)
		: triggerRect.left
	const offsetY = isTextAligned
		? textRect.top -
			positionerRect.top +
			textRect.height / 2 -
			(valueRect.top - triggerRect.top + valueRect.height / 2)
		: 0
	const idealHeight = availableSpaceBeneathTrigger + offsetY + marginBottom + borderBottom
	const firstHeight = Math.min(viewportHeight, idealHeight)
	const maxHeight = viewportHeight - marginTop - marginBottom
	const scrollTop = idealHeight - firstHeight
	positioner.style.left = `${clamp(alignedLeft, 5, viewportWidth - 5 - positionerRect.width)}px`
	positioner.style.height = `${firstHeight}px`
	positioner.style.maxHeight = "none"
	positioner.style.marginTop = `${marginTop}px`
	positioner.style.marginBottom = `${marginBottom}px`
	popup.style.height = "100%"
	const maxScroll = maxScrollTop(scroller)
	const isTopPositioned = scrollTop >= maxScroll - SCROLL_EDGE_TOLERANCE_PX
	const height = isTopPositioned
		? Math.min(viewportHeight, positionerRect.height) - (scrollTop - maxScroll)
		: firstHeight
	const isFallback =
		triggerRect.top < 20 ||
		triggerRect.bottom > viewportHeight - 20 ||
		Math.ceil(height) + SCROLL_EDGE_TOLERANCE_PX < Math.min(scrollHeight, minHeight)
	if (isFallback) {
		positioner.style.removeProperty("left")
		positioner.style.removeProperty("height")
		positioner.style.removeProperty("max-height")
		positioner.style.removeProperty("margin-top")
		positioner.style.removeProperty("margin-bottom")
		popup.style.removeProperty("height")
		return false
	}
	if (isTopPositioned) {
		const topOffset = Math.max(0, viewportHeight - idealHeight)
		positioner.style.top = positionerRect.height >= maxHeight ? "0" : `${topOffset}px`
		positioner.style.height = `${height}px`
		scroller.scrollTop = maxScrollTop(scroller)
	} else {
		positioner.style.removeProperty("top")
		positioner.style.bottom = "0"
		scroller.scrollTop = scrollTop
	}
	if (textRect !== undefined) {
		const textCenterY = textRect.top + textRect.height / 2
		const ratio =
			positionerRect.height > 0
				? ((textCenterY - positionerRect.top) / positionerRect.height) * 100
				: 50
		popup.style.setProperty("--transform-origin", `50% ${clamp(ratio, 0, 100)}%`)
	}
	return true
}

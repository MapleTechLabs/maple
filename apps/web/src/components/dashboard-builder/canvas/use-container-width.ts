import { useLayoutEffect, useState, type RefObject } from "react"

/**
 * The element's width in whole px, measured before first paint.
 *
 * Not `useContainerSize`: that measures in an effect, so the board painted
 * empty for a frame before its grids appeared, and it also tracks height, so
 * every section collapse or tile resize re-rendered the whole board for a
 * value nothing here reads.
 */
export function useContainerWidth(ref: RefObject<HTMLElement | null>): number {
	const [width, setWidth] = useState(0)

	useLayoutEffect(() => {
		const element = ref.current
		if (!element) return
		setWidth(Math.round(element.getBoundingClientRect().width))
		const observer = new ResizeObserver((entries) => {
			const entry = entries.at(-1)
			if (entry) setWidth(Math.round(entry.contentRect.width))
		})
		observer.observe(element)
		return () => observer.disconnect()
	}, [ref])

	return width
}

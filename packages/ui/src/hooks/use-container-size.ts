import * as React from "react"

export interface ContainerSize {
	width: number
	height: number
}

/**
 * Tracks the size of a container element using ResizeObserver.
 * On React Native, replace with an onLayout-based implementation.
 */
export function useContainerSize(ref: React.RefObject<HTMLElement | null>): ContainerSize {
	const [size, setSize] = React.useState<ContainerSize>({ width: 0, height: 0 })

	React.useEffect(() => {
		const el = ref.current
		if (!el) return

		// Measure synchronously up front. ResizeObserver is specced to deliver an initial
		// callback, but that fire can be throttled (e.g. background tabs), which would leave
		// consumers stuck at 0 until the next real resize. Reading the box now avoids that.
		const rect = el.getBoundingClientRect()
		setSize({ width: rect.width, height: rect.height })

		const observer = new ResizeObserver((entries) => {
			for (const entry of entries) {
				setSize({
					width: entry.contentRect.width,
					height: entry.contentRect.height,
				})
			}
		})

		observer.observe(el)
		return () => observer.disconnect()
	}, [ref])

	return size
}

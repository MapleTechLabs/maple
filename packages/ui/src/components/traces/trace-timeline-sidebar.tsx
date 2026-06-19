import * as React from "react"

interface SidebarResizeHandleProps {
	/** Absolute x (px) of the sidebar/timeline boundary to sit on. */
	left: number
	onResize: (delta: number) => void
}

/**
 * Draggable divider on the sidebar/timeline boundary. Absolutely positioned at `left` within the
 * timeline body so it tracks the current sidebar width.
 */
export function SidebarResizeHandle({ left, onResize }: SidebarResizeHandleProps) {
	const startX = React.useRef<number | null>(null)

	const handleMouseDown = React.useCallback(
		(e: React.MouseEvent) => {
			startX.current = e.clientX
			e.preventDefault()

			const handleMove = (ev: MouseEvent) => {
				if (startX.current == null) return
				const delta = ev.clientX - startX.current
				startX.current = ev.clientX
				onResize(delta)
			}
			const handleUp = () => {
				startX.current = null
				window.removeEventListener("mousemove", handleMove)
				window.removeEventListener("mouseup", handleUp)
			}
			window.addEventListener("mousemove", handleMove)
			window.addEventListener("mouseup", handleUp)
		},
		[onResize],
	)

	return (
		<div
			role="separator"
			aria-orientation="vertical"
			className="absolute top-0 bottom-0 z-30 w-1 -ml-0.5 cursor-col-resize bg-transparent hover:bg-primary/30 transition-colors"
			style={{ left }}
			onMouseDown={handleMouseDown}
		/>
	)
}

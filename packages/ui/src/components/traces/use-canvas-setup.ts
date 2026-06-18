import * as React from "react"

interface CanvasSize {
	width: number
	height: number
	dpr: number
}

/**
 * Hooks a canvas element up to its CSS-pixel size, retina DPR, and resize observer.
 * Returns the current CSS size + dpr. Sets canvas.width/height to (cssDim * dpr) and
 * the style width/height to (cssDim + "px"); callers apply ctx.setTransform(dpr, ...)
 * in their draw routines.
 */
export function useCanvasSetup(
	canvasRef: React.RefObject<HTMLCanvasElement | null>,
	containerRef: React.RefObject<HTMLElement | null>,
): CanvasSize {
	const [size, setSize] = React.useState<CanvasSize>({ width: 0, height: 0, dpr: 1 })

	// Apply only the backing-store resolution (intrinsic width/height = cssDim * dpr).
	// We deliberately do NOT set canvas.style.width/height: the canvas display size is
	// pinned to the container by CSS (`size-full` → width/height:100%, see the canvas
	// elements in trace-timeline-canvas.tsx). Setting an explicit px width here would
	// override that and, whenever the measured size lagged the real container (stale
	// ResizeObserver, tab/panel mount, window resize), render the canvas wider than its
	// container — the horizontal overflow that let the whole timeline panel scroll
	// sideways into blank space. Keeping display sizing in CSS makes that structurally
	// impossible; a stale measurement can at worst momentarily soften resolution until
	// the next measure re-syncs the backing store.
	const applySize = React.useCallback(
		(cssW: number, cssH: number, dpr: number) => {
			const canvas = canvasRef.current
			if (!canvas) return
			const intrinsicW = Math.max(1, Math.floor(cssW * dpr))
			const intrinsicH = Math.max(1, Math.floor(cssH * dpr))
			if (canvas.width !== intrinsicW) canvas.width = intrinsicW
			if (canvas.height !== intrinsicH) canvas.height = intrinsicH
		},
		[canvasRef],
	)

	React.useEffect(() => {
		const el = containerRef.current
		if (!el) return

		const measure = () => {
			const rect = el.getBoundingClientRect()
			const dpr = window.devicePixelRatio || 1
			const cssW = rect.width
			const cssH = rect.height
			applySize(cssW, cssH, dpr)
			setSize((prev) =>
				prev.width === cssW && prev.height === cssH && prev.dpr === dpr
					? prev
					: { width: cssW, height: cssH, dpr },
			)
		}

		measure()
		const ro = new ResizeObserver(() => measure())
		ro.observe(el)

		// Listen for DPR changes (zoom in/out, monitor switch). Re-bind on each change.
		let media: MediaQueryList | null = null
		let mediaHandler: (() => void) | null = null
		const bindDprListener = () => {
			const dpr = window.devicePixelRatio || 1
			media = window.matchMedia(`(resolution: ${dpr}dppx)`)
			mediaHandler = () => {
				measure()
				if (media && mediaHandler) media.removeEventListener("change", mediaHandler)
				bindDprListener()
			}
			media.addEventListener("change", mediaHandler)
		}
		bindDprListener()

		return () => {
			ro.disconnect()
			if (media && mediaHandler) media.removeEventListener("change", mediaHandler)
		}
	}, [containerRef, applySize])

	return size
}

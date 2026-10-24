// The onboarding backdrop: square pixels lit in the primary colour through an 8x8 ordered dither,
// spreading from the bottom-left corner. `data-reach` on the canvas sets how far (it grows per step),
// slow waves move its edge, and reduced motion keeps it still.

const BAYER_8 = [
	0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20,
	62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37,
	63, 31, 55, 23, 61, 29, 53, 21,
].map((rank) => (rank + 0.5) / 64)

const CELL = 8
const PIXEL = 4
const FRAME_MS = 40
/** Above the dither threshold by this much a pixel takes the full colour, below it the dimmer shade. */
const BRIGHT_MARGIN = 0.45

/** The field's height at a point of the unit square (y grows down) at `seconds`, before dithering. */
export const fieldAt = (x: number, y: number, seconds: number, reach: number): number => {
	const dx = x - 0.08
	const dy = (y - 1.02) * 1.1
	const falloff = 1 - Math.sqrt(dx * dx + dy * dy) / reach
	const waves =
		0.16 * Math.sin(x * 4.2 + y * 2.6 - seconds * 0.35) +
		0.1 * Math.sin(x * 7.5 - y * 5.2 + seconds * 0.27) +
		0.07 * Math.sin((x + y) * 11 - seconds * 0.5)
	return falloff + waves
}

/** 0 unlit, 1 dim, 2 bright: one cell of the dithered field. */
export const ditherLevel = (column: number, row: number, value: number): 0 | 1 | 2 => {
	const threshold = BAYER_8[(row % 8) * 8 + (column % 8)] ?? 0.5
	if (value <= threshold) return 0
	return value > threshold + BRIGHT_MARGIN ? 2 : 1
}

const readReach = (canvas: HTMLCanvasElement): number => {
	const parsed = Number.parseFloat(canvas.dataset.reach ?? "")
	return Number.isFinite(parsed) ? parsed : 0.55
}

/** Starts drawing into `canvas`; the returned function stops it. */
export const startDitherField = (canvas: HTMLCanvasElement): (() => void) => {
	const context = canvas.getContext("2d")
	if (context === null) return () => undefined
	const isStill = window.matchMedia("(prefers-reduced-motion: reduce)").matches
	const color = getComputedStyle(canvas).getPropertyValue("--primary").trim() || "#e8872a"
	const state = { frame: 0, last: 0, seconds: 0, reach: readReach(canvas), width: 0, height: 0 }

	const resize = () => {
		const ratio = window.devicePixelRatio || 1
		state.width = canvas.clientWidth
		state.height = canvas.clientHeight
		canvas.width = Math.round(state.width * ratio)
		canvas.height = Math.round(state.height * ratio)
		context.setTransform(ratio, 0, 0, ratio, 0, 0)
	}

	const draw = () => {
		const columns = Math.ceil(state.width / CELL)
		const rows = Math.ceil(state.height / CELL)
		context.clearRect(0, 0, state.width, state.height)
		context.fillStyle = color
		Array.from({ length: rows }, (_, row) =>
			Array.from({ length: columns }, (_, column) => {
				const level = ditherLevel(
					column,
					row,
					fieldAt(column / columns, row / rows, state.seconds, state.reach),
				)
				if (level === 0) return
				context.globalAlpha = level === 2 ? 1 : 0.55
				context.fillRect(column * CELL, row * CELL, PIXEL, PIXEL)
			}),
		)
		context.globalAlpha = 1
	}

	const tick = (now: number) => {
		state.frame = requestAnimationFrame(tick)
		if (document.hidden || now - state.last < FRAME_MS) return
		const elapsed = state.last === 0 ? 0 : now - state.last
		state.last = now
		const target = readReach(canvas)
		const isSettled = Math.abs(target - state.reach) < 0.002
		if (isStill && isSettled && state.seconds > 0) return
		state.reach += (target - state.reach) * 0.08
		if (!isStill) state.seconds += elapsed / 1000
		// A still field still needs one frame; `seconds` > 0 marks it drawn.
		if (isStill) state.seconds = Math.max(state.seconds, Number.MIN_VALUE)
		draw()
	}

	const observer = new ResizeObserver(() => {
		resize()
		draw()
	})
	observer.observe(canvas)
	resize()
	state.frame = requestAnimationFrame(tick)
	return () => {
		cancelAnimationFrame(state.frame)
		observer.disconnect()
	}
}

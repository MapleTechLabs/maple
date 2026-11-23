import { area, curveLinear, curveMonotoneX, line } from "d3-shape"
import { Array as Arr, Record } from "effect"

// The sparkline as one small SVG that owns its hover motion, after bklit's sparkline: the crosshair
// and dot spring between points, the series fades while a clipped band around the hovered point
// stays bright, the area wipes in once and morphs on new data. Imported lazily by `MountSparkline`.

export interface SparkData {
	readonly values: ReadonlyArray<number>
	readonly color: string
	readonly curve: "linear" | "monotone"
	readonly fillStart: number
	readonly fillEnd: number
	readonly animatesEntrance: boolean
}

interface SparkPoint {
	readonly x: number
	readonly y: number
}

interface SparkLayout {
	readonly points: ReadonlyArray<SparkPoint>
	readonly baselineY: number
}

interface Spring {
	value: number
	velocity: number
	target: number
}

const SVG_NS = "http://www.w3.org/2000/svg"
const PADDING = { top: 4, right: 3, bottom: 2, left: 3 }
const STROKE_WIDTH = 1.5
const INACTIVE_OPACITY = 0.5
const HOVER_FADE = "opacity 400ms ease-in-out"
/** The crosshair and dot (bklit's tooltip spring) and the highlight band. */
const HOVER_SPRING = { stiffness: 300, damping: 30 }
const BAND_SPRING = { stiffness: 180, damping: 28 }
const ENTER_MS = 900
const MORPH_MS = 500
const EASING = [0.85, 0, 0.15, 1] as const
const SETTLED = 0.01
/** The bright band never narrows below this, so a dense series in a small cell still shows it. */
const MIN_BAND_WIDTH = 12

const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches

/** `cubic-bezier(x1, y1, x2, y2)` at progress `t`, solved for x by bisection. */
const cubicBezier = ([x1, y1, x2, y2]: readonly [number, number, number, number], t: number) => {
	const at = (a: number, b: number, s: number) =>
		3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3
	const solve = (low: number, high: number, depth: number): number => {
		const mid = (low + high) / 2
		if (depth === 0) return mid
		return at(x1, x2, mid) < t ? solve(mid, high, depth - 1) : solve(low, mid, depth - 1)
	}
	return at(y1, y2, solve(0, 1, 20))
}

/**
 * From zero (or the lowest negative value) to the highest, so the area reads as an amount and a
 * series that stays at zero lies on the baseline rather than across the cell.
 */
const domainOf = (values: ReadonlyArray<number>): readonly [number, number] => {
	const finite = Arr.filter(values, Number.isFinite)
	const min = Math.min(0, ...finite)
	const max = Math.max(0, ...finite)
	return min === max ? [min, min + 1] : [min, max]
}

const layoutOf = (values: ReadonlyArray<number>, width: number, height: number): SparkLayout => {
	const [d0, d1] = domainOf(values)
	const innerWidth = Math.max(0, width - PADDING.left - PADDING.right)
	const innerHeight = Math.max(0, height - PADDING.top - PADDING.bottom)
	const yOf = (value: number) => PADDING.top + innerHeight - ((value - d0) / (d1 - d0)) * innerHeight
	const step = values.length > 1 ? innerWidth / (values.length - 1) : 0
	return {
		points: Arr.map(values, (value, index) => ({
			x: PADDING.left + (values.length > 1 ? step * index : innerWidth / 2),
			y: Number.isFinite(value) ? yOf(value) : Number.NaN,
		})),
		baselineY: yOf(Math.min(Math.max(0, d0), d1)),
	}
}

const lerpLayout = (from: SparkLayout, to: SparkLayout, t: number): SparkLayout => ({
	points: Arr.map(to.points, (point, index) => {
		const start = from.points[index]?.y ?? point.y
		return { x: point.x, y: start + (point.y - start) * t }
	}),
	baselineY: from.baselineY + (to.baselineY - from.baselineY) * t,
})

const svgElement = <K extends keyof SVGElementTagNameMap>(
	tag: K,
	attributes: Record<string, string | number>,
): SVGElementTagNameMap[K] => {
	const element = document.createElementNS(SVG_NS, tag)
	Arr.forEach(Record.toEntries(attributes), ([name, value]) => element.setAttribute(name, String(value)))
	return element
}

/** One spring step (semi-implicit Euler at unit mass); true once it has settled on its target. */
const stepSpring = (
	spring: Spring,
	config: { readonly stiffness: number; readonly damping: number },
	dt: number,
) => {
	const force = -config.stiffness * (spring.value - spring.target) - config.damping * spring.velocity
	spring.velocity += force * dt
	spring.value += spring.velocity * dt
	const settled = Math.abs(spring.value - spring.target) < SETTLED && Math.abs(spring.velocity) < SETTLED
	if (settled) {
		spring.value = spring.target
		spring.velocity = 0
	}
	return settled
}

const jump = (spring: Spring, value: number) => {
	spring.value = value
	spring.target = value
	spring.velocity = 0
}

let nextId = 0

interface SparkState {
	data: SparkData
	width: number
	height: number
	/** The layout drawn once a morph settles, and the one on screen now. */
	target: SparkLayout | null
	shown: SparkLayout | null
	hoverIndex: number | null
	entered: boolean
	morph: number
	springFrame: number
	lastTime: number
	/** Where the pointer last was, so a redraw under a still pointer re-picks its point. */
	pointerX: number | null
}

export interface SparkSvg {
	readonly update: (data: SparkData) => void
	readonly destroy: () => void
}

/** `onHover` hears the hovered point's index, and `null` when the pointer leaves. */
export const createSparkSvg = (
	root: HTMLElement,
	initial: SparkData,
	onHover: (index: number | null) => void,
): SparkSvg => {
	nextId += 1
	const id = `spark-svg-${nextId}`
	const svg = svgElement("svg", { width: "100%", height: "100%", "aria-hidden": "true" })
	svg.style.display = "block"
	svg.style.overflow = "visible"
	svg.style.touchAction = "pan-y"

	const gradient = svgElement("linearGradient", { id: `${id}-fill`, x1: 0, y1: 0, x2: 0, y2: 1 })
	const stopTop = svgElement("stop", { offset: 0 })
	const stopBottom = svgElement("stop", { offset: 1 })
	gradient.append(stopTop, stopBottom)
	const clip = svgElement("clipPath", { id: `${id}-band` })
	const band = svgElement("rect", { y: -STROKE_WIDTH, height: 0, width: 0 })
	clip.append(band)
	const defs = svgElement("defs", {})
	defs.append(gradient, clip)

	const series = svgElement("g", {})
	series.style.transition = HOVER_FADE
	const areaPath = svgElement("path", { fill: `url(#${id}-fill)` })
	const linePath = svgElement("path", {
		fill: "none",
		"stroke-width": STROKE_WIDTH,
		"stroke-linecap": "round",
		"stroke-linejoin": "round",
	})
	series.append(areaPath, linePath)

	const highlight = svgElement("path", {
		fill: "none",
		"stroke-width": STROKE_WIDTH,
		"stroke-linecap": "round",
		"stroke-linejoin": "round",
		"clip-path": `url(#${id}-band)`,
		"pointer-events": "none",
	})
	highlight.style.opacity = "0"
	highlight.style.transition = HOVER_FADE

	const crosshair = svgElement("line", {
		x1: 0,
		x2: 0,
		stroke: "var(--muted-foreground)",
		"stroke-opacity": 0.55,
		"stroke-width": 1,
		"stroke-dasharray": "2 2",
		"pointer-events": "none",
	})
	const dot = svgElement("circle", {
		r: 3,
		stroke: "var(--background)",
		"stroke-width": 1.5,
		"pointer-events": "none",
	})
	const hoverMarks = svgElement("g", {})
	hoverMarks.style.display = "none"
	hoverMarks.append(crosshair, dot)

	svg.append(defs, series, highlight, hoverMarks)
	root.append(svg)

	const state: SparkState = {
		data: initial,
		width: 0,
		height: 0,
		target: null,
		shown: null,
		hoverIndex: null,
		entered: false,
		morph: 0,
		springFrame: 0,
		lastTime: 0,
		pointerX: null,
	}
	const springs = {
		x: { value: 0, velocity: 0, target: 0 },
		y: { value: 0, velocity: 0, target: 0 },
		bandX: { value: 0, velocity: 0, target: 0 },
		bandWidth: { value: 0, velocity: 0, target: 0 },
	}

	const pathsOf = (layout: SparkLayout) => {
		const curve = state.data.curve === "monotone" ? curveMonotoneX : curveLinear
		const defined = (point: SparkPoint) => Number.isFinite(point.y)
		const linePathOf = line<SparkPoint>()
			.x((point) => point.x)
			.y((point) => point.y)
			.defined(defined)
			.curve(curve)
		const areaPathOf = area<SparkPoint>()
			.x((point) => point.x)
			.y0(layout.baselineY)
			.y1((point) => point.y)
			.defined(defined)
			.curve(curve)
		return { line: linePathOf([...layout.points]) ?? "", area: areaPathOf([...layout.points]) ?? "" }
	}

	const paint = (layout: SparkLayout) => {
		state.shown = layout
		const paths = pathsOf(layout)
		linePath.setAttribute("d", paths.line)
		highlight.setAttribute("d", paths.line)
		areaPath.setAttribute("d", paths.area)
	}

	const paintColors = () => {
		const { color, fillStart, fillEnd } = state.data
		stopTop.setAttribute("stop-color", color)
		stopTop.setAttribute("stop-opacity", String(fillStart))
		stopBottom.setAttribute("stop-color", color)
		stopBottom.setAttribute("stop-opacity", String(fillEnd))
		linePath.setAttribute("stroke", color)
		highlight.setAttribute("stroke", color)
		dot.setAttribute("fill", color)
	}

	const paintHoverMarks = () => {
		hoverMarks.setAttribute("transform", `translate(${springs.x.value} 0)`)
		dot.setAttribute("cy", String(springs.y.value))
		band.setAttribute("x", String(springs.bandX.value))
		band.setAttribute("width", String(Math.max(0, springs.bandWidth.value)))
	}

	const tickSprings = (time: number) => {
		const dt = Math.min(1 / 30, state.lastTime === 0 ? 1 / 60 : (time - state.lastTime) / 1000)
		state.lastTime = time
		// Fixed substeps keep a stiff spring stable on a slow frame.
		const steps = Math.max(1, Math.ceil(dt / (1 / 240)))
		const results = Arr.map(Arr.range(1, steps), () =>
			Arr.every(
				[
					stepSpring(springs.x, HOVER_SPRING, dt / steps),
					stepSpring(springs.y, HOVER_SPRING, dt / steps),
					stepSpring(springs.bandX, BAND_SPRING, dt / steps),
					stepSpring(springs.bandWidth, BAND_SPRING, dt / steps),
				],
				(done) => done,
			),
		)
		const settled = results.at(-1) ?? true
		paintHoverMarks()
		state.springFrame = settled ? 0 : requestAnimationFrame(tickSprings)
	}

	const startSprings = () => {
		if (state.springFrame !== 0) return
		state.lastTime = 0
		state.springFrame = requestAnimationFrame(tickSprings)
	}

	const showHover = (index: number | null) => {
		const layout = state.target
		const point = index === null || layout === null ? undefined : layout.points[index]
		if (point === undefined || layout === null || index === null) {
			if (state.hoverIndex !== null) onHover(null)
			state.hoverIndex = null
			series.style.opacity = "1"
			highlight.style.opacity = "0"
			hoverMarks.style.display = "none"
			return
		}
		const first = state.hoverIndex === null
		if (state.hoverIndex !== index) onHover(index)
		state.hoverIndex = index
		const neighbourStart = layout.points[Math.max(0, index - 1)]?.x ?? point.x
		const neighbourEnd = layout.points[Math.min(layout.points.length - 1, index + 1)]?.x ?? point.x
		const bandStart = Math.min(neighbourStart, point.x - MIN_BAND_WIDTH / 2)
		const bandEnd = Math.max(neighbourEnd, point.x + MIN_BAND_WIDTH / 2)
		const y = Number.isFinite(point.y) ? point.y : layout.baselineY
		dot.style.display = Number.isFinite(point.y) ? "" : "none"
		series.style.opacity = String(INACTIVE_OPACITY)
		highlight.style.opacity = "1"
		hoverMarks.style.display = ""
		// Bleeds by the stroke width so strokes at the min and max keep their full width.
		band.setAttribute("height", String(state.height + STROKE_WIDTH * 2))
		crosshair.setAttribute("y1", String(PADDING.top / 2))
		crosshair.setAttribute("y2", String(state.height - PADDING.bottom / 2))
		if (first || prefersReducedMotion()) {
			// The springs start at the first hovered point rather than sliding in.
			jump(springs.x, point.x)
			jump(springs.y, y)
			jump(springs.bandX, bandStart)
			jump(springs.bandWidth, bandEnd - bandStart)
			paintHoverMarks()
			return
		}
		springs.x.target = point.x
		springs.y.target = y
		springs.bandX.target = bandStart
		springs.bandWidth.target = bandEnd - bandStart
		startSprings()
	}

	const indexAt = (clientX: number) => {
		const count = state.data.values.length
		const innerWidth = state.width - PADDING.left - PADDING.right
		if (count === 0 || innerWidth <= 0) return null
		const x = clientX - svg.getBoundingClientRect().left
		const t = (x - PADDING.left) / innerWidth
		return Math.min(count - 1, Math.max(0, Math.round(t * (count - 1))))
	}

	const onPointerMove = (event: PointerEvent) => {
		state.pointerX = event.clientX
		const index = indexAt(event.clientX)
		if (index !== state.hoverIndex) showHover(index)
	}
	const onPointerLeave = () => {
		state.pointerX = null
		showHover(null)
	}
	svg.addEventListener("pointermove", onPointerMove)
	svg.addEventListener("pointerleave", onPointerLeave)

	const morphTo = (from: SparkLayout, to: SparkLayout) => {
		cancelAnimationFrame(state.morph)
		const start = performance.now()
		const frame = (time: number) => {
			const t = Math.min(1, (time - start) / MORPH_MS)
			paint(lerpLayout(from, to, cubicBezier(EASING, t)))
			state.morph = t < 1 ? requestAnimationFrame(frame) : 0
		}
		state.morph = requestAnimationFrame(frame)
	}

	const enter = () => {
		if (typeof series.animate !== "function") return
		if (prefersReducedMotion()) {
			series.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: "ease-out" })
			return
		}
		series.animate([{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0% 0 0)" }], {
			duration: ENTER_MS,
			easing: `cubic-bezier(${Arr.join(Arr.map(EASING, String), ", ")})`,
		})
	}

	const render = (reason: "data" | "resize") => {
		if (state.width <= 0 || state.height <= 0) return
		const next = layoutOf(state.data.values, state.width, state.height)
		const from = state.shown
		state.target = next
		const morph =
			reason === "data" &&
			from !== null &&
			from.points.length === next.points.length &&
			!prefersReducedMotion()
		if (morph) morphTo(from, next)
		else {
			cancelAnimationFrame(state.morph)
			paint(next)
		}
		if (!state.entered) {
			state.entered = true
			if (state.data.animatesEntrance) enter()
		}
		// New data or a new size moves the points: re-pick the one under a pointer still over the
		// sparkline, including when data returns after an empty series cleared the hover.
		if (state.pointerX !== null) showHover(indexAt(state.pointerX))
	}

	const resizeObserver = new ResizeObserver((entries) => {
		const box = entries[0]?.contentRect
		const width = Math.round(box?.width ?? 0)
		const height = Math.round(box?.height ?? 0)
		if (width === state.width && height === state.height) return
		state.width = width
		state.height = height
		render("resize")
	})
	resizeObserver.observe(root)
	paintColors()

	return {
		update: (data) => {
			state.data = data
			paintColors()
			render("data")
		},
		destroy: () => {
			// A sparkline torn down under the pointer still reports the leave, so no page keeps its point.
			if (state.hoverIndex !== null) onHover(null)
			resizeObserver.disconnect()
			cancelAnimationFrame(state.morph)
			cancelAnimationFrame(state.springFrame)
			svg.removeEventListener("pointermove", onPointerMove)
			svg.removeEventListener("pointerleave", onPointerLeave)
			svg.remove()
		},
	}
}

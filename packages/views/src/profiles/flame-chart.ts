import { getSpanColorStyle } from "@maple/ui/lib/colors"
import { nonZeroOr } from "@maple/ui/lib/number"
import { Array as Arr, String as Str } from "effect"
import {
	type FlameLayout,
	type FlameNode,
	type FlameViewport,
	flameNodeAt,
	FULL_VIEWPORT,
	isZoomed,
	layoutFlame,
	neighbour,
	panViewport,
	rulerStep,
	startFrame,
	toAxis,
	toPixel,
	viewForNewRoot,
	viewportOf,
	zoomAnchor,
	zoomViewport,
} from "./flame-geometry"
import { frameModule, matchesSearch, type ProfileNode } from "./profile-tree"

// The flame chart itself: two canvases (an overview of the whole profile, and the zoomable chart)
// and the gestures over them. Zoom, pan, scroll and hover change many times a second, so they
// live here and never pass through the page's update loop; only a selection and "is it zoomed"
// are reported back. Navigation follows Chrome's performance panel.

export interface FlameChartProps {
	readonly root: ProfileNode
	/** What the tree is a view of. A new root under the same key is a refetch and keeps the zoom. */
	readonly viewKey: string
	readonly search: string
	readonly selectedId: string | null
	/** A new value asks for the whole profile again. */
	readonly resetToken: number
	readonly formatValue: (value: number) => string
}

export interface FlameChartCallbacks {
	readonly onSelect: (nodeId: string | null) => void
	readonly onZoomChange: (isZoomed: boolean) => void
}

export interface FlameChart {
	readonly update: (props: FlameChartProps) => void
	readonly destroy: () => void
}

const ROW_PITCH = 18
const ROW_HEIGHT = ROW_PITCH - 1
const RULER_HEIGHT = 20
const OVERVIEW_HEIGHT = 36
const FONT_SIZE = 11
const LABEL_PADDING = 5
/** A frame narrower than this carries no label. */
const LABEL_MIN_WIDTH = 28
/** A drag shorter than this is a click. */
const DRAG_THRESHOLD = 4
const ZOOM_STEP = 0.6
const PAN_STEP = 0.25
const ANIMATION_MS = 160

const TOOLTIP_CLASS =
	"pointer-events-none absolute z-20 hidden max-w-md rounded-md border bg-popover px-2 py-1.5 font-sans text-xs text-popover-foreground"

interface Palette {
	readonly foreground: string
	readonly muted: string
	readonly border: string
	readonly background: string
	readonly primary: string
	readonly font: string
}

const readPalette = (element: HTMLElement): Palette => {
	const style = getComputedStyle(element)
	const token = (name: string, fallback: string): string =>
		Str.trim(style.getPropertyValue(name)) || fallback
	return {
		foreground: token("--foreground", "CanvasText"),
		muted: token("--muted-foreground", "GrayText"),
		border: token("--border", "GrayText"),
		background: token("--background", "Canvas"),
		primary: token("--primary", "Highlight"),
		font: `${FONT_SIZE}px ${style.fontFamily}`,
	}
}

const frameColours = new WeakMap<ProfileNode, { readonly fill: string; readonly text: string }>()
const colourOf = (node: ProfileNode) => {
	const cached = frameColours.get(node)
	if (cached !== undefined) return cached
	const style = getSpanColorStyle(node.name, frameModule(node.file))
	const colour = { fill: style.backgroundColor, text: style.color }
	frameColours.set(node, colour)
	return colour
}

const sourceOf = (node: ProfileNode): string =>
	node.file === "" ? "" : node.line > 0 ? `${node.file}:${node.line}` : node.file

const percent = (share: number): string =>
	`${share >= 0.1 ? (share * 100).toFixed(0) : (share * 100).toFixed(share >= 0.01 ? 1 : 2)}%`

export const createFlameChart = (
	surface: HTMLElement,
	options: { readonly maxRows: number },
	callbacks: FlameChartCallbacks,
): FlameChart => {
	surface.tabIndex = 0
	const overview = document.createElement("canvas")
	const main = document.createElement("canvas")
	const tooltip = document.createElement("div")
	const tooltipName = document.createElement("div")
	const tooltipBody = document.createElement("div")
	// A vertical touch drag scrolls the page; a horizontal one is the chart's to pan.
	overview.className = "block w-full cursor-crosshair touch-pan-y touch-pinch-zoom"
	overview.setAttribute("aria-hidden", "true")
	main.className = "block w-full cursor-grab touch-pan-y touch-pinch-zoom"
	main.setAttribute("role", "img")
	main.setAttribute("aria-label", "Flame chart")
	tooltip.className = TOOLTIP_CLASS
	tooltipName.className = "font-mono font-medium break-all"
	tooltipBody.className = "whitespace-pre-line text-muted-foreground"
	tooltip.append(tooltipName, tooltipBody)
	surface.append(overview, main, tooltip)

	let props: FlameChartProps | undefined
	let layout: FlameLayout | undefined
	let matches: ReadonlySet<string> = new Set()
	let selectedId: string | null = null
	let viewport: FlameViewport = FULL_VIEWPORT
	let scrollY = 0
	let hover: FlameNode | undefined
	/** The pointer's offset across the chart while it is over it: where a keyboard zoom anchors. */
	let pointerX: number | undefined
	let width = 0
	let viewHeight = 0
	let palette = readPalette(surface)
	let charWidth = 6.6
	let wasZoomed = false
	let pending = false
	let frameHandle = 0
	let timerHandle: ReturnType<typeof setTimeout> | undefined
	let animation: { from: FlameViewport; to: FlameViewport; startedAt: number } | undefined
	let drag:
		| {
				x: number
				y: number
				/** What the drag moves from: an overview press may have jumped the window first. */
				viewport: FlameViewport
				/** The view before the press, which a cancelled gesture goes back to. */
				before: FlameViewport
				scrollY: number
				moved: boolean
				onOverview: boolean
				isTouch: boolean
		  }
		| undefined

	const contentHeight = (): number => (layout?.rows ?? 0) * ROW_PITCH
	const maxScroll = (): number => Math.max(0, contentHeight() - viewHeight)
	const clampScroll = (value: number): number => Math.min(maxScroll(), Math.max(0, value))

	// --- drawing ---

	const resize = (): void => {
		width = surface.clientWidth
		viewHeight = Math.min(contentHeight(), options.maxRows * ROW_PITCH)
		const dpr = nonZeroOr(window.devicePixelRatio, 1)
		const mainHeight = RULER_HEIGHT + viewHeight
		main.width = Math.round(width * dpr)
		main.height = Math.round(mainHeight * dpr)
		main.style.height = `${mainHeight}px`
		overview.width = Math.round(width * dpr)
		overview.height = Math.round(OVERVIEW_HEIGHT * dpr)
		overview.style.height = `${OVERVIEW_HEIGHT}px`
		scrollY = clampScroll(scrollY)
	}

	const label = (name: string, available: number): string => {
		const fits = Math.floor((available - LABEL_PADDING * 2) / charWidth)
		if (fits >= name.length) return name
		// @effect-diagnostics-next-line preferEffectString:off -- per-frame draw path; the curried Str.slice allocates a closure per label
		return fits < 2 ? "" : `${name.slice(0, fits - 1)}…`
	}

	const drawOverview = (dpr: number): void => {
		const context = overview.getContext("2d")
		if (context === null || layout === undefined) return
		context.setTransform(dpr, 0, 0, dpr, 0, 0)
		context.clearRect(0, 0, width, OVERVIEW_HEIGHT)
		// Under a pixel for a deep profile, so its deepest rows still fit in the strip.
		const rowHeight = Math.min(4, (OVERVIEW_HEIGHT - 6) / layout.rows)
		const mini = (frame: FlameNode): void => {
			const frameWidth = (frame.x1 - frame.x0) * width
			if (frameWidth < 0.5) return
			context.fillStyle = colourOf(frame.node).fill
			context.fillRect(frame.x0 * width, 3 + frame.node.depth * rowHeight, frameWidth, rowHeight)
			for (const child of frame.children) mini(child)
		}
		mini(layout.root)
		if (isZoomed(viewport)) {
			const left = viewport.start * width
			const right = viewport.end * width
			context.fillStyle = palette.background
			context.globalAlpha = 0.7
			context.fillRect(0, 0, left, OVERVIEW_HEIGHT)
			context.fillRect(right, 0, width - right, OVERVIEW_HEIGHT)
			context.globalAlpha = 1
			context.strokeStyle = palette.primary
			context.lineWidth = 1.5
			context.strokeRect(left + 0.75, 0.75, Math.max(right - left - 1.5, 2), OVERVIEW_HEIGHT - 1.5)
		}
		context.fillStyle = palette.border
		context.fillRect(0, OVERVIEW_HEIGHT - 1, width, 1)
	}

	const rectOf = (frame: FlameNode): { x: number; y: number; w: number } | undefined => {
		const left = toPixel(viewport, frame.x0, width)
		const right = toPixel(viewport, frame.x1, width)
		if (right < 0 || left > width) return undefined
		const x = Math.max(left, -2)
		const w = Math.min(right, width + 2) - x
		return { x, y: RULER_HEIGHT + frame.node.depth * ROW_PITCH - scrollY, w }
	}

	const drawRuler = (context: CanvasRenderingContext2D, height: number): void => {
		if (props === undefined || layout === undefined) return
		const span = (viewport.end - viewport.start) * layout.root.node.total
		const step = rulerStep(span, Math.max(2, Math.floor(width / 120)))
		context.font = palette.font
		context.textBaseline = "middle"
		if (step > 0) {
			for (let value = 0; value <= span; value += step) {
				const x = Math.round((value / span) * width) + 0.5
				context.globalAlpha = 0.5
				context.fillStyle = palette.border
				context.fillRect(x, 0, 1, height)
				context.globalAlpha = 1
				const text = value === 0 ? "0" : props.formatValue(value)
				if (x + 4 + text.length * charWidth < width) {
					context.fillStyle = palette.muted
					context.fillText(text, x + 4, RULER_HEIGHT / 2)
				}
			}
		}
		context.fillStyle = palette.border
		context.fillRect(0, RULER_HEIGHT - 1, width, 1)
	}

	const draw = (): void => {
		if (layout === undefined || props === undefined || width === 0) return
		const dpr = nonZeroOr(window.devicePixelRatio, 1)
		const context = main.getContext("2d")
		if (context === null) return
		const height = RULER_HEIGHT + viewHeight
		context.setTransform(dpr, 0, 0, dpr, 0, 0)
		context.clearRect(0, 0, width, height)
		drawRuler(context, height)
		context.save()
		context.beginPath()
		context.rect(0, RULER_HEIGHT, width, viewHeight)
		context.clip()
		// The same test `matchesSearch` applies: a blank search matches nothing, so it dims nothing.
		const dims = Str.trim(props.search) !== ""
		const frame = (node: FlameNode): void => {
			const rect = rectOf(node)
			// Callees sit inside their caller, so nothing under an off-screen or sub-pixel frame shows.
			if (rect === undefined || rect.w < 0.5 || rect.y > height) return
			if (rect.y + ROW_PITCH > RULER_HEIGHT) {
				const colour = colourOf(node.node)
				// A 1px gutter between neighbours, as long as the frame can spare it.
				const w = rect.w > 2 ? rect.w - 1 : rect.w
				context.globalAlpha = dims && !matches.has(node.node.id) ? 0.22 : 1
				context.fillStyle = colour.fill
				context.fillRect(rect.x, rect.y, w, ROW_HEIGHT)
				if (node === hover) {
					context.globalAlpha = 0.18
					context.fillStyle = palette.foreground
					context.fillRect(rect.x, rect.y, w, ROW_HEIGHT)
					context.globalAlpha = 1
				}
				if (w > LABEL_MIN_WIDTH) {
					// A frame running off the left edge keeps its label in view.
					const textX = Math.max(rect.x, 0)
					const text = label(node.node.name, rect.x + w - textX)
					if (text !== "") {
						context.fillStyle = colour.text
						context.fillText(text, textX + LABEL_PADDING, rect.y + ROW_HEIGHT / 2 + 0.5)
					}
				}
				context.globalAlpha = 1
			}
			for (const child of node.children) frame(child)
		}
		frame(layout.root)
		const selected = selectedId === null ? undefined : layout.byId.get(selectedId)
		const outline = selected === undefined ? undefined : rectOf(selected)
		if (outline !== undefined) {
			context.strokeStyle = palette.foreground
			context.lineWidth = 1.5
			context.strokeRect(
				outline.x + 0.75,
				outline.y + 0.75,
				Math.max(outline.w - 2.5, 1),
				ROW_HEIGHT - 1.5,
			)
		}
		context.restore()
		drawOverview(dpr)
	}

	const schedule = (): void => {
		if (pending) return
		pending = true
		const run = (): void => {
			if (!pending) return
			pending = false
			cancelAnimationFrame(frameHandle)
			clearTimeout(timerHandle)
			step()
		}
		// A hidden or throttled tab stops delivering animation frames; the timer still draws.
		frameHandle = requestAnimationFrame(run)
		// @effect-diagnostics-next-line globalTimers:off -- imperative canvas code; the fallback for a throttled requestAnimationFrame
		timerHandle = setTimeout(run, 60)
	}

	const reportViewport = (): void => {
		surface.dataset.flameViewport = `${viewport.start.toFixed(6)},${viewport.end.toFixed(6)}`
		const zoomed = isZoomed(viewport)
		if (zoomed !== wasZoomed) {
			wasZoomed = zoomed
			callbacks.onZoomChange(zoomed)
		}
	}

	const setViewport = (next: FlameViewport): void => {
		viewport = next
		reportViewport()
		schedule()
	}

	function step(): void {
		if (animation !== undefined) {
			const t = Math.min(1, (performance.now() - animation.startedAt) / ANIMATION_MS)
			const eased = 1 - (1 - t) ** 3
			viewport = {
				start: animation.from.start + (animation.to.start - animation.from.start) * eased,
				end: animation.from.end + (animation.to.end - animation.from.end) * eased,
			}
			if (t >= 1) animation = undefined
			reportViewport()
			if (animation !== undefined) schedule()
		}
		draw()
	}

	const animateTo = (target: FlameViewport): void => {
		animation = { from: viewport, to: target, startedAt: performance.now() }
		schedule()
	}

	const jumpTo = (next: FlameViewport): void => {
		animation = undefined
		setViewport(next)
	}

	// --- pointing ---

	const point = (event: MouseEvent, canvas: HTMLCanvasElement): { x: number; y: number } => {
		const box = canvas.getBoundingClientRect()
		return { x: event.clientX - box.left, y: event.clientY - box.top }
	}

	const frameUnder = (event: MouseEvent): FlameNode | undefined => {
		if (layout === undefined) return undefined
		const { x, y } = point(event, main)
		pointerX = x
		if (y < RULER_HEIGHT) return undefined
		return flameNodeAt(
			layout,
			toAxis(viewport, x, width),
			Math.floor((y - RULER_HEIGHT + scrollY) / ROW_PITCH),
		)
	}

	const hideTooltip = (): void => {
		tooltip.classList.add("hidden")
	}

	const showTooltip = (frame: FlameNode, event: MouseEvent): void => {
		if (props === undefined || layout === undefined) return
		const { node } = frame
		const total = layout.root.node.total
		tooltipName.textContent = node.name
		tooltipBody.textContent = Arr.join(
			[
				...(sourceOf(node) === "" ? [] : [sourceOf(node)]),
				`${props.formatValue(node.total)} total, ${percent(total === 0 ? 0 : node.total / total)} of the profile`,
				`${props.formatValue(node.self)} in the function itself`,
			],
			"\n",
		)
		tooltip.classList.remove("hidden")
		const box = surface.getBoundingClientRect()
		const x = event.clientX - box.left
		const y = event.clientY - box.top
		tooltip.style.left = `${Math.max(4, Math.min(x + 14, width - tooltip.offsetWidth - 4))}px`
		tooltip.style.top = `${y + 18}px`
	}

	const select = (frame: FlameNode | undefined): void => {
		selectedId = frame?.node.id ?? null
		callbacks.onSelect(selectedId)
		schedule()
	}

	/** Brings a frame picked from the keyboard into the window and onto a visible row. */
	const reveal = (frame: FlameNode): void => {
		const centre = (frame.x0 + frame.x1) / 2
		if (centre < viewport.start || centre > viewport.end) {
			const span = viewport.end - viewport.start
			jumpTo(panViewport(viewport, centre - span / 2 - viewport.start))
		}
		const top = frame.node.depth * ROW_PITCH
		if (top < scrollY) scrollY = top
		else if (top + ROW_PITCH > scrollY + viewHeight) scrollY = clampScroll(top + ROW_PITCH - viewHeight)
	}

	const onPointerDown = (event: PointerEvent): void => {
		if (event.button !== 0) return
		surface.focus({ preventScroll: true })
		animation = undefined
		const onOverview = event.currentTarget === overview
		const at = point(event, onOverview ? overview : main)
		const isTouch = event.pointerType === "touch"
		drag = { x: at.x, y: at.y, viewport, before: viewport, scrollY, moved: false, onOverview, isTouch }
		if (event.currentTarget instanceof Element) event.currentTarget.setPointerCapture(event.pointerId)
		if (onOverview) {
			// A press outside the window starts a new one there; inside, it grabs the window.
			const x = at.x / width
			if (x < viewport.start || x > viewport.end || !isZoomed(viewport)) {
				const span = isZoomed(viewport) ? viewport.end - viewport.start : 0.2
				drag.viewport = panViewport({ start: 0, end: span }, x - span / 2)
				jumpTo(drag.viewport)
			}
		}
	}

	const onPointerMove = (event: PointerEvent): void => {
		if (drag === undefined) {
			if (event.currentTarget !== main) return
			const next = frameUnder(event)
			if (next !== hover) {
				hover = next
				schedule()
			}
			if (next === undefined) hideTooltip()
			else showTooltip(next, event)
			return
		}
		const at = point(event, drag.onOverview ? overview : main)
		const dx = at.x - drag.x
		const dy = at.y - drag.y
		if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
		drag.moved = true
		hideTooltip()
		if (drag.onOverview) {
			jumpTo(panViewport(drag.viewport, dx / width))
			return
		}
		main.style.cursor = "grabbing"
		pointerX = at.x
		const span = drag.viewport.end - drag.viewport.start
		// A finger's vertical movement belongs to the page.
		if (!drag.isTouch) scrollY = clampScroll(drag.scrollY - dy)
		jumpTo(panViewport(drag.viewport, (-dx / width) * span))
	}

	const onPointerUp = (event: PointerEvent): void => {
		const ended = drag
		drag = undefined
		main.style.cursor = ""
		if (ended === undefined || ended.moved || ended.onOverview) return
		select(frameUnder(event))
	}

	// The browser took the gesture over (a vertical touch scroll): nothing was picked, and what
	// the drag had moved goes back.
	const onPointerCancel = (): void => {
		const ended = drag
		drag = undefined
		main.style.cursor = ""
		// An overview press moves the window before any drag does.
		if (ended === undefined || (!ended.moved && !ended.onOverview)) return
		scrollY = ended.scrollY
		jumpTo(ended.before)
	}

	const onPointerLeave = (): void => {
		pointerX = undefined
		if (hover !== undefined) {
			hover = undefined
			schedule()
		}
		hideTooltip()
	}

	const onDoubleClick = (event: MouseEvent): void => {
		const frame = frameUnder(event)
		if (frame !== undefined) animateTo(viewportOf(frame))
	}

	const onWheel = (event: WheelEvent): void => {
		const { x } = point(event, main)
		// A trackpad pinch arrives as a wheel with ctrl held.
		if (event.ctrlKey || event.metaKey) {
			event.preventDefault()
			const factor = Math.exp(Math.max(-60, Math.min(60, event.deltaY)) * 0.012)
			jumpTo(zoomViewport(viewport, toAxis(viewport, x, width), factor))
			hideTooltip()
			return
		}
		const horizontal = event.shiftKey ? event.deltaY : event.deltaX
		if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
			if (!isZoomed(viewport)) return
			event.preventDefault()
			jumpTo(panViewport(viewport, (horizontal / width) * (viewport.end - viewport.start)))
			hideTooltip()
			return
		}
		// A plain scroll moves the rows while there are rows to move, and the page after that.
		const next = clampScroll(scrollY + event.deltaY)
		if (next === scrollY) return
		event.preventDefault()
		scrollY = next
		hideTooltip()
		schedule()
	}

	const onKeyDown = (event: KeyboardEvent): void => {
		const current = layout
		if (current === undefined || event.ctrlKey || event.metaKey || event.altKey) return
		const span = viewport.end - viewport.start
		const anchor = zoomAnchor(viewport, pointerX, width)
		const selected = selectedId === null ? undefined : current.byId.get(selectedId)
		// With nothing selected an arrow starts a selection. At the tree's edge it stays put, and
		// is still the chart's key: the page must not scroll or move a list instead.
		const move = (direction: "up" | "down" | "left" | "right"): true => {
			const next = selected === undefined ? startFrame(current) : neighbour(selected, direction)
			if (next === undefined) return true
			reveal(next)
			select(next)
			return true
		}
		const key = event.key.length === 1 ? Str.toLowerCase(event.key) : event.key
		const handled = ((): boolean => {
			switch (key) {
				case "w":
				case "+":
				case "=":
					animateTo(zoomViewport(viewport, anchor, ZOOM_STEP))
					return true
				case "s":
				case "-":
					animateTo(zoomViewport(viewport, anchor, 1 / ZOOM_STEP))
					return true
				case "a":
					animateTo(panViewport(viewport, -span * PAN_STEP))
					return true
				case "d":
					animateTo(panViewport(viewport, span * PAN_STEP))
					return true
				case "ArrowLeft":
					return move("left")
				case "ArrowRight":
					return move("right")
				case "ArrowUp":
					return move("up")
				case "ArrowDown":
					return move("down")
				case "Enter":
					if (selected === undefined) return false
					animateTo(viewportOf(selected))
					return true
				case "0":
				case "Escape":
					if (isZoomed(viewport)) {
						animateTo(FULL_VIEWPORT)
						return true
					}
					if (selectedId === null) return false
					select(undefined)
					return true
				default:
					return false
			}
		})()
		// A key the chart used is not also the page's: Escape must not close the panel around it.
		if (handled) {
			event.preventDefault()
			event.stopPropagation()
		}
	}

	main.addEventListener("pointerdown", onPointerDown)
	main.addEventListener("pointermove", onPointerMove)
	main.addEventListener("pointerup", onPointerUp)
	main.addEventListener("pointercancel", onPointerCancel)
	main.addEventListener("pointerleave", onPointerLeave)
	main.addEventListener("dblclick", onDoubleClick)
	main.addEventListener("wheel", onWheel, { passive: false })
	overview.addEventListener("pointerdown", onPointerDown)
	overview.addEventListener("pointermove", onPointerMove)
	overview.addEventListener("pointerup", onPointerUp)
	overview.addEventListener("pointercancel", onPointerCancel)
	surface.addEventListener("keydown", onKeyDown)

	/** The picture's name for assistive technology: what it shows and the frame picked in it. */
	const describe = (): string => {
		if (props === undefined || layout === undefined) return "Flame chart"
		const total = layout.root.node.total
		const selected = selectedId === null ? undefined : layout.byId.get(selectedId)
		const chart = `Flame chart of ${props.formatValue(total)}`
		if (selected === undefined) return `${chart}, no frame selected`
		const { node } = selected
		return `${chart}. Selected ${node.name}: ${props.formatValue(node.total)}, ${percent(total === 0 ? 0 : node.total / total)} of the profile`
	}

	const measureFont = (): void => {
		const context = main.getContext("2d")
		if (context === null) return
		context.font = palette.font
		charWidth = nonZeroOr(context.measureText("0000000000").width / 10, charWidth)
	}

	const sizeObserver = new ResizeObserver(() => {
		resize()
		draw()
	})
	sizeObserver.observe(surface)
	// Light and dark swap the tokens the canvas was painted with.
	const themeObserver = new MutationObserver(() => {
		palette = readPalette(surface)
		measureFont()
		schedule()
	})
	themeObserver.observe(document.documentElement, {
		attributes: true,
		attributeFilter: ["class", "data-theme"],
	})
	measureFont()

	return {
		update: (next) => {
			const previous = props
			props = next
			selectedId = next.selectedId
			const isNewRoot = previous?.root !== next.root
			if (isNewRoot) {
				const isSameView = previous?.viewKey === next.viewKey
				// A refetch that lands mid-animation keeps the window the animation was heading for.
				const heading = animation?.to ?? viewport
				layout = layoutFlame(next.root)
				animation = undefined
				hover = undefined
				if (!isSameView) drag = undefined
				hideTooltip()
				resize()
				const view = viewForNewRoot({ viewport: heading, scrollY }, isSameView, maxScroll())
				viewport = view.viewport
				scrollY = view.scrollY
				reportViewport()
			}
			if (previous === undefined) {
				// A new chart says once where it stands: the page may remember an earlier chart's zoom.
				wasZoomed = isZoomed(viewport)
				callbacks.onZoomChange(wasZoomed)
			} else if (previous.resetToken !== next.resetToken) animateTo(FULL_VIEWPORT)
			main.setAttribute("aria-label", describe())
			if (layout !== undefined && (isNewRoot || previous?.search !== next.search)) {
				const found = new Set<string>()
				if (next.search !== "")
					for (const frame of layout.byId.values())
						if (matchesSearch(frame.node, next.search)) found.add(frame.node.id)
				matches = found
			}
			schedule()
		},
		destroy: () => {
			pending = false
			cancelAnimationFrame(frameHandle)
			clearTimeout(timerHandle)
			sizeObserver.disconnect()
			themeObserver.disconnect()
			surface.removeEventListener("keydown", onKeyDown)
			surface.replaceChildren()
		},
	}
}

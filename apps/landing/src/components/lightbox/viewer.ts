import * as M from "./math"

/**
 * The viewer's gestures on its mounted DOM: the scroll-snap track, zoom and pan, pull to dismiss.
 * Frames are written straight to the elements; the island only hears what changes its Model.
 * Ported from ramka's React lightbox (MIT, Copyright (c) 2026 Artur Bień): see ./LICENSE-ramka.
 */

export const PART = {
	content: "data-lightbox-content",
	slides: "data-lightbox-slides",
	slide: "data-lightbox-slide",
	zoom: "data-lightbox-zoom",
	media: "data-lightbox-media",
} as const

const STATE = {
	pulling: "data-pulling",
	pullDismissing: "data-pull-dismissing",
} as const

const VAR = {
	pullProgress: "--lightbox-pull-progress",
	pullSnapDuration: "--lightbox-pull-snap-duration",
	pullSnapEasing: "--lightbox-pull-snap-easing",
} as const

export type ViewerEvent =
	| Readonly<{ _tag: "Slide"; index: number }>
	| Readonly<{ _tag: "Zoom"; isZoomed: boolean; canZoomIn: boolean }>
	| Readonly<{ _tag: "Dismiss" }>

export type Viewer = Readonly<{
	/** Jumps to a slide. Dropped while a swipe is still in flight. */
	goTo: (index: number) => void
	zoomBy: (step: "in" | "out" | "reset") => void
	/** Moves the view over a zoomed shot by this many pixels. */
	panBy: (dx: number, dy: number) => void
	dispose: () => void
}>

const viewers = new WeakMap<Element, Viewer>()

/** The viewer attached to a content element, for Commands that steer it. */
export const viewerOf = (content: Element | null): Viewer | undefined =>
	content === null ? undefined : viewers.get(content)

const SETTLE = "cubic-bezier(0.22, 1, 0.36, 1)"
const STEP_MS = 300
const SETTLE_MS = 320
const COAST_MS = 520
const KEY_PAN_MS = 160
const TAP_SLOP_PX = 10
const DOUBLE_TAP_MS = 300
const DOUBLE_TAP_PX = 50
const VELOCITY_WINDOW_MS = 100
const VELOCITY_SAMPLES = 5
const SCROLL_IDLE_MS = 140
const WHEEL_GAP_MS = 90
const WHEEL_PULL_EVENTS = 3
const PINCH_ELASTICITY = 0.2
const IDENTITY = "matrix(1, 0, 0, 1, 0, 0)"

type Mode = "idle" | "tap" | "await-axis" | "pull" | "pan" | "pinch"

/** One run of wheel events: its axis is decided by the first, and a dismissal spends it. */
type WheelGesture = { axis: "x" | "y"; y: number; events: number; isSpent: boolean; at: number }

const elastic = (value: number, min: number, max: number): number =>
	value < min
		? min - (min - value) * PINCH_ELASTICITY
		: value > max
			? max + (value - max) * PINCH_ELASTICITY
			: value

const isReducedMotion = (): boolean =>
	typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches

const hasLinearEasing = (): boolean =>
	typeof CSS !== "undefined" && CSS.supports("transition-timing-function", "linear(0, 1)")

export const attachViewer = (content: HTMLElement, emit: (event: ViewerEvent) => void): Viewer => {
	const root = content.parentElement ?? content
	const track = content.querySelector<HTMLElement>(`[${PART.slides}]`) ?? content
	const cleanups: Array<() => void> = []

	const listen = <K extends keyof HTMLElementEventMap>(
		target: HTMLElement,
		type: K,
		handler: (event: HTMLElementEventMap[K]) => void,
		options?: AddEventListenerOptions,
	) => {
		target.addEventListener(type, handler, options)
		cleanups.push(() => target.removeEventListener(type, handler, options))
	}

	const partsOf = (index: number) => {
		const slide = track.children.item(index)
		if (!(slide instanceof HTMLElement)) return null
		const zoom = slide.querySelector<HTMLElement>(`[${PART.zoom}]`)
		const media = slide.querySelector<HTMLImageElement>(`img[${PART.media}]`)
		return zoom === null || media === null ? null : { slide, zoom, media }
	}

	let active = Math.max(
		0,
		Array.from(track.children).findIndex((slide) => slide.hasAttribute("data-active")),
	)
	let pose: M.Pose = M.REST
	let frame: M.Frame | null = null
	let origin: M.Point = { x: 0, y: 0 }
	let motion: Animation | null = null
	let snap: Animation | null = null
	let announced = "false:true"

	// SLIDES

	let isScrolling = false
	let isJumping = false
	let scrollIdle = 0
	let scrollFrame = 0

	const offsets = (): ReadonlyArray<number> =>
		Array.from(track.children, (slide) =>
			slide instanceof HTMLElement
				? slide.offsetLeft + slide.offsetWidth / 2 - track.clientWidth / 2
				: 0,
		)

	const announce = () => {
		const isZoomed = pose.scale > M.ZOOMED_ABOVE
		const canZoomIn = frame === null || pose.scale < frame.maxScale - 0.001
		const key = `${isZoomed}:${canZoomIn}`
		if (key === announced) return
		announced = key
		emit({ _tag: "Zoom", isZoomed, canZoomIn })
	}

	/** Each slide opens at rest: the one being left gives up its zoom. */
	const activate = (index: number) => {
		const leaving = partsOf(active)
		motion?.cancel()
		motion = null
		if (leaving !== null) {
			leaving.zoom.style.transform = ""
			leaving.zoom.style.touchAction = ""
		}
		active = index
		pose = M.REST
		frame = null
		emit({ _tag: "Slide", index })
		announce()
	}

	const syncActive = () => {
		const index = M.slideAt(offsets(), track.scrollLeft)
		if (index !== active) activate(index)
	}

	const settleScroll = () => {
		window.clearTimeout(scrollIdle)
		isScrolling = false
		// Anything measured while the slide was still travelling is off by the distance it had left.
		frame = null
		syncActive()
	}

	/** An instant jump: snapping is lifted for the write, or `scroll-snap-stop` would catch it. */
	const jump = (index: number): boolean => {
		const target = offsets()[index]
		if (target === undefined) return false
		isJumping = true
		track.style.scrollSnapType = "none"
		track.scrollLeft = target
		requestAnimationFrame(() => {
			track.style.scrollSnapType = ""
			if (Math.abs(track.scrollLeft - target) >= 1) track.scrollLeft = target
			requestAnimationFrame(() => {
				isJumping = false
			})
		})
		return true
	}

	listen(
		track,
		"scroll",
		() => {
			if (isJumping) return
			isScrolling = true
			window.clearTimeout(scrollIdle)
			// `scrollend` is missing or late in some engines; a quiet gap ends the swipe too.
			scrollIdle = window.setTimeout(settleScroll, SCROLL_IDLE_MS)
			if (scrollFrame !== 0) return
			scrollFrame = requestAnimationFrame(() => {
				scrollFrame = 0
				syncActive()
			})
		},
		{ passive: true },
	)
	track.addEventListener("scrollend", settleScroll)
	cleanups.push(() => track.removeEventListener("scrollend", settleScroll))

	// POSE

	const measure = (): M.Frame | null => {
		if (frame !== null) return frame
		const parts = partsOf(active)
		// The slide's box is only where it will rest once the track has stopped.
		if (isScrolling || parts === null || parts.media.offsetWidth === 0) return null
		const { slide, zoom, media } = parts
		const box = slide.getBoundingClientRect()
		const view = content.getBoundingClientRect()
		const shown = { width: media.offsetWidth, height: media.offsetHeight }
		origin = { x: view.left, y: view.top }
		frame = {
			media: shown,
			center: {
				x: box.left - view.left + zoom.offsetLeft + zoom.offsetWidth / 2,
				y: box.top - view.top + zoom.offsetTop + zoom.offsetHeight / 2,
			},
			viewport: { width: view.width, height: view.height },
			maxScale: M.maxScaleOf({ width: media.naturalWidth, height: media.naturalHeight }, shown),
		}
		return frame
	}

	const write = (next: M.Pose) => {
		pose = next
		const parts = partsOf(active)
		if (parts === null) return
		const isAtRest = next.scale === 1 && next.x === 0 && next.y === 0
		parts.zoom.style.transform = isAtRest
			? ""
			: `translate(${next.x}px, ${next.y}px) scale(${next.scale})`
		// A zoomed shot keeps its touches: one finger pans it instead of swiping the track.
		parts.zoom.style.touchAction = next.scale > M.ZOOMED_ABOVE ? "none" : ""
		announce()
	}

	/** Stops a running animation where it is, so a finger landing on a moving shot catches it. */
	const halt = () => {
		if (motion === null) return
		const parts = partsOf(active)
		const live = parts === null ? "none" : getComputedStyle(parts.zoom).transform
		motion.cancel()
		motion = null
		if (live === "none" || live === "") return
		const matrix = new DOMMatrixReadOnly(live)
		write({ scale: matrix.a, x: matrix.e, y: matrix.f })
	}

	const glide = (target: M.Pose, duration: number, easing: string) => {
		const parts = partsOf(active)
		if (parts === null) return
		const from = getComputedStyle(parts.zoom).transform
		motion?.cancel()
		motion = null
		write(target)
		if (isReducedMotion() || typeof parts.zoom.animate !== "function") return
		const to = getComputedStyle(parts.zoom).transform
		const running = parts.zoom.animate(
			[{ transform: from === "none" ? IDENTITY : from }, { transform: to === "none" ? IDENTITY : to }],
			{ duration, easing },
		)
		motion = running
		running.onfinish = () => {
			if (motion === running) motion = null
		}
	}

	// PULL TO DISMISS

	let pulled: M.Pull = { x: 0, y: 0, scale: 1, progress: 0 }

	const showPull = (pull: M.Pull) => {
		const parts = partsOf(active)
		if (parts === null) return
		pulled = pull
		root.setAttribute(STATE.pulling, "")
		root.style.setProperty(VAR.pullProgress, String(pull.progress))
		parts.zoom.style.transform = `translate(${pull.x}px, ${pull.y}px) scale(${pull.scale})`
	}

	/** Past the threshold: the shot stays where it was let go and closes from there. */
	const dismissPull = () => {
		root.removeAttribute(STATE.pulling)
		root.setAttribute(STATE.pullDismissing, "")
		emit({ _tag: "Dismiss" })
	}

	const clear = () => {
		root.style.removeProperty(VAR.pullSnapDuration)
		root.style.removeProperty(VAR.pullSnapEasing)
		root.style.removeProperty(VAR.pullProgress)
	}

	/** Ends a snap back at once. Its finish event arrives a frame late and would undo a pull begun since. */
	const endSnap = () => {
		if (snap === null) return
		snap.onfinish = null
		snap.oncancel = null
		snap.cancel()
		snap = null
		clear()
	}

	const snapBack = (velocityY: number) => {
		const parts = partsOf(active)
		const from = parts?.zoom.style.transform ?? ""
		const released = pulled
		pulled = { x: 0, y: 0, scale: 1, progress: 0 }
		root.removeAttribute(STATE.pulling)
		if (parts === null) {
			clear()
			return
		}
		parts.zoom.style.transform = ""
		if (from === "" || isReducedMotion() || typeof parts.zoom.animate !== "function") {
			clear()
			return
		}
		const easing = hasLinearEasing() ? M.snapEasing(velocityY, released.y) : M.PULL_SNAP_FALLBACK_EASING
		// The backdrop returns on the same clock as the shot.
		root.style.setProperty(VAR.pullSnapDuration, `${M.PULL_SNAP_MS}ms`)
		root.style.setProperty(VAR.pullSnapEasing, easing)
		root.style.setProperty(VAR.pullProgress, "0")
		const running = parts.zoom.animate(
			[{ transform: from }, { transform: "translate(0px, 0px) scale(1)" }],
			{
				duration: M.PULL_SNAP_MS,
				easing,
			},
		)
		snap = running
		const done = () => {
			if (snap === running) snap = null
			clear()
		}
		running.onfinish = done
		running.oncancel = done
	}

	// POINTERS

	const pointers = new Map<number, M.Point>()
	let mode: Mode = "idle"
	let start: M.Point = { x: 0, y: 0 }
	let startPose: M.Pose = M.REST
	let startSpan = 1
	let hasMoved = false
	let samples: ReadonlyArray<M.Sample> = []
	let pressTarget: EventTarget | null = null
	let lastTap: M.Sample | null = null

	const local = (event: MouseEvent): M.Point => ({
		x: event.clientX - origin.x,
		y: event.clientY - origin.y,
	})

	const centroid = (): M.Point => {
		const points = [...pointers.values()]
		const sum = points.reduce((total, point) => ({ x: total.x + point.x, y: total.y + point.y }), {
			x: 0,
			y: 0,
		})
		return { x: sum.x / points.length, y: sum.y / points.length }
	}

	const span = (): number => {
		const [first, second] = [...pointers.values()]
		return first === undefined || second === undefined
			? 1
			: Math.max(1, Math.hypot(first.x - second.x, first.y - second.y))
	}

	const toggleAt = (at: M.Point) => {
		const measured = measure()
		if (measured === null) return
		const scale = M.toggledScale(measured, pose.scale)
		glide(M.clampPose(measured, M.zoomAbout(measured, pose, scale, at)), STEP_MS, "ease-in-out")
	}

	const isBare = (target: EventTarget | null): boolean =>
		target instanceof Element && (target.hasAttribute(PART.slide) || target.hasAttribute(PART.zoom))

	/** A press that never moved. On the shot it zooms; beside it, it closes the viewer. */
	const tapped = (event: PointerEvent) => {
		const parts = partsOf(active)
		if (parts === null || pressTarget !== parts.media) {
			if (isBare(pressTarget)) emit({ _tag: "Dismiss" })
			return
		}
		const at = local(event)
		if (event.pointerType === "mouse") {
			toggleAt(at)
			return
		}
		// Touch waits for the second tap: the first may be the start of a swipe or a pull.
		const prior = lastTap
		lastTap = { ...at, at: event.timeStamp }
		const isDoubleTap =
			prior !== null &&
			event.timeStamp - prior.at <= DOUBLE_TAP_MS &&
			Math.hypot(at.x - prior.x, at.y - prior.y) <= DOUBLE_TAP_PX
		if (!isDoubleTap) return
		lastTap = null
		toggleAt(at)
	}

	const capture = (event: PointerEvent) => {
		if (track.hasPointerCapture(event.pointerId)) return
		track.setPointerCapture(event.pointerId)
	}

	listen(track, "pointerdown", (event) => {
		if (event.pointerType === "mouse" && event.button !== 0) return
		// Two fingers are a pinch; a third has nothing to add.
		if (pointers.size >= 2) return
		const parts = partsOf(active)
		if (isScrolling || !(event.target instanceof Node)) return
		if (
			parts === null
				? event.target !== track.children.item(active)
				: !parts.slide.contains(event.target)
		) {
			return
		}
		endSnap()
		halt()
		const measured = measure()
		pointers.set(event.pointerId, local(event))
		pressTarget = event.target
		hasMoved = false
		samples = [{ ...local(event), at: event.timeStamp }]
		startPose = pose
		if (measured === null) {
			mode = "tap"
			start = local(event)
		} else if (pointers.size === 2) {
			if (mode === "pull") {
				// A second finger turns the pull into a pinch: the shot returns at once.
				snapBack(0)
				endSnap()
			}
			mode = "pinch"
			start = centroid()
			startSpan = span()
			hasMoved = true
			capture(event)
		} else if (pose.scale > M.ZOOMED_ABOVE) {
			mode = "pan"
			start = local(event)
			capture(event)
		} else {
			// At rest a press may become a swipe (the track's own), a pull, or a tap.
			mode = "await-axis"
			start = local(event)
		}
		// A touch stays with the element it landed on; a mouse released off the track would be lost.
		if (event.pointerType === "mouse") capture(event)
	})

	listen(track, "pointermove", (event) => {
		if (!pointers.has(event.pointerId)) return
		const at = local(event)
		pointers.set(event.pointerId, at)
		samples = [...samples, { ...at, at: event.timeStamp }]
			.filter((sample) => event.timeStamp - sample.at <= VELOCITY_WINDOW_MS)
			.slice(-VELOCITY_SAMPLES)
		const measured = frame
		if (mode === "pinch" && measured !== null && pointers.size >= 2) {
			const middle = centroid()
			const scale = elastic(startPose.scale * (span() / startSpan), 1, measured.maxScale)
			const ratio = scale / startPose.scale
			// The point of the shot that sat between the fingers stays between them.
			write(
				M.bandPose(
					measured,
					{
						scale,
						x: middle.x - measured.center.x - ratio * (start.x - measured.center.x - startPose.x),
						y: middle.y - measured.center.y - ratio * (start.y - measured.center.y - startPose.y),
					},
					M.RUBBER_BAND_REACH.touch,
				),
			)
			return
		}
		const dx = at.x - start.x
		const dy = at.y - start.y
		const slop = mode === "await-axis" ? M.PULL_LOCK_PX : TAP_SLOP_PX
		if (!hasMoved && Math.hypot(dx, dy) < slop) return
		hasMoved = true
		if (mode === "await-axis") {
			// Sideways belongs to the track; anything else starts a pull from here, so it never jumps.
			mode = Math.abs(dy) >= Math.abs(dx) ? "pull" : "idle"
			if (mode === "pull") {
				start = at
				showPull(M.pullOf(0, 0))
				capture(event)
			}
			return
		}
		if (mode === "pull") {
			showPull(M.pullOf(dx, dy))
			return
		}
		if (mode === "pan" && measured !== null) {
			const reach = M.RUBBER_BAND_REACH[event.pointerType === "mouse" ? "mouse" : "touch"]
			write(
				M.bandPose(
					measured,
					{ scale: startPose.scale, x: startPose.x + dx, y: startPose.y + dy },
					reach,
				),
			)
		}
	})

	const release = (event: PointerEvent, isCancelled: boolean) => {
		const at = pointers.get(event.pointerId)
		if (at === undefined) return
		pointers.delete(event.pointerId)
		const measured = frame
		const [survivor] = [...pointers.values()]
		if (survivor !== undefined) {
			// One finger lifted mid-pinch: the other keeps panning from where things are.
			start = survivor
			startPose = pose
			samples = []
			mode = pose.scale > M.ZOOMED_ABOVE ? "pan" : "idle"
			if (mode === "idle" && measured !== null) glide(M.clampPose(measured, pose), SETTLE_MS, SETTLE)
			return
		}
		const ended = mode
		mode = "idle"
		if (ended === "pull") {
			const velocity = M.velocityOf(samples).y
			if (!isCancelled && M.isDismissal(at.y - start.y, velocity)) dismissPull()
			else snapBack(isCancelled ? 0 : velocity)
			return
		}
		if (isCancelled) {
			if (measured !== null && ended !== "idle") glide(M.clampPose(measured, pose), SETTLE_MS, SETTLE)
			return
		}
		if (!hasMoved) {
			if (ended !== "idle") tapped(event)
			return
		}
		if (measured === null) return
		if (ended === "pinch") {
			glide(M.clampPose(measured, pose), SETTLE_MS, SETTLE)
			return
		}
		if (ended !== "pan") return
		const velocity = M.velocityOf(samples)
		const last = samples[samples.length - 1]
		const isCoasting =
			last !== undefined &&
			event.timeStamp - last.at <= VELOCITY_WINDOW_MS &&
			Math.hypot(velocity.x, velocity.y) > M.MOMENTUM_THRESHOLD
		if (isCoasting) glide(M.coastTarget(measured, pose, velocity), COAST_MS, SETTLE)
		else glide(M.clampPose(measured, pose), SETTLE_MS, SETTLE)
	}

	listen(track, "pointerup", (event) => release(event, false))
	listen(track, "pointercancel", (event) => release(event, true))

	// WHEEL

	let wheel: WheelGesture = { axis: "y", y: 0, events: 0, isSpent: false, at: -Infinity }
	let wheelIdle = 0

	/** A trackpad or wheel pushing the shot away: it follows, and closes once pushed far enough. */
	const wheelPull = (event: WheelEvent) => {
		if (event.deltaMode !== 0 || isScrolling) return
		const isNewGesture = event.timeStamp - wheel.at > WHEEL_GAP_MS
		if (isNewGesture) {
			wheel = {
				axis: Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? "y" : "x",
				y: 0,
				events: 0,
				isSpent: false,
				at: event.timeStamp,
			}
		}
		wheel.at = event.timeStamp
		if (wheel.axis === "x" || wheel.isSpent) return
		if (Math.abs(event.deltaX) > 2 * Math.abs(event.deltaY) && Math.abs(event.deltaX) >= 4) return
		endSnap()
		wheel.y -= event.deltaY
		wheel.events += 1
		window.clearTimeout(wheelIdle)
		if (Math.abs(wheel.y) >= M.PULL_DISMISS_DISTANCE && wheel.events >= WHEEL_PULL_EVENTS) {
			wheel.isSpent = true
			dismissPull()
			return
		}
		showPull(M.pullOf(0, wheel.y))
		wheelIdle = window.setTimeout(() => snapBack(0), WHEEL_GAP_MS)
	}

	listen(
		content,
		"wheel",
		(event) => {
			// Ctrl + wheel is also what a trackpad pinch arrives as.
			if (event.ctrlKey) {
				event.preventDefault()
				const measured = measure()
				if (measured === null || isScrolling || Math.abs(event.deltaY) <= Math.abs(event.deltaX))
					return
				halt()
				const scale = M.wheelScale(pose.scale, event.deltaY)
				write(M.clampPose(measured, M.zoomAbout(measured, pose, scale, local(event))))
				return
			}
			if (pose.scale <= M.ZOOMED_ABOVE) {
				wheelPull(event)
				return
			}
			event.preventDefault()
			const measured = measure()
			if (measured === null) return
			halt()
			write(
				M.clampPose(measured, {
					scale: pose.scale,
					x: pose.x - event.deltaX,
					y: pose.y - event.deltaY,
				}),
			)
		},
		{ passive: false },
	)

	// LAYOUT

	/** A resize or a late bitmap moves everything the pose was measured against. */
	const remeasure = () => {
		frame = null
		const measured = measure()
		if (measured !== null && pose.scale > M.ZOOMED_ABOVE) {
			motion?.cancel()
			motion = null
			write(M.clampPose(measured, pose))
		}
		announce()
	}

	if (typeof ResizeObserver === "function") {
		const observer = new ResizeObserver(() => {
			jump(active)
			remeasure()
		})
		observer.observe(track)
		cleanups.push(() => observer.disconnect())
	}
	// `load` does not bubble: the capture phase hears every slide's image.
	listen(track, "load", remeasure, { capture: true })

	// Before the first paint, or the viewer would open on its first slide and then jump.
	const first = offsets()[active]
	if (first !== undefined && first !== track.scrollLeft) track.scrollLeft = first

	const viewer: Viewer = {
		goTo: (index) => {
			if (isScrolling || !jump(index)) return
			if (index !== active) activate(index)
		},
		zoomBy: (step) => {
			const measured = measure()
			if (measured === null || isScrolling) return
			halt()
			const middle = { x: measured.viewport.width / 2, y: measured.viewport.height / 2 }
			const scale = step === "reset" ? 1 : M.stepScale(measured, pose.scale, step)
			glide(M.clampPose(measured, M.zoomAbout(measured, pose, scale, middle)), STEP_MS, "ease-in-out")
		},
		panBy: (dx, dy) => {
			const measured = measure()
			if (measured === null || pose.scale <= M.ZOOMED_ABOVE) return
			halt()
			glide(
				M.clampPose(measured, { scale: pose.scale, x: pose.x - dx, y: pose.y - dy }),
				KEY_PAN_MS,
				SETTLE,
			)
		},
		dispose: () => {
			viewers.delete(content)
			window.clearTimeout(scrollIdle)
			window.clearTimeout(wheelIdle)
			cancelAnimationFrame(scrollFrame)
			motion?.cancel()
			snap?.cancel()
			cleanups.splice(0).forEach((cleanup) => cleanup())
		},
	}
	viewers.set(content, viewer)
	return viewer
}

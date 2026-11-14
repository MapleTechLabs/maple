/**
 * The numbers behind the viewer's gestures, free of the DOM. Constants and formulas follow ramka's
 * `gesture-math.ts` and `pull-math.ts` (MIT, Copyright (c) 2026 Artur Bień): see ./LICENSE-ramka.
 */

export type Point = Readonly<{ x: number; y: number }>
export type Size = Readonly<{ width: number; height: number }>

/** `translate(x, y) scale(scale)` about the media's own centre. */
export type Pose = Readonly<{ scale: number; x: number; y: number }>

/** The media at rest inside the viewer: its box, its centre, and the viewport it pans within. */
export type Frame = Readonly<{ media: Size; center: Point; viewport: Size; maxScale: number }>

export const REST: Pose = { scale: 1, x: 0, y: 0 }

/** Above this the media counts as zoomed: a pinch rarely lands back on exactly 1. */
export const ZOOMED_ABOVE = 1.01

const ZOOM_STEP = 2
const MAX_SCALE_CAP = 6

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

/** Zoom ends where the bitmap's own pixels are on screen, and never short of one doubling. */
export const maxScaleOf = (natural: Size, shown: Size): number =>
	shown.width <= 0 || shown.height <= 0
		? ZOOM_STEP
		: clamp(
				Math.max(natural.width / shown.width, natural.height / shown.height),
				ZOOM_STEP,
				MAX_SCALE_CAP,
			)

/**
 * Where one axis of a pose may rest. Media larger than the viewport pans edge to edge; smaller
 * media has a single home that drifts from its resting place to the viewport's middle as it grows.
 */
const axisRange = (
	size: number,
	scale: number,
	viewport: number,
	center: number,
): readonly [number, number] => {
	const toMiddle = viewport / 2 - center
	const scaled = size * scale
	if (scaled > viewport + 0.5) {
		const overhang = (scaled - viewport) / 2
		return [toMiddle - overhang, toMiddle + overhang]
	}
	const fit = size <= 0 ? 1 : viewport / size
	const travel = fit <= 1 ? 1 : clamp((scale - 1) / (fit - 1), 0, 1)
	return [toMiddle * travel, toMiddle * travel]
}

export const panRange = (frame: Frame, scale: number) => ({
	x: axisRange(frame.media.width, scale, frame.viewport.width, frame.center.x),
	y: axisRange(frame.media.height, scale, frame.viewport.height, frame.center.y),
})

const clampScale = (frame: Frame, scale: number): number => clamp(scale, 1, frame.maxScale)

/** The nearest pose that is inside the zoom bounds and leaves no gap at an overflowing edge. */
export const clampPose = (frame: Frame, pose: Pose): Pose => {
	const scale = clampScale(frame, pose.scale)
	if (scale <= 1) return REST
	const range = panRange(frame, scale)
	return { scale, x: clamp(pose.x, range.x[0], range.x[1]), y: clamp(pose.y, range.y[0], range.y[1]) }
}

const RUBBER_BAND = 0.28
/** How far past an edge a drag may pull, as a share of the viewport. */
export const RUBBER_BAND_REACH = { touch: 0.16, mouse: 0.09 } as const

const rubberBand = (over: number, reach: number): number =>
	reach <= 0
		? 0
		: (Math.sign(over) * (Math.abs(over) * reach * RUBBER_BAND)) / (reach + RUBBER_BAND * Math.abs(over))

const bandAxis = (value: number, [min, max]: readonly [number, number], reach: number): number =>
	value < min
		? min + rubberBand(value - min, reach)
		: value > max
			? max + rubberBand(value - max, reach)
			: value

/** A dragged pose: free inside its range, following the finger less and less beyond it. */
export const bandPose = (frame: Frame, pose: Pose, reach: number): Pose => {
	const range = panRange(frame, pose.scale)
	return {
		scale: pose.scale,
		x: bandAxis(pose.x, range.x, frame.viewport.width * reach),
		y: bandAxis(pose.y, range.y, frame.viewport.height * reach),
	}
}

/** Zoom to `scale` so the point of the media under `focal` (viewport coordinates) stays there. */
export const zoomAbout = (frame: Frame, pose: Pose, scale: number, focal: Point): Pose => {
	const next = clampScale(frame, scale)
	const ratio = next / pose.scale
	return {
		scale: next,
		x: focal.x - frame.center.x - ratio * (focal.x - frame.center.x - pose.x),
		y: focal.y - frame.center.y - ratio * (focal.y - frame.center.y - pose.y),
	}
}

/** A button or key step: double or halve, landing on exactly 1 on the way out. */
export const stepScale = (frame: Frame, scale: number, direction: "in" | "out"): number =>
	clampScale(frame, direction === "in" ? scale * ZOOM_STEP : scale / ZOOM_STEP)

/** A double tap toggles between rest and one step in. */
export const toggledScale = (frame: Frame, scale: number): number =>
	scale > ZOOMED_ABOVE ? 1 : Math.min(ZOOM_STEP, frame.maxScale)

const WHEEL_SENSITIVITY = 100

/** A ctrl-wheel or trackpad pinch tick: `WHEEL_SENSITIVITY` of delta is one doubling, at most. */
export const wheelScale = (scale: number, deltaY: number): number =>
	scale * Math.min(1 + Math.abs(deltaY / WHEEL_SENSITIVITY), 2) ** Math.sign(-deltaY)

const PAN_FRICTION = 3.2
/** Below this release speed (px/s) a pan just stops. */
export const MOMENTUM_THRESHOLD = 50

/** Where a pan released at `velocity` (px/s) comes to rest under exponential friction. */
export const coastTarget = (frame: Frame, pose: Pose, velocity: Point): Pose =>
	clampPose(frame, {
		scale: pose.scale,
		x: pose.x + velocity.x / PAN_FRICTION,
		y: pose.y + velocity.y / PAN_FRICTION,
	})

// Pull to dismiss.

export const PULL_LOCK_PX = 6
export const PULL_DISMISS_DISTANCE = 100
const PULL_DISMISS_VELOCITY = 400
const PULL_MIN_SCALE = 0.85
export const PULL_SNAP_MS = 270
export const PULL_SNAP_FALLBACK_EASING = "cubic-bezier(0.33, 1, 0.68, 1)"

export type Pull = Readonly<{ x: number; y: number; scale: number; progress: number }>

const damped = (distance: number, limit: number): number =>
	Math.sign(distance) * limit * (1 - Math.exp(-Math.abs(distance) / limit))

/** The media under a vertical drag: it trails the finger, shrinks, and reports how far it is to a dismissal. */
export const pullOf = (dx: number, dy: number): Pull => {
	const y = damped(dy, PULL_DISMISS_DISTANCE * 1.2)
	const follow = dy === 0 ? 1 : Math.abs(y) / Math.abs(dy)
	const progress = Math.min(Math.abs(dy) / PULL_DISMISS_DISTANCE, 1)
	return {
		x: damped(dx * follow, PULL_DISMISS_DISTANCE * 0.5),
		y,
		scale: 1 - progress * (1 - PULL_MIN_SCALE),
		progress,
	}
}

/** Far enough, or flicked fast enough the same way it was dragged. */
export const isDismissal = (dy: number, velocityY: number): boolean =>
	Math.abs(dy) >= PULL_DISMISS_DISTANCE ||
	(Math.abs(velocityY) >= PULL_DISMISS_VELOCITY && Math.sign(velocityY) === Math.sign(dy))

const SNAP_SETTLE = 7.5
const SNAP_MAX_VELOCITY = 2.5
const SNAP_STOPS = 40

/** A critically damped spring as a CSS `linear()` curve, carrying the release velocity into the snap back. */
export const snapEasing = (velocityY: number, releasedAt: number): string => {
	const velocity =
		releasedAt === 0
			? 0
			: clamp((velocityY * (PULL_SNAP_MS / 1000)) / releasedAt, -SNAP_MAX_VELOCITY, SNAP_MAX_VELOCITY)
	const stops = Array.from({ length: SNAP_STOPS + 1 }, (_, index) => {
		const progress = index / SNAP_STOPS
		const remaining = Math.exp(-SNAP_SETTLE * progress) * (1 + (velocity + SNAP_SETTLE) * progress)
		return Math.min(Math.round((1 - remaining) * 10_000) / 10_000, 1)
	})
	return `linear(${stops.join(", ")})`
}

export type Sample = Readonly<{ x: number; y: number; at: number }>

/** Speed in px/s across the given pointer samples, first to last. */
export const velocityOf = (samples: ReadonlyArray<Sample>): Point => {
	const first = samples[0]
	const last = samples[samples.length - 1]
	if (first === undefined || last === undefined) return { x: 0, y: 0 }
	const elapsed = last.at - first.at
	return elapsed <= 0
		? { x: 0, y: 0 }
		: { x: ((last.x - first.x) / elapsed) * 1000, y: ((last.y - first.y) / elapsed) * 1000 }
}

// Slides.

/** The slide whose snap position is nearest to where the track is scrolled. */
export const slideAt = (offsets: ReadonlyArray<number>, position: number): number =>
	offsets.reduce(
		(nearest, offset, index) =>
			Math.abs(offset - position) < Math.abs((offsets[nearest] ?? 0) - position) ? index : nearest,
		0,
	)

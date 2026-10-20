import { Effect, Option, Schema } from "effect"
import { Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { VIEWPORT_ATTRIBUTE } from "../xyflow/attach"
import {
	compileTracks,
	type EdgeParticleSpec,
	MAX_TOTAL_PARTICLES,
	type PathCache,
	type Track,
} from "./particle-tracks"

// `ServiceMapParticleCanvas`: one canvas, one rAF loop, a global particle budget. The edges
// it animates arrive as `data-tracks` (the view's serialized geometry); the camera is read
// from the renderer the canvas sits beside.

const TRACKS_ATTRIBUTE = "data-tracks"

export const ParticleMessage = defineMessageUnion({ CompletedMountParticles: {} })

const decodeSpecs = Schema.decodeUnknownOption(
	Schema.fromJsonString(
		Schema.Array(
			Schema.Struct({
				id: Schema.String,
				path: Schema.String,
				sourceColor: Schema.String,
				callsPerSecond: Schema.Number,
				strokeWidth: Schema.Number,
			}),
		),
	),
)

type Camera = { x: number; y: number; zoom: number }

interface CameraReaderState {
	leaf: Element | null
	raw: string | null
	camera: Camera
}

/**
 * The renderer's camera (`readViewport`) without a per-frame DOM query: the leaf is looked up
 * again only once detached, and its attribute parsed only when it changed.
 */
const cameraReader = (canvas: HTMLCanvasElement) => {
	const state: CameraReaderState = {
		leaf: null,
		raw: null,
		camera: { x: 0, y: 0, zoom: 1 },
	}
	return (): Camera => {
		if (state.leaf === null || !state.leaf.isConnected)
			state.leaf =
				canvas.parentElement?.querySelector(".react-flow__renderer .react-flow__viewport-portal") ??
				null
		const raw = state.leaf?.getAttribute(VIEWPORT_ATTRIBUTE) ?? null
		if (raw !== state.raw) {
			state.raw = raw
			const parts = (raw ?? "").split(",").map(Number)
			if (parts.length === 3 && parts.every(Number.isFinite))
				state.camera = { x: parts[0], y: parts[1], zoom: parts[2] }
		}
		return state.camera
	}
}

const drawFrame = (
	ctx: CanvasRenderingContext2D,
	canvas: HTMLCanvasElement,
	tracks: ReadonlyArray<Track>,
	camera: { x: number; y: number; zoom: number },
	size: { cssW: number; cssH: number; dpr: number },
	scratch: { x: Float32Array; y: Float32Array; r: Float32Array },
	nowMs: number,
): boolean => {
	ctx.setTransform(1, 0, 0, 1, 0, 0)
	ctx.clearRect(0, 0, canvas.width, canvas.height)
	if (tracks.length === 0) return false
	const { x: tx, y: ty, zoom } = camera
	const { dpr } = size
	ctx.setTransform(zoom * dpr, 0, 0, zoom * dpr, tx * dpr, ty * dpr)
	const margin = 40
	const left = -tx / zoom - margin
	const top = -ty / zoom - margin
	const right = left + size.cssW / zoom + margin * 2
	const bottom = top + size.cssH / zoom + margin * 2
	const t = nowMs / 1000
	let count = 0
	for (const track of tracks) {
		if (track.maxX < left || track.minX > right || track.maxY < top || track.minY > bottom) continue
		const base = (t / track.duration + track.phase) % 1
		ctx.globalAlpha = 0.2
		ctx.fillStyle = track.sourceColor
		ctx.beginPath()
		let visible = 0
		for (let index = 0; index < track.count; index++) {
			let frac = base + index / track.count
			frac -= Math.floor(frac)
			const scaled = frac * track.segments
			const at = Math.min(track.segments - 1, Math.floor(scaled))
			const mix = scaled - at
			const o = at * 2
			const x = track.points[o] + (track.points[o + 2] - track.points[o]) * mix
			const y = track.points[o + 1] + (track.points[o + 3] - track.points[o + 1]) * mix
			if (x < left || x > right || y < top || y > bottom) continue
			ctx.moveTo(x + track.radius * 2.6, y)
			ctx.arc(x, y, track.radius * 2.6, 0, Math.PI * 2)
			scratch.x[count] = x
			scratch.y[count] = y
			scratch.r[count] = track.radius
			count++
			visible++
		}
		if (visible > 0) ctx.fill()
	}
	if (count > 0) {
		ctx.globalAlpha = 0.95
		ctx.fillStyle = "#ffffff"
		ctx.beginPath()
		for (let index = 0; index < count; index++) {
			const radius = scratch.r[index] * 0.75
			ctx.moveTo(scratch.x[index] + radius, scratch.y[index])
			ctx.arc(scratch.x[index], scratch.y[index], radius, 0, Math.PI * 2)
		}
		ctx.fill()
	}
	ctx.globalAlpha = 1
	return count > 0
}

/** Starts the rAF loop; recompiles tracks when `data-tracks` changes; stops on unmount. */
const animate = (canvas: HTMLCanvasElement) => {
	const ctx = canvas.getContext("2d")
	if (ctx === null) return () => {}
	const readCamera = cameraReader(canvas)
	const pathCache: PathCache = new Map()
	const scratch = {
		x: new Float32Array(MAX_TOTAL_PARTICLES),
		y: new Float32Array(MAX_TOTAL_PARTICLES),
		r: new Float32Array(MAX_TOTAL_PARTICLES),
	}
	const size = { cssW: 0, cssH: 0, dpr: 1 }
	const resize = () => {
		size.dpr = Math.min(2, window.devicePixelRatio || 1)
		size.cssW = canvas.clientWidth
		size.cssH = canvas.clientHeight
		const width = Math.max(1, Math.round(size.cssW * size.dpr))
		const height = Math.max(1, Math.round(size.cssH * size.dpr))
		if (canvas.width !== width) canvas.width = width
		if (canvas.height !== height) canvas.height = height
	}
	const compile = (): ReadonlyArray<Track> => {
		const specs: ReadonlyArray<EdgeParticleSpec> = Option.getOrElse(
			decodeSpecs(canvas.getAttribute(TRACKS_ATTRIBUTE) ?? "[]"),
			() => [],
		)
		return compileTracks(specs, pathCache)
	}
	// `painted`: an empty map clears once, then idles instead of clearing a blank canvas every frame.
	const state = { tracks: compile(), raf: 0, painted: true }
	const retrack = new MutationObserver(() => {
		state.tracks = compile()
	})
	retrack.observe(canvas, { attributes: true, attributeFilter: [TRACKS_ATTRIBUTE] })
	const observer = new ResizeObserver(resize)
	observer.observe(canvas)
	resize()
	const loop = (now: number) => {
		state.raf = requestAnimationFrame(loop)
		if (state.tracks.length === 0 && !state.painted) return
		state.painted = drawFrame(ctx, canvas, state.tracks, readCamera(), size, scratch, now)
	}
	state.raf = requestAnimationFrame(loop)
	return () => {
		cancelAnimationFrame(state.raf)
		observer.disconnect()
		retrack.disconnect()
	}
}

const AnimateParticles = Mount.define("AnimateParticles", {
	messages: [ParticleMessage.CompletedMountParticles],
	execute: ({ element }) =>
		Effect.acquireRelease(
			Effect.sync(() => (element instanceof HTMLCanvasElement ? animate(element) : () => {})),
			(release) => Effect.sync(release),
		).pipe(Effect.as(ParticleMessage.CompletedMountParticles())),
})

/** The particle canvas over the map; `tracks` is the serialized edge geometry. */
export const particleCanvas = <M>(
	h: HtmlBuilder<M>,
	tracks: string,
	toMessage: (message: typeof ParticleMessage.Type) => M,
): Html =>
	h.canvas([
		h.Class("pointer-events-none absolute inset-0 h-full w-full"),
		h.Style({ "z-index": "4" }),
		h.Attribute(TRACKS_ATTRIBUTE, tracks),
		h.OnMount(Mount.mapMessage(AnimateParticles(), toMessage)),
	])

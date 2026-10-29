import { Effect, Queue, Stream } from "effect"
import { Mount } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { readViewport } from "../xyflow/attach"
import { Viewport } from "../xyflow/geometry"

// `window.__smBench` for the service map bench: readiness, idle and pan runs, camera pin and fit. Camera
// moves go through the Model as Messages, so a pan frame costs update, view and patch.

export const HarnessMessage = defineMessageUnion({
	RequestedCamera: { viewport: Viewport },
	RequestedFit: {},
})
export type HarnessMessage = typeof HarnessMessage.Type

interface Camera {
	readonly x: number
	readonly y: number
	readonly zoom: number
}

const percentile = (sorted: ReadonlyArray<number>, p: number): number =>
	sorted.length === 0
		? 0
		: sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))]

const readCamera = (root: Element): Camera => readViewport(root) ?? { x: 0, y: 0, zoom: 1 }

const isReady = (root: Element) => {
	const nodes = root.querySelectorAll<HTMLElement>(".react-flow__node")
	return (
		root.querySelector('[data-elk-status="ready"]') !== null &&
		nodes.length > 0 &&
		Array.from(nodes).every((node) => node.style.visibility === "visible") &&
		root.querySelectorAll(".react-flow__edge").length > 0
	)
}

/** What one run reports: frame pacing and main-thread blocking. */
export interface FrameReport {
	readonly durationMs: number
	readonly frames: number
	readonly fps: number
	readonly frameP50: number
	readonly frameP95: number
	readonly droppedFrames: number
	readonly longTasks: number
	readonly totalBlockingMs: number
}

const runFrames = (
	root: Element,
	emit: (message: HarnessMessage) => void,
	durationMs: number,
	pan: boolean,
) =>
	new Promise<FrameReport>((resolve) => {
		const longTasks: PerformanceEntry[] = []
		const observer = new PerformanceObserver((list) => longTasks.push(...list.getEntries()))
		observer.observe({ entryTypes: ["longtask"] })
		const base = readCamera(root)
		const deltas: number[] = []
		const start = performance.now()
		const clock = { prev: start }
		const tick = (now: number) => {
			deltas.push(now - clock.prev)
			clock.prev = now
			const elapsed = now - start
			if (pan) {
				const phase = (elapsed / durationMs) * Math.PI * 2
				const zoom = base.zoom * (0.85 + 0.15 * (1 + Math.sin(phase * 1.7)) * 0.5)
				emit(
					HarnessMessage.RequestedCamera({
						viewport: {
							x: base.x + Math.sin(phase) * 400,
							y: base.y + Math.cos(phase) * 250,
							zoom,
						},
					}),
				)
			}
			if (elapsed < durationMs) {
				requestAnimationFrame(tick)
				return
			}
			observer.disconnect()
			if (pan) emit(HarnessMessage.RequestedCamera({ viewport: base }))
			const samples = deltas.slice(1)
			const sorted = [...samples].sort((a, b) => a - b)
			const native = percentile(sorted, 10)
			resolve({
				durationMs: Math.round(elapsed),
				frames: samples.length,
				fps: samples.length / (elapsed / 1000),
				frameP50: percentile(sorted, 50),
				frameP95: percentile(sorted, 95),
				droppedFrames: samples.filter((d) => d > native * 1.5).length,
				longTasks: longTasks.length,
				totalBlockingMs: longTasks.reduce((sum, entry) => sum + Math.max(0, entry.duration - 50), 0),
			})
		}
		requestAnimationFrame(tick)
	})

interface SmBench {
	ready: boolean
	readyMs: number | null
	run: (options?: { durationMs?: number; pan?: boolean }) => Promise<FrameReport>
	setCamera: (viewport: Camera) => void
	fitCamera: () => void
	getCamera: () => Camera
	waitForQuiet: (options?: { maxMs?: number; quietMs?: number }) => Promise<boolean>
}

declare global {
	interface Window {
		__smBench?: SmBench
	}
}

const install = (root: Element, emit: (message: HarnessMessage) => void) => {
	const settleStart = performance.now()
	const harness: SmBench = {
		ready: false,
		readyMs: null,
		run: ({ durationMs = 5000, pan = true } = {}) => runFrames(root, emit, durationMs, pan),
		setCamera: (viewport) => emit(HarnessMessage.RequestedCamera({ viewport })),
		fitCamera: () => emit(HarnessMessage.RequestedFit()),
		getCamera: () => readCamera(root),
		waitForQuiet: ({ maxMs = 15_000, quietMs = 750 } = {}) => waitForQuiet(root, maxMs, quietMs),
	}
	window.__smBench = harness
	const frame = { id: 0 }
	const check = () => {
		if (isReady(root) || performance.now() - settleStart > 45_000) {
			harness.readyMs = Math.round(performance.now() - settleStart)
			harness.ready = true
			return
		}
		frame.id = requestAnimationFrame(check)
	}
	frame.id = requestAnimationFrame(check)
	return () => {
		cancelAnimationFrame(frame.id)
		if (window.__smBench === harness) delete window.__smBench
	}
}

/**
 * Installs `window.__smBench` on the bench root; its camera requests return as Messages. The
 * owner registers it in its Composition's `mounts` and merges `AttachBenchHarness.layer`.
 */
export const AttachBenchHarness = Mount.defineStream("AttachBenchHarness", {
	messages: [HarnessMessage.RequestedCamera, HarnessMessage.RequestedFit],
	handler: function* () {
		return ({ element }) =>
			Stream.callback<HarnessMessage>((queue) =>
				Effect.acquireRelease(
					Effect.sync(() => install(element, (message) => Queue.offerUnsafe(queue, message))),
					(release) => Effect.sync(release),
				).pipe(Effect.flatMap(() => Effect.never)),
			)
	},
})

export type AttachBenchHarnessRequirement = Mount.RequirementsOf<typeof AttachBenchHarness>

/** Resolves once no DOM mutation has landed for `quietMs` (the render has settled). */
const waitForQuiet = (root: Element, maxMs: number, quietMs: number) =>
	new Promise<boolean>((resolve) => {
		const start = performance.now()
		const last = { change: performance.now() }
		const observer = new MutationObserver(() => {
			last.change = performance.now()
		})
		observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true })
		const poll = () => {
			const now = performance.now()
			if (now - last.change >= quietMs || now - start >= maxMs) {
				observer.disconnect()
				resolve(now - last.change >= quietMs)
				return
			}
			setTimeout(poll, 100)
		}
		setTimeout(poll, 100)
	})

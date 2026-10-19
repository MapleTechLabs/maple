import type { ReplayEngine, ReplayEngineFactory } from "@maple/web/components/replays/engine/replay-engine"
import { Effect, Queue, Stream } from "effect"
import { deriveMeta } from "./replay-meta"
import type { ReplayFormat } from "./replay-window"

// `ReplayPlayerProvider`'s engine half as a Mount stream: the engine mounts into the element, the
// Model drives it through data attributes (a nonce'd transport action, speed, skip-idle, hold),
// and later ranges arrive as `REPLAY_EVENTS` DOM events from feed Mounts beside it.

export const CONTROL_ATTRIBUTE = "replay-control"
export const SPEED_ATTRIBUTE = "replay-speed"
export const SKIP_ATTRIBUTE = "replay-skip"
export const HOLD_ATTRIBUTE = "replay-hold"
export const TOTAL_ATTRIBUTE = "replay-total"
/** Dispatched on the surface by a feed Mount, `detail` the range's events. */
export const REPLAY_EVENTS = "maple:replay-events"

export type TransportAction = "play" | "pause" | "resume" | "replay"

/** `nonce|action|offset`: a new nonce is a new instruction, so repeats still apply. */
export const controlValue = (nonce: number, action: TransportAction, offsetMs?: number): string =>
	`${nonce}|${action}|${offsetMs === undefined ? "" : String(offsetMs)}`

export type EngineArgs = Readonly<{
	events: ReadonlyArray<unknown>
	format: ReplayFormat
	/** Resume here after a seek-driven rebuild (`seekTargetMs`). */
	startAtMs: number | null
}>

export type EngineHandlers<A> = Readonly<{
	ready: (totalMs: number) => A
	ticked: (currentMs: number) => A
	finished: () => A
}>

const readNumber = (element: Element, attribute: string, fallback: number): number => {
	const value = Number(element.getAttribute(`data-${attribute}`))
	return Number.isFinite(value) ? value : fallback
}

/** Runs one engine for the element's lifetime; the element is keyed by its seed. */
export const runReplayEngine = <A>(
	element: Element,
	args: EngineArgs,
	handlers: EngineHandlers<A>,
): Stream.Stream<A> =>
	!(element instanceof HTMLElement)
		? Stream.empty
		: Stream.unwrap(
				Effect.map(
					Effect.promise(() => import("./replay-engines")),
					({ ENGINE_FACTORIES }) =>
						Stream.callback<A>((queue) =>
							Effect.acquireRelease(
								Effect.sync(() => startEngine(element, args, handlers, ENGINE_FACTORIES[args.format], (message) => {
									Queue.offerUnsafe(queue, message)
								})),
								(stop) => Effect.sync(stop),
							).pipe(Effect.flatMap(() => Effect.never)),
						),
				),
			)

const startEngine = <A>(
	mount: HTMLElement,
	args: EngineArgs,
	handlers: EngineHandlers<A>,
	factory: ReplayEngineFactory,
	emit: (message: A) => void,
): (() => void) => {
	const surface = mount.parentElement ?? mount
	const meta = deriveMeta(args.events)
	const state = { isPlaying: false, raf: 0, lastJumpedEnd: -1, lastControl: mount.getAttribute(`data-${CONTROL_ATTRIBUTE}`) }
	mount.innerHTML = ""
	// rrweb can report a resize while it is still being constructed, before `engine` is bound.
	const built: Array<ReplayEngine> = []
	const fit = () => built[0]?.fit(surface)
	const engine = factory.create({
		mount,
		events: args.events,
		fallbackViewport: { width: meta.recordedWidth || 1280, height: meta.recordedHeight || 720 },
		onFinish: () => {
			state.isPlaying = false
			cancelAnimationFrame(state.raf)
			emit(handlers.finished())
		},
		onResize: () => fit(),
	})
	built.push(engine)
	emit(handlers.ready(engine.totalTimeMs))
	engine.setSpeed(readNumber(mount, SPEED_ATTRIBUTE, 1))
	const resizes = new ResizeObserver(() => fit())
	resizes.observe(surface)
	fit()
	if (args.startAtMs !== null) {
		engine.pause(args.startAtMs)
		emit(handlers.ticked(args.startAtMs))
	}

	const tick = () => {
		const total = readNumber(mount, TOTAL_ATTRIBUTE, engine.totalTimeMs)
		const current = engine.getCurrentTimeMs()
		const gap =
			mount.getAttribute(`data-${SKIP_ATTRIBUTE}`) === "true"
				? meta.inactiveIntervals.find((interval) => current >= interval.start && current < interval.end)
				: undefined
		if (gap !== undefined && gap.end !== state.lastJumpedEnd) {
			state.lastJumpedEnd = gap.end
			engine.pause(gap.end)
			engine.play(gap.end)
			emit(handlers.ticked(gap.end))
		} else if (gap === undefined) {
			state.lastJumpedEnd = -1
			emit(handlers.ticked(Math.min(Math.max(0, current), total)))
		}
		state.raf = requestAnimationFrame(tick)
	}
	const setPlaying = (isPlaying: boolean) => {
		state.isPlaying = isPlaying
		cancelAnimationFrame(state.raf)
		if (isPlaying) state.raf = requestAnimationFrame(tick)
	}

	const applyControl = () => {
		const value = mount.getAttribute(`data-${CONTROL_ATTRIBUTE}`)
		if (value === null || value === state.lastControl) return
		state.lastControl = value
		const [, action, offset] = value.split("|")
		const offsetMs = offset === undefined || offset === "" ? undefined : Number(offset)
		const total = readNumber(mount, TOTAL_ATTRIBUTE, engine.totalTimeMs)
		if (action === "pause") {
			engine.pause(offsetMs)
			setPlaying(false)
		} else if (action === "play") {
			engine.play(offsetMs ?? 0)
			setPlaying(true)
		} else if (action === "replay") {
			engine.play(0)
			setPlaying(true)
		} else if (action === "resume") {
			const current = engine.getCurrentTimeMs()
			engine.play(current >= total ? 0 : current)
			setPlaying(true)
		}
	}
	const applyOptions = () => {
		engine.setSpeed(readNumber(mount, SPEED_ATTRIBUTE, 1))
		const isHeld = mount.getAttribute(`data-${HOLD_ATTRIBUTE}`) === "true"
		if (isHeld && state.isPlaying) engine.pause()
		if (!isHeld && state.isPlaying) engine.play(engine.getCurrentTimeMs())
	}
	const attributes = new MutationObserver((records) => {
		if (records.some((record) => record.attributeName === `data-${CONTROL_ATTRIBUTE}`)) applyControl()
		if (records.some((record) => record.attributeName !== `data-${CONTROL_ATTRIBUTE}`)) applyOptions()
	})
	attributes.observe(mount, {
		attributes: true,
		attributeFilter: [CONTROL_ATTRIBUTE, SPEED_ATTRIBUTE, HOLD_ATTRIBUTE].map((name) => `data-${name}`),
	})
	const onEvents = (event: Event) => {
		if (!(event instanceof CustomEvent) || !Array.isArray(event.detail)) return
		event.detail.forEach((item: unknown) => engine.addEvent(item))
	}
	surface.addEventListener(REPLAY_EVENTS, onEvents)

	return () => {
		cancelAnimationFrame(state.raf)
		attributes.disconnect()
		resizes.disconnect()
		surface.removeEventListener(REPLAY_EVENTS, onEvents)
		engine.destroy()
		built.length = 0
		mount.innerHTML = ""
	}
}

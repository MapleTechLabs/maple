import { Effect, Queue, Schema, Stream, Array as Arr } from "effect"
import { Mount } from "foldkit"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"

/**
 * What the scripted chart frames share: the clock their example data moves on, the noise it is
 * made from, and the plain line they draw before the chart has.
 */

export const ScriptMessage = defineMessageUnion({
	/** `byMs` of script time passed: the time since the last frame while the frame was on screen. */
	Advanced: { byMs: Schema.Number },
})
export type ScriptMessage = typeof ScriptMessage.Type

/** A tab that was in the background hands back one long frame: the script does not jump over it. */
const LONGEST_FRAME_MS = 64

/** How much script time a frame gets: three minutes on screen, then it holds what it shows. */
export const SCRIPT_MS = 180_000

/**
 * The clock: `Advanced` on animation frames, at most one per `everyMs`, while the element is on
 * screen. It stops asking for frames while the element is off screen, stops for good once it has
 * handed out `forMs` of script time, and never starts under reduced motion.
 */
export const RunClock = Mount.defineStream("RunClock", {
	args: { everyMs: Schema.Number, forMs: Schema.Number },
	messages: [ScriptMessage.Advanced],
	execute: ({ element, everyMs, forMs }) =>
		matchMedia("(prefers-reduced-motion: reduce)").matches
			? Stream.never
			: Stream.callback<ScriptMessage>((queue) =>
					Effect.acquireRelease(
						Effect.sync(() => {
							const clock = { onScreen: false, frame: 0, last: 0, spentMs: 0 }
							const step = (now: number) => {
								clock.frame = 0
								// A frame left on screen for minutes has told its story: it rests.
								if (!clock.onScreen || clock.spentMs >= forMs) return
								const byMs = clock.last === 0 ? 0 : now - clock.last
								if (clock.last === 0 || byMs >= everyMs) {
									clock.last = now
									if (byMs > 0) {
										const passed = Math.min(LONGEST_FRAME_MS, byMs)
										clock.spentMs += passed
										Queue.offerUnsafe(queue, ScriptMessage.Advanced({ byMs: passed }))
									}
								}
								clock.frame = requestAnimationFrame(step)
							}
							const observer = new IntersectionObserver(
								(entries) => {
									clock.onScreen = Arr.some(entries, (entry) => entry.isIntersecting)
									// Coming back on screen starts from now, not from when it left.
									if (!clock.onScreen) clock.last = 0
									else if (clock.frame === 0) clock.frame = requestAnimationFrame(step)
								},
								{ threshold: 0.4 },
							)
							observer.observe(element)
							return () => {
								observer.disconnect()
								cancelAnimationFrame(clock.frame)
							}
						}),
						(stop) => Effect.sync(stop),
					).pipe(Effect.flatMap(() => Effect.never)),
				),
})

/** How long a shown value takes to cover half of what separates it from its target. */
const HALF_LIFE_MS = 90

/** `shown` a frame closer to `target`: fast at first, settling, the same at any frame rate. */
export const follow = (shown: number, target: number, byMs: number): number => {
	const next = target - (target - shown) * 0.5 ** (byMs / HALF_LIFE_MS)
	return Math.abs(target - next) < 0.01 ? target : next
}

/**
 * The wait before arrival `index`, between `quick` and `slow`: mostly short with the odd long one,
 * so arrivals bunch and pause the way traffic does.
 */
export const gapMs = (index: number, quick: number, slow: number): number =>
	quick + noise(index + 7) ** 2 * (slow - quick)

/** The same value for the same seed, in [0, 1): the server and the browser draw one frame. */
export const noise = (seed: number): number => {
	const x = Math.sin(seed * 9301 + 49297) * 233280
	return x - Math.floor(x)
}

const attributes = <Message>(
	h: HtmlBuilder<Message>,
	pairs: ReadonlyArray<readonly [string, string]>,
): ReadonlyArray<Attribute<Message>> => Arr.map(pairs, ([name, value]) => h.Attribute(name, value))

/** `values` as a path across a 100 by 100 box, `max` at the top. */
const linePath = (values: ReadonlyArray<number>, max: number): string =>
	Arr.map(values, (value, index) => {
		const x = values.length < 2 ? 0 : (index / (values.length - 1)) * 100
		const y = 100 - (value / Math.max(1, max)) * 100
		return `${index === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`
	}).join(" ")

/**
 * The series as plain lines, inset like a chart's plot area: what a reader without JavaScript
 * sees in the chart's place. With JavaScript the box stays clear until the chart fades in.
 */
export const linePreview = <Message>(
	h: HtmlBuilder<Message>,
	lines: ReadonlyArray<Readonly<{ values: ReadonlyArray<number>; color: string }>>,
	className: string,
): Html => {
	const max = Math.max(1, ...Arr.flatMap(lines, (line) => line.values)) * 1.1
	return h.svg(
		[
			h.AriaHidden(true),
			...attributes(h, [
				["viewBox", "0 0 100 100"],
				["preserveAspectRatio", "none"],
				["class", `live-plot-preview ${className}`],
			]),
		],
		Arr.map(lines, (line) =>
			h.path(
				attributes(h, [
					["d", linePath(line.values, max)],
					["fill", "none"],
					["stroke", line.color],
					["stroke-width", "1.5"],
					["vector-effect", "non-scaling-stroke"],
				]),
			),
		),
	)
}

/**
 * The chart's own layer over its box. It is clear until the chart has drawn and then fades in, so
 * the chart arrives whole instead of popping in over an empty box.
 */
export const plotLayer = <Message>(
	h: HtmlBuilder<Message>,
	isDrawn: boolean,
	plot: ReadonlyArray<Html>,
): Html =>
	h.div([h.Class("live-plot absolute inset-0"), ...(isDrawn ? [h.DataAttribute("drawn", "")] : [])], plot)

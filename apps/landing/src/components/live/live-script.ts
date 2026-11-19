import { Duration, Effect, Schema, Stream, Array as Arr } from "effect"
import { Mount } from "foldkit"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"

/**
 * What the scripted chart frames share: the clock that steps their example data, the noise it is
 * made from, and the plain line they draw before the chart has.
 */

export const ScriptMessage = defineMessageUnion({
	Ticked: {},
})
export type ScriptMessage = typeof ScriptMessage.Type

/** Whether the element is on screen, kept current for as long as the scope lives. */
const watchVisibility = (element: Element) =>
	Effect.acquireRelease(
		Effect.sync(() => {
			const seen = { onScreen: false }
			const observer = new IntersectionObserver(
				(entries) => {
					seen.onScreen = Arr.some(entries, (entry) => entry.isIntersecting)
				},
				{ threshold: 0.4 },
			)
			observer.observe(element)
			return { seen, observer }
		}),
		({ observer }) => Effect.sync(() => observer.disconnect()),
	)

/** `Ticked` every `everyMs` while the element is on screen. Never under reduced motion. */
export const RunScript = Mount.defineStream("RunScript", {
	args: { everyMs: Schema.Number },
	messages: [ScriptMessage.Ticked],
	execute: ({ element, everyMs }) =>
		matchMedia("(prefers-reduced-motion: reduce)").matches
			? Stream.never
			: Stream.scoped(
					Stream.unwrap(
						Effect.map(watchVisibility(element), ({ seen }) =>
							Stream.tick(Duration.millis(everyMs)).pipe(
								Stream.filter(() => seen.onScreen),
								Stream.map(() => ScriptMessage.Ticked()),
							),
						),
					),
				),
})

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
 * The series as plain lines, inset like a chart's plot area: what the server renders and what
 * shows until the chart has drawn over it.
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
				["class", className],
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

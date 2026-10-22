import type { Html, HtmlBuilder } from "foldkit/html"
import {
	GAUGE_CENTER,
	type GaugeOptions,
	gaugeGeometry,
	LABEL_FONT_SIZE,
	polar,
	R_TICK_INNER,
	R_TICK_OUTER,
	VALUE_Y,
} from "./gauge"

// The gauge widget's dial, as SVG.

const attrs = <M>(h: HtmlBuilder<M>, entries: Readonly<Record<string, string | number>>) =>
	Object.entries(entries).map(([name, value]) => h.Attribute(name, String(value)))

/** `useId().replace(/:/g, "")` of the first gauge: Base UI ids are not compared, so any stable id does. */
export const gaugeDial = <M>(
	h: HtmlBuilder<M>,
	glowId: string,
	value: unknown,
	options: GaugeOptions,
): Html => {
	const g = gaugeGeometry(value, options)
	const { x: cx, y: cy, holeRadius } = GAUGE_CENTER
	return h.svg(
		[
			...attrs(h, {
				viewBox: `${g.box.x} ${g.box.y} ${g.box.width} ${g.box.height}`,
				preserveAspectRatio: "xMidYMid meet",
				role: "img",
				"aria-label": `Gauge: ${g.formattedValue}`,
			}),
			h.Class("h-full w-full"),
		],
		[
			h.defs(
				[],
				[
					h.filter(
						attrs(h, {
							id: `glow-${glowId}`,
							x: "-40%",
							y: "-40%",
							width: "180%",
							height: "180%",
						}),
						[h.feGaussianBlur(attrs(h, { stdDeviation: "3" }))],
					),
					h.radialGradient(attrs(h, { id: `hole-${glowId}`, cx: "0.5", cy: "0.46", r: "0.6" }), [
						h.stop(
							attrs(h, { offset: "0%", "stop-color": "var(--muted)", "stop-opacity": 0.55 }),
						),
						h.stop(attrs(h, { offset: "100%", "stop-color": "var(--muted)", "stop-opacity": 0 })),
					]),
				],
			),
			h.circle(attrs(h, { cx, cy, r: holeRadius, fill: `url(#hole-${glowId})` })),
			h.g(
				attrs(h, { filter: `url(#glow-${glowId})`, opacity: 0.7 }),
				g.segments.flatMap((segment) =>
					segment.filled
						? [h.polygon(attrs(h, { points: segment.points, fill: segment.color }))]
						: [],
				),
			),
			...g.segments.map((segment) =>
				h.polygon(
					attrs(h, {
						points: segment.points,
						fill: segment.filled ? segment.color : "var(--muted-foreground)",
						"fill-opacity": segment.filled ? 1 : 0.22,
					}),
				),
			),
			...g.rim.map((segment) =>
				h.line(
					attrs(h, {
						x1: segment.a.x,
						y1: segment.a.y,
						x2: segment.b.x,
						y2: segment.b.y,
						stroke: segment.color,
						"stroke-width": 1.7,
						"stroke-linecap": "round",
					}),
				),
			),
			...g.ticks.map((tick) => {
				const inner = polar(R_TICK_INNER, tick.angle)
				const outer = polar(R_TICK_OUTER, tick.angle)
				return h.line(
					attrs(h, {
						x1: inner.x,
						y1: inner.y,
						x2: outer.x,
						y2: outer.y,
						stroke: "var(--muted-foreground)",
						"stroke-opacity": 0.55,
						"stroke-width": 1.4,
						"stroke-linecap": "round",
					}),
				)
			}),
			...g.labels.map((label) =>
				h.text(
					[
						...attrs(h, {
							x: label.x,
							y: label.y,
							"text-anchor": "middle",
							"dominant-baseline": "central",
						}),
						h.Class("fill-muted-foreground"),
						h.Style({ "font-size": `${LABEL_FONT_SIZE}px` }),
					],
					[label.text],
				),
			),
			h.text(
				[
					...attrs(h, {
						x: cx,
						y: VALUE_Y,
						"text-anchor": "middle",
						"dominant-baseline": "central",
					}),
					h.Class("fill-foreground"),
					h.Style({
						"font-size": `${g.valueFontSize}px`,
						"font-weight": "600",
						"letter-spacing": "-0.02em",
					}),
				],
				[g.formattedValue],
			),
		],
	)
}

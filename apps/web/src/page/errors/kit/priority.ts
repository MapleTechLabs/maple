import type { Html, HtmlBuilder } from "foldkit/html"

// Issue priority: its labels, the bars icon and the clamp.

export type PriorityLevel = 0 | 1 | 2 | 3 | 4

export const PRIORITY_LABEL = {
	0: "No priority",
	1: "Urgent",
	2: "High",
	3: "Medium",
	4: "Low",
} satisfies Record<PriorityLevel, string>

const LEVELS: ReadonlyArray<PriorityLevel> = [0, 1, 2, 3, 4]

export const clampPriority = (value: number): PriorityLevel =>
	Number.isFinite(value) ? (LEVELS[Math.min(4, Math.max(0, Math.trunc(value)))] ?? 0) : 0

const attrs = <M>(h: HtmlBuilder<M>, entries: ReadonlyArray<readonly [string, string]>) =>
	entries.map(([name, value]) => h.Attribute(name, value))

const BARS = [
	{ x: 3, h: 7 },
	{ x: 10, h: 12 },
	{ x: 17, h: 17 },
]

/** Dots for none, the orange alert square for urgent, one to three bars below that. */
export const priorityBarsIcon = <M>(h: HtmlBuilder<M>, level: PriorityLevel, size = 16): Html => {
	const svg = (children: ReadonlyArray<Html>) =>
		h.svg(
			attrs(h, [
				["xmlns", "http://www.w3.org/2000/svg"],
				["viewBox", "0 0 24 24"],
				["width", String(size)],
				["height", String(size)],
				["fill", "none"],
				["role", "img"],
				["aria-label", PRIORITY_LABEL[level]],
			]),
			children,
		)
	if (level === 0) {
		return svg(
			[4, 12, 20].map((cx) =>
				h.circle(
					attrs(h, [
						["cx", String(cx)],
						["cy", "12"],
						["r", "2"],
						["fill", "currentColor"],
						["opacity", "0.55"],
					]),
				),
			),
		)
	}
	if (level === 1) {
		const rect = (entries: ReadonlyArray<readonly [string, string]>) => h.rect(attrs(h, entries))
		return svg([
			rect([
				["x", "2"],
				["y", "2"],
				["width", "20"],
				["height", "20"],
				["rx", "5"],
				["fill", "oklch(0.70 0.18 55)"],
			]),
			rect([
				["x", "11"],
				["y", "6"],
				["width", "2"],
				["height", "8"],
				["rx", "1"],
				["fill", "white"],
			]),
			rect([
				["x", "11"],
				["y", "16"],
				["width", "2"],
				["height", "2"],
				["rx", "1"],
				["fill", "white"],
			]),
		])
	}
	const filled = level === 2 ? 3 : level === 3 ? 2 : 1
	return svg(
		BARS.map((bar, index) =>
			h.rect(
				attrs(h, [
					["x", String(bar.x)],
					["y", String(20 - bar.h)],
					["width", "4"],
					["height", String(bar.h)],
					["rx", "1"],
					["fill", "currentColor"],
					["opacity", index < filled ? "1" : "0.2"],
				]),
			),
		),
	)
}

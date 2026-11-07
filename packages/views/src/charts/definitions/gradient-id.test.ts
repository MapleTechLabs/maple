import { createChartScene } from "@tanstack/charts"
import { renderChartSvg } from "@tanstack/charts/svg"
import { Array as Arr, String as Str } from "effect"
import { describe, expect, test } from "vitest"
import { gradientId } from "./gradient-id"
import { buildSparkline } from "./sparkline"

// Real chart ids from callers: raw routes, spaces, parens, braces, unicode.
const NASTY = [
	"endpoint-GET (unmatched)",
	"GET /users/{id}",
	"spark caf\u00e9 \u2713",
	"a b",
	"a_b",
	"a\u00a0b",
]

const sparkScene = (chartId: string) => {
	const { definition } = buildSparkline({
		_tag: "Sparkline",
		values: [1, 4, 2, 5],
		color: "#0af",
		gradientId: `spark-${chartId}`,
		fillStart: 0.5,
		fillEnd: 0.1,
		revision: 0,
		curve: "linear",
	})
	// The sparkline is a static definition; a responsive one has a `chart` builder instead.
	if ("chart" in definition) return expect.unreachable("sparkline definition is responsive")
	return createChartScene(definition, { width: 120, height: 32 })
}

/** Every `url(#...)` paint in the markup, the way the canvas painter parses it. */
const paintRefs = (markup: string) =>
	Arr.map(Arr.fromIterable(Str.matchAll(/url\(#([^)]+)\)/g)(markup)), (match) => match[1])

describe("gradient ids", () => {
	test("ids built from caller text only use characters both renderers keep", () => {
		for (const raw of NASTY) expect(gradientId("spark", raw)).toMatch(/^[A-Za-z0-9_-]+$/)
	})

	test("distinct caller ids never collapse onto the same gradient", () => {
		const ids = Arr.map(NASTY, (raw) => gradientId("spark", raw))
		expect(new Set(ids).size).toBe(NASTY.length)
	})

	test("an id that is already safe is kept as is", () => {
		expect(gradientId("qbArea", "chart-1", "partial")).toBe("qbArea-chart-1-partial")
	})

	test.each(NASTY)("a sparkline for %j paints its fill from a gradient the scene defines", (chartId) => {
		const scene = sparkScene(chartId)
		const defined = new Set(Arr.map(scene.gradients, (gradient) => gradient.id))
		const svg = renderChartSvg(scene, { ariaLabel: "Trend", idPrefix: "t" })
		const refs = paintRefs(svg)
		expect(refs.length).toBeGreaterThan(0)
		for (const ref of refs) expect(svg).toContain(`id="${ref}"`)
		for (const gradient of defined) expect(`url(#${gradient})`).toMatch(/^url\(#([^)]+)\)$/)
	})
})

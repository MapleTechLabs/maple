import { areaY, defineChart } from "@tanstack/charts"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { afterEach, describe, expect, it, vi } from "vitest"

import { verticalGradient } from "../plot-paint"
import { warnUnresolvedColors } from "../plot-colors-guard"

/** A definition that points at itself — the walk must not loop on it. */
interface CyclicDefinition {
	stroke: string
	self?: CyclicDefinition
}

/** A definition nested well past the walk's depth cap. */
type NestedDefinition = { stroke: string } | { nested: NestedDefinition }

interface Row {
	at: number
	value: number
}

const rows: Row[] = [
	{ at: 0, value: 1 },
	{ at: 1, value: 2 },
]

/** Silences the guard's own output while asserting on it. */
function captureErrors() {
	return vi.spyOn(console, "error").mockImplementation(() => {})
}

/** Both axes linear, as the shipped sparkline configures them. */
const SCALES = { x: { scale: scaleLinear }, y: { scale: scaleLinear } }

afterEach(() => {
	vi.restoreAllMocks()
})

/**
 * The guard catches ONE thing: a bare `--token` where a colour belongs, which
 * the canvas paint resolver throws on rather than mispaints. The tests below are
 * built from real `defineChart` output so they measure what the guard can
 * actually reach — the definition's plain structure — instead of the invented
 * `{ marks: [{ stroke }] }` shape the library has never produced, which is how
 * the previous suite passed while the guard was blind.
 */
describe("warnUnresolvedColors", () => {
	it("catches a bare token in a real chart's gradients", () => {
		const errors = captureErrors()
		const definition = defineChart({
			marks: [
				areaY(rows, {
					x: (row: Row) => row.at,
					y: (row: Row) => row.value,
					fill: "url(#band)",
				}),
			],
			gradients: [verticalGradient("band", "--chart-p95")],
			scales: SCALES,
		})

		warnUnresolvedColors(definition, "Latency")

		expect(errors).toHaveBeenCalledTimes(2) // one per gradient stop
		expect(errors.mock.calls[0]?.[0]).toMatch(/Latency.*--chart-p95.*definition\.gradients\[0\]/s)
	})

	it("passes a real chart whose gradient colours are resolved literals", () => {
		const errors = captureErrors()
		const definition = defineChart({
			marks: [areaY(rows, { x: (row: Row) => row.at, y: (row: Row) => row.value })],
			gradients: [verticalGradient("band", "oklch(0.7 0.1 250)")],
			scales: SCALES,
		})

		warnUnresolvedColors(definition, "Latency")

		expect(errors).not.toHaveBeenCalled()
	})

	it("leaves var() and currentColor alone — canvas resolves both", () => {
		// The canvas paint resolver assigns each paint to a probe span and reads the
		// computed colour back, so both are valid input; the library's own theme
		// defaults are built from them.
		const errors = captureErrors()

		warnUnresolvedColors({ theme: { foreground: "currentColor", palette: ["var(--chart-1)"] } }, "chart")

		expect(errors).not.toHaveBeenCalled()
	})

	it("reports a broken token instead of throwing", () => {
		const errors = captureErrors()
		warnUnresolvedColors({ gradients: [{ stops: [{ color: "--x" }] }] }, "c")
		expect(errors).toHaveBeenCalledTimes(1)
	})

	it("survives a self-referential definition", () => {
		const errors = captureErrors()
		const definition: CyclicDefinition = { stroke: "#fff" }
		definition.self = definition

		expect(() => warnUnresolvedColors(definition, "c")).not.toThrow()
		expect(errors).not.toHaveBeenCalled()
	})

	it("stops at the depth cap rather than walking a deep object forever", () => {
		// Nested well past MAX_WALK_DEPTH (6): the guard is a cheap dev tripwire,
		// not an exhaustive validator.
		const errors = captureErrors()
		let deep: NestedDefinition = { stroke: "--too-deep" }
		for (let i = 0; i < 12; i += 1) deep = { nested: deep }

		warnUnresolvedColors(deep, "c")

		expect(errors).not.toHaveBeenCalled()
	})
})

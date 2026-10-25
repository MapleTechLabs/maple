import { describe, expect, test } from "vitest"
import { computePosition } from "./anchor"

const viewport = { width: 1440, height: 900 }

// Expected values are what Base UI's positioner writes for the same inputs.
describe("computePosition", () => {
	test("a menu above its trigger, start-aligned (the user menu)", () => {
		expect(
			computePosition({
				side: "top",
				align: "start",
				sideOffset: 4,
				alignOffset: 0,
				anchor: { x: 8, y: 860, width: 203, height: 32 },
				popup: { width: 224, height: 134 },
				viewport,
				dpr: 1,
			}),
		).toMatchObject({
			x: 8,
			y: 722,
			availableWidth: 1430,
			availableHeight: 851,
			anchorWidth: 203,
			anchorHeight: 32,
			transformOrigin: "0% calc(100% + 4px)",
		})
	})

	test("a menu right of its trigger (the org switcher)", () => {
		expect(
			computePosition({
				side: "right",
				align: "start",
				sideOffset: 4,
				alignOffset: 0,
				anchor: { x: 8, y: 8, width: 239, height: 48 },
				popup: { width: 239, height: 96 },
				viewport,
				dpr: 1,
			}),
		).toMatchObject({
			x: 251,
			y: 8,
			availableWidth: 1184,
			availableHeight: 890,
			transformOrigin: "-4px 0%",
		})
	})

	test("a menu that does not fit above flips below its trigger", () => {
		expect(
			computePosition({
				side: "top",
				align: "start",
				sideOffset: 4,
				alignOffset: 0,
				anchor: { x: 8, y: 20, width: 100, height: 32 },
				popup: { width: 224, height: 134 },
				viewport,
				dpr: 1,
			}),
		).toMatchObject({ side: "bottom", y: 56, transformOrigin: "0% -4px" })
	})
})

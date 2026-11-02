import { describe, expect, test } from "vitest"
import { ditherLevel, fieldAt } from "./dither-field"

const litShare = (reach: number, seconds = 0): number => {
	const size = 64
	const cells = Array.from({ length: size * size }, (_, index) => {
		const column = index % size
		const row = Math.floor(index / size)
		return ditherLevel(column, row, fieldAt(column / size, row / size, seconds, reach))
	})
	return cells.filter((level) => level > 0).length / cells.length
}

describe("dither field", () => {
	test("lights the bottom-left corner and leaves the top-right dark", () => {
		const blockShare = (left: number, top: number) => {
			const levels = Array.from({ length: 64 }, (_, index) => {
				const column = left + (index % 8)
				const row = top + Math.floor(index / 8)
				return ditherLevel(column, row, fieldAt(column / 64, row / 64, 0, 0.55))
			})
			return levels.filter((level) => level > 0).length / levels.length
		}
		expect(blockShare(0, 56)).toBeGreaterThan(0.8)
		expect(blockShare(56, 0)).toBe(0)
	})

	test("a further reach lights more of the field, as each onboarding step does", () => {
		const shares = [0.55, 0.75, 0.95, 1.2].map((reach) => litShare(reach))
		expect(shares).toEqual([...shares].sort((a, b) => a - b))
		expect(shares[0]).toBeLessThan(0.35)
		expect(shares[3]).toBeGreaterThan(shares[0] + 0.2)
	})

	test("the edge moves over time without the field filling up or emptying", () => {
		const now = litShare(0.75, 0)
		const later = litShare(0.75, 9)
		expect(later).not.toBe(now)
		expect(Math.abs(later - now)).toBeLessThan(0.1)
	})
})

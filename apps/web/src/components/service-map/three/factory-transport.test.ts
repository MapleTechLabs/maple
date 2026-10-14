import { describe, expect, it } from "vitest"
import { cargoCount } from "./factory-transport"

describe("belt cargo", () => {
	it("loads longer and busier belts more densely", () => {
		expect(cargoCount(10, 1000)).toBeGreaterThan(cargoCount(10, 1))
		expect(cargoCount(20, 50)).toBeGreaterThan(cargoCount(5, 50))
	})
	it("keeps every belt between 3 and 44 pieces of cargo", () => {
		expect(cargoCount(0.5, 0)).toBe(3)
		expect(cargoCount(400, 1e6)).toBe(44)
	})
})

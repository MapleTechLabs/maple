import { describe, expect, it } from "vitest"
import { migrations } from "./migrations"
import { Array as Arr } from "effect"

describe("migrations", () => {
	it("migration versions are unique and contiguous from 1", () => {
		const versions = Arr.map(migrations, (m) => m.version)
		expect(new Set(versions).size).toBe(versions.length)
		expect([...versions].sort((a, b) => a - b)).toEqual(
			Array.from({ length: versions.length }, (_, i) => i + 1),
		)
	})
})

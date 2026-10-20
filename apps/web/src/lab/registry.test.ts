import { describe, expect, it } from "vitest"

import { labEntryPaths } from "./boot"
import { LAB_ENTRIES, LAB_ROOT, isLabPath, isSessionlessLabPath } from "./registry"

// `index` is `/lab` itself; `data-probe` is the S6 spike, not listed.
const UNLISTED = new Set([`${LAB_ROOT}/index`, `${LAB_ROOT}/data-probe`])
const entryPaths = labEntryPaths().filter((path) => !UNLISTED.has(path))

describe("lab registry", () => {
	it("lists exactly the lab entry modules", () => {
		const registered = LAB_ENTRIES.map((entry) => entry.path).sort()
		expect(registered).toEqual([...entryPaths].sort())
	})

	it("has unique paths", () => {
		const paths = LAB_ENTRIES.map((entry) => entry.path)
		expect(new Set(paths).size).toBe(paths.length)
	})

	it("classifies lab paths", () => {
		expect(isLabPath("/lab")).toBe(true)
		expect(isLabPath("/lab/widgets")).toBe(true)
		expect(isLabPath("/labs-admin")).toBe(false)
		expect(isSessionlessLabPath("/lab")).toBe(true)
		expect(isSessionlessLabPath("/lab/bench/logs")).toBe(true)
		expect(isSessionlessLabPath("/lab/query-builder")).toBe(false)
		expect(isSessionlessLabPath("/lab/nope")).toBe(false)
	})
})

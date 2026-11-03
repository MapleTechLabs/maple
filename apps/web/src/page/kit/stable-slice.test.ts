import { describe, expect, test } from "vitest"
import { stableSlice } from "./stable-slice"

type Source = Readonly<{ rows: ReadonlyArray<string>; draft: string; other: number }>

describe("stableSlice", () => {
	const rows = ["a", "b"]
	const select = (source: Source) => ({ rows: source.rows, draft: source.draft })

	test("returns the previous slice while every picked field is the same", () => {
		const sliceOf = stableSlice(select)
		const first = sliceOf({ rows, draft: "x", other: 1 })
		expect(sliceOf({ rows, draft: "x", other: 2 })).toBe(first)
	})

	test("returns a new slice when a picked field changes, compared by reference", () => {
		const sliceOf = stableSlice(select)
		const first = sliceOf({ rows, draft: "x", other: 1 })
		const edited = sliceOf({ rows, draft: "y", other: 1 })
		expect(edited).not.toBe(first)
		expect(edited.draft).toBe("y")
		expect(sliceOf({ rows: [...rows], draft: "y", other: 1 })).not.toBe(edited)
	})
})

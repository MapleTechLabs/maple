import { Array as Arr } from "effect"
import { describe, expect, test } from "vitest"
import { reuseUnchangedRows, stableSlice, stableValue } from "./stable-slice"

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

describe("stableValue", () => {
	test("returns the previous value while the next one is structurally equal", () => {
		const valueOf = stableValue((n: number) => ({ label: "rule", ids: [n % 2] }))
		const first = valueOf(2)
		expect(valueOf(4)).toBe(first)
		expect(valueOf(3)).toEqual({ label: "rule", ids: [1] })
	})
})

describe("reuseUnchangedRows", () => {
	type Row = Readonly<{ id: string; value: number }>
	const keyOf = (row: Row) => row.id
	const previous: ReadonlyArray<Row> = [
		{ id: "a", value: 1 },
		{ id: "b", value: 2 },
	]

	test("a resend of equal copies is the previous array", () => {
		const copies = Arr.map(previous, (row) => ({ ...row }))
		expect(reuseUnchangedRows(previous, copies, keyOf)).toBe(previous)
	})

	test("keeps unchanged rows by reference and takes the changed and new ones", () => {
		const next = reuseUnchangedRows(
			previous,
			[
				{ id: "b", value: 3 },
				{ id: "a", value: 1 },
				{ id: "c", value: 4 },
			],
			keyOf,
		)
		expect(Arr.map(next, (row) => row.value)).toEqual([3, 1, 4])
		expect(next[1]).toBe(previous[0])
		expect(next[0]).not.toBe(previous[1])
	})

	test("a reorder of the same rows is a new array of the previous objects", () => {
		const reversed = Arr.reverse(Arr.map(previous, (row) => ({ ...row })))
		const next = reuseUnchangedRows(previous, reversed, keyOf)
		expect(next).not.toBe(previous)
		expect(next[0]).toBe(previous[1])
	})
})

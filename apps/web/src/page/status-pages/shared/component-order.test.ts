import { Array as Arr } from "effect"
import { describe, expect, test } from "vitest"
import { component, componentId } from "./test-pages"
import { moved, movedGroup } from "./component-order"

const ids = (rows: ReadonlyArray<{ readonly id: string }> | null) =>
	rows === null ? null : Arr.map(rows, (row) => row.id)

describe("moved", () => {
	const rows = [component(1), component(2), component(3), component(4)]

	test("puts the component at the index, the rows between shifting a slot", () => {
		expect(ids(moved(rows, componentId(1), 2))).toEqual([
			componentId(2),
			componentId(3),
			componentId(1),
			componentId(4),
		])
		expect(ids(moved(rows, componentId(4), 1))).toEqual([
			componentId(1),
			componentId(4),
			componentId(2),
			componentId(3),
		])
	})

	test("one slot either way swaps it with its neighbour", () => {
		expect(ids(moved(rows, componentId(2), 2))).toEqual([
			componentId(1),
			componentId(3),
			componentId(2),
			componentId(4),
		])
		expect(ids(moved(rows, componentId(2), 0))).toEqual([
			componentId(2),
			componentId(1),
			componentId(3),
			componentId(4),
		])
	})

	test("an index past either end of the group lands at that end", () => {
		expect(ids(moved(rows, componentId(2), 99))).toEqual([
			componentId(1),
			componentId(3),
			componentId(4),
			componentId(2),
		])
		expect(ids(moved(rows, componentId(3), -5))).toEqual([
			componentId(3),
			componentId(1),
			componentId(2),
			componentId(4),
		])
	})

	test("moves only within its group, every other group keeping its places in the page order", () => {
		const grouped = [
			component(1, { group: "Core" }),
			component(2, { group: "Edge" }),
			component(3, { group: "Core" }),
			component(4),
			component(5, { group: "Core" }),
		]
		expect(ids(moved(grouped, componentId(5), 0))).toEqual([
			componentId(5),
			componentId(2),
			componentId(1),
			componentId(4),
			componentId(3),
		])
	})

	test("is null when nothing would move or the component is not listed", () => {
		expect(moved(rows, componentId(2), 1)).toBeNull()
		expect(moved(rows, componentId(4), 7)).toBeNull()
		expect(moved(rows, componentId(1), -1)).toBeNull()
		expect(moved([component(1, { group: "Core" }), component(2)], componentId(1), 1)).toBeNull()
		expect(moved(rows, componentId(9), 0)).toBeNull()
	})
})

describe("movedGroup", () => {
	const rows = [
		component(1, { group: "Core" }),
		component(2, { group: "Edge" }),
		component(3, { group: "Core" }),
		component(4),
		component(5, { group: "Edge" }),
	]

	test("moves the group's members together to its new place, each group keeping its order", () => {
		expect(ids(movedGroup(rows, "Edge", 0))).toEqual(
			ids([rows[1]!, rows[4]!, rows[0]!, rows[2]!, rows[3]!]),
		)
		expect(ids(movedGroup(rows, null, 0))).toEqual(
			ids([rows[3]!, rows[0]!, rows[2]!, rows[1]!, rows[4]!]),
		)
	})

	test("clamps past the ends, and is null when nothing moves", () => {
		expect(ids(movedGroup(rows, "Core", 9))).toEqual(
			ids([rows[1]!, rows[4]!, rows[3]!, rows[0]!, rows[2]!]),
		)
		expect(movedGroup(rows, "Core", 0)).toBeNull()
		expect(movedGroup(rows, "Missing", 1)).toBeNull()
	})
})

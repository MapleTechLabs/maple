import { Array as Arr, Option, Order, Record as Rec } from "effect"
import { describe, expect, test } from "vitest"
import { cellKey } from "./grid"
import {
	buildingCells,
	canPlace,
	footprintCells,
	nearestFreeCell,
	occupy,
	type OccupancyWorld,
} from "./occupancy"

const keys = (cells: ReadonlyArray<{ x: number; z: number }>) =>
	Arr.sort(Arr.map(cells, cellKey), Order.String)

const worldWith = (owners: Record<string, { x: number; z: number }>): OccupancyWorld => {
	const entries = Rec.toEntries(owners)
	const occupancy = Arr.reduce(entries, new Map<string, string>(), (acc, [id, cell]) =>
		occupy(acc, id, buildingCells(cell, "processor")),
	)
	return {
		occupancy,
		buildings: new Map(Arr.map(entries, ([id]) => [id, "processor"] as const)),
		rotations: new Map(Arr.map(entries, ([id]) => [id, 0] as const)),
	}
}

describe("footprintCells", () => {
	test("an odd footprint is centred on its anchor", () => {
		expect(keys(footprintCells({ x: 5, z: 5 }, { width: 3, depth: 1 }))).toEqual(["4,5", "5,5", "6,5"])
	})

	test("a quarter turn swaps width and depth", () => {
		const flat = { width: 2, depth: 1 }
		expect(keys(footprintCells({ x: 0, z: 0 }, flat, 90))).toEqual(["0,0", "0,1"])
		expect(keys(footprintCells({ x: 0, z: 0 }, flat, 180))).toEqual(["0,0", "1,0"])
	})
})

describe("canPlace", () => {
	const world = worldWith({ a: { x: 0, z: 0 }, b: { x: 10, z: 0 } })

	test("free ground and the building's own footprint are placeable", () => {
		expect(canPlace(world, "a", { x: 0, z: 5 })).toBe(true)
		expect(canPlace(world, "a", { x: 1, z: 1 })).toBe(true)
	})

	test("another building's footprint is not", () => {
		expect(canPlace(world, "a", { x: 8, z: 0 })).toBe(false)
		expect(canPlace(world, "a", { x: 7, z: 0 })).toBe(true)
	})

	test("an unknown node cannot be placed", () => {
		expect(canPlace(world, "ghost", { x: 50, z: 50 })).toBe(false)
	})
})

describe("nearestFreeCell", () => {
	const world = worldWith({ a: { x: 0, z: 0 } })
	const machine = { width: 3, depth: 3 }

	test("a free start is its own answer", () => {
		expect(nearestFreeCell(world.occupancy, "b", { x: 9, z: 9 }, machine)).toEqual(
			Option.some({ x: 9, z: 9 }),
		)
	})

	test("a blocked start moves just clear of the blocker, the same way every time", () => {
		const first = nearestFreeCell(world.occupancy, "b", { x: 0, z: 0 }, machine)
		const again = nearestFreeCell(world.occupancy, "b", { x: 0, z: 0 }, machine)
		expect(first).toEqual(again)
		const cell = Option.getOrThrow(first)
		// The 3x3 blocker covers -1..1: the first clear anchor is 3 cells out, straight up the z axis.
		expect(cell).toEqual({ x: 0, z: -3 })
		const withB = { ...world, buildings: new Map([...world.buildings, ["b", "processor" as const]]) }
		expect(canPlace(withB, "b", cell)).toBe(true)
		expect(canPlace(withB, "b", { x: 0, z: -2 })).toBe(false)
	})
})

import { Array as Arr } from "effect"
import { describe, expect, it } from "vitest"
import { BIOMES } from "./biome"
import { wildsOf } from "./board"
import { type Cell, cellKey, disc, hexDistance } from "./hex"
import { tilePalette } from "./palette"
import { buildWild, type Feature, featureOf } from "./wild"

const board = (cells: ReadonlyArray<Cell>) =>
	new Map(Arr.map(cells, (cell, index) => [`tile-${index}`, cell] as const))
const origin: Cell = { q: 0, r: 0 }

describe("wildsOf", () => {
	it("surrounds the tiles: every free cell beside one is open country", () => {
		const wilds = wildsOf(board([origin]), [])
		const inner = Arr.filter(wilds, (wild) => wild.ring === 1)
		expect(Arr.map(inner, (wild) => hexDistance(wild.cell, origin))).toEqual([1, 1, 1, 1, 1, 1])
	})

	it("adds some, not all, of the cells one step further out", () => {
		const outer = Arr.filter(wildsOf(board(disc(origin, 1)), []), (wild) => wild.ring === 2)
		expect(outer.length).toBeGreaterThan(0)
		expect(outer.length).toBeLessThan(18)
		expect(Arr.every(outer, (wild) => hexDistance(wild.cell, origin) === 3)).toBe(true)
	})

	it("never covers a tile or a lake, and never lists a cell twice", () => {
		const tiles = disc(origin, 1)
		const lake: Cell = { q: 2, r: 0 }
		const wilds = wildsOf(board(tiles), [lake])
		const keys = Arr.map(wilds, (wild) => cellKey(wild.cell))
		expect(new Set(keys).size).toBe(keys.length)
		expect(
			Arr.filter(
				keys,
				(key) => key === cellKey(lake) || Arr.some(tiles, (tile) => cellKey(tile) === key),
			),
		).toEqual([])
	})

	it("is empty on an empty board, and ignores a tile in hand", () => {
		expect(wildsOf(board([]), [])).toEqual([])
		expect(wildsOf(board([origin]), [], "tile-0")).toEqual([])
	})
})

describe("featureOf", () => {
	const keys = Arr.makeBy(400, (index) => `${index % 20},${Math.floor(index / 20)}`)
	const meadow = BIOMES[0]
	const highland = Arr.findFirst(BIOMES, (biome) => biome.id === "highland")

	it("never raises a mountain on a cell a tile could be put on", () => {
		const beside = Arr.map(keys, (key) => featureOf(key, 1, meadow ?? BIOMES[1]!))
		expect(beside).not.toContain("mountain")
	})

	it("is the same country for the same cell every time", () => {
		expect(Arr.map(keys, (key) => featureOf(key, 2, meadow!))).toEqual(
			Arr.map(keys, (key) => featureOf(key, 2, meadow!)),
		)
	})

	it("offers every kind of country, with more mountains in rocky biomes", () => {
		const count = (features: ReadonlyArray<Feature>, feature: Feature) =>
			Arr.filter(features, (f) => f === feature).length
		const plain = Arr.map(keys, (key) => featureOf(key, 2, meadow!))
		const rocky = Arr.map(keys, (key) =>
			featureOf(key, 2, highland._tag === "Some" ? highland.value : meadow!),
		)
		expect(new Set(plain)).toEqual(new Set(["forest", "meadow", "hills", "mountain", "farm"]))
		expect(count(rocky, "mountain")).toBeGreaterThan(count(plain, "mountain"))
	})
})

describe("buildWild", () => {
	it("stands a mountain taller than anything in a meadow", () => {
		const top = (feature: Feature) => {
			const geometry = buildWild({
				key: "3,1",
				biome: BIOMES[0]!,
				feature,
				palette: tilePalette(false),
			}).geometry
			geometry.computeBoundingBox()
			return geometry.boundingBox?.max.y ?? 0
		}
		expect(top("mountain")).toBeGreaterThan(1.4)
		expect(top("mountain")).toBeGreaterThan(top("meadow"))
	})
})

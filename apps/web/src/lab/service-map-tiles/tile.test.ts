import { Array as Arr } from "effect"
import { describe, expect, it } from "vitest"
import { biomeOf, biomesFor } from "./biome"
import { tilePalette } from "./palette"
import { HEX_SIZE } from "./hex"
import { buildTile, landmarkAt, pondFor, settlementOf, type TileSpec } from "./tile"

const spec = (kind: TileSpec["kind"], size: number, corridors: ReadonlyArray<number> = []): TileSpec => ({
	id: `tile-${kind}`,
	kind,
	size,
	biome: biomeOf(biomesFor(["shop"]), "shop"),
	palette: tilePalette(false),
	corridors,
})

describe("a tile's landmark", () => {
	it("is the building a click on it lands on, and nothing a step away or at ground level", () => {
		const tile = buildTile(spec("edge", 0.5))
		const [x, z] = tile.landmark?.at ?? [0, 0]
		expect(landmarkAt(tile, [x, 0.8, z])?.kind).toBe("edge")
		expect(landmarkAt(tile, [x + 2, 0.8, z])).toBeNull()
		expect(landmarkAt(tile, [x, 0, z])).toBeNull()
	})

	it("stands on a busy village and not on a quiet one", () => {
		expect(buildTile(spec("service", 0.9)).landmark?.kind).toBe("service")
		expect(buildTile(spec("service", 0.2)).landmark).toBeNull()
	})

	it("keeps out of the way of the tile's roads", () => {
		// Roads leave east and west: the landmark must not stand on either.
		const tile = buildTile(spec("queue", 0.5, [0, Math.PI]))
		const [x, z] = tile.landmark?.at ?? [0, 0]
		expect(Math.abs(z)).toBeGreaterThan(Math.abs(x) * 0.4)
	})

	it("gives a windmill sails and no one else", () => {
		expect(buildTile(spec("queue", 0.5)).sails).not.toBeNull()
		expect(buildTile(spec("database", 0.5)).sails).toBeNull()
	})
})

describe("a tile's pond", () => {
	// A pond lies towards a corner, so the two hex sides beside that corner are what it must clear.
	const clearance = (offset: number, wanted: number) => {
		const { radius, distance } = pondFor(offset, wanted)
		const toSide = HEX_SIZE * Math.cos(Math.PI / 6) - distance * Math.cos(Math.PI / 6)
		// Its outline bends up to 16% past the radius, with a rim of sand round it.
		return toSide - (radius + 0.12) * 1.16
	}

	it("stays on its tile, sand and all, however far out its landmark stands", () => {
		const gaps = Arr.map([1.2, 1.35, 1.4, 1.45, 1.5], (offset) => clearance(offset, 1.25))
		Arr.forEach(gaps, (gap) => expect(gap).toBeGreaterThanOrEqual(-1e-9))
	})

	it("keeps the size it was asked for when there is room", () => {
		expect(pondFor(0.5, 0.6).radius).toBeCloseTo(0.6)
	})

	it("lies beyond its landmark, never on it", () => {
		const { radius, distance } = pondFor(1.35, 1.25)
		expect(distance - radius).toBeGreaterThan(1.35)
	})
})

describe("a settlement", () => {
	const sizes = Arr.makeBy(21, (index) => index / 20)

	it("grows with its service's throughput, never shrinking on the way up", () => {
		const towns = Arr.map(sizes, settlementOf)
		const grows = (read: (town: ReturnType<typeof settlementOf>) => number) =>
			Arr.every(
				Arr.zip(towns, Arr.drop(towns, 1)),
				([smaller, bigger]) => read(bigger) >= read(smaller),
			)
		expect(grows((town) => town.houses)).toBe(true)
		expect(grows((town) => town.yard)).toBe(true)
		expect(grows((town) => town.scale)).toBe(true)
		expect(settlementOf(1).houses).toBeGreaterThan(settlementOf(0).houses * 5)
	})

	it("is a hamlet at the bottom: barns and fields, no well, no church", () => {
		expect(settlementOf(0.05)).toMatchObject({
			hasWell: false,
			hasChurch: false,
			hasHall: false,
			wall: 0,
			stalls: 0,
		})
		expect(settlementOf(0.05).barnShare).toBeGreaterThan(0)
		expect(settlementOf(0.05).fields).toBeGreaterThan(0)
	})

	it("gains a well, then a church and a market, then a hall and a wall", () => {
		const has = (size: number) => {
			const town = settlementOf(size)
			return [town.hasWell, town.hasChurch, town.stalls > 0, town.hasHall, town.wall > 0]
		}
		expect(has(0.3)).toEqual([true, false, false, false, false])
		expect(has(0.6)).toEqual([true, true, true, false, false])
		expect(has(0.95)).toEqual([true, true, true, true, true])
	})

	it("keeps its wall, towers and all, on the tile", () => {
		const inradius = HEX_SIZE * Math.cos(Math.PI / 6)
		Arr.forEach(sizes, (size) => expect(settlementOf(size).wall + 0.15).toBeLessThan(inradius))
	})

	it("is built bigger: a city's tile holds several times a hamlet's geometry", () => {
		const built = (size: number) =>
			buildTile(spec("service", size)).geometry.getAttribute("position").count
		expect(built(1)).toBeGreaterThan(built(0.05) * 3)
		expect(built(0.6)).toBeGreaterThan(built(0.05))
	})
})

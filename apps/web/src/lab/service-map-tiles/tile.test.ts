import { describe, expect, it } from "vitest"
import { biomeOf, biomesFor } from "./biome"
import { tilePalette } from "./palette"
import { buildTile, landmarkAt, type TileSpec } from "./tile"

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

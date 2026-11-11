import { Array as Arr } from "effect"
import { describe, expect, it } from "vitest"
import { SPRITES } from "./art/sprites.generated"
import { BIOMES, biomeOf, biomesFor } from "./biome"
import { CORNER, lakeArt, lookOf, type ServiceSpec, serviceArt, type TileArt, wildArt } from "./pixel-layout"

const biome = biomeOf(biomesFor(["shop"]), "shop")
const spec = (
	kind: ServiceSpec["kind"],
	size: number,
	corridors: ReadonlyArray<number> = [],
): ServiceSpec => ({
	id: `tile-${kind}-${size}`,
	kind,
	size,
	biome,
	corridors,
})
const count = (art: TileArt, sprites: ReadonlyArray<string>) =>
	Arr.filter(art.items, (item) => sprites.includes(item.sprite)).length
const HOMES = ["cottageRed", "cottageBlue", "cottageThatch", "cottageSnow", "townhouse", "barn"]

describe("a service's tile in pixel art", () => {
	it("grows from a hamlet to a town with its throughput", () => {
		const [hamlet, village, city] = [
			serviceArt(spec("service", 0.05)),
			serviceArt(spec("service", 0.5)),
			serviceArt(spec("service", 1)),
		]
		expect(count(hamlet, HOMES)).toBeLessThan(count(village, HOMES))
		expect(count(village, HOMES)).toBeLessThan(count(city, HOMES))
		expect(count(hamlet, ["church", "townHall", "well"])).toBe(0)
		expect(count(city, ["church"])).toBe(1)
		expect(count(city, ["townHall"])).toBe(1)
		expect(count(city, ["townhouse"])).toBeGreaterThan(0)
	})

	it("stands the landmark its kind calls for", () => {
		expect(count(serviceArt(spec("edge", 0.5)), ["lighthouse"])).toBe(1)
		expect(count(serviceArt(spec("database", 0.5)), ["observatory"])).toBe(1)
		expect(count(serviceArt(spec("queue", 0.5)), ["windmill"])).toBe(1)
		expect(count(serviceArt(spec("external", 0.5)), ["keep"])).toBe(1)
	})

	it("gives an entry point a pond: sand first, water over it", () => {
		const grounds = Arr.map(serviceArt(spec("edge", 0.5)).patches, (patch) => patch.ground)
		expect(grounds.indexOf("sand")).toBeGreaterThanOrEqual(0)
		expect(grounds.indexOf("water")).toBeGreaterThan(grounds.indexOf("sand"))
	})

	it("keeps every sprite's foot on the tile", () => {
		Arr.forEach(["service", "edge", "database", "queue", "external"] as const, (kind) =>
			Arr.forEach(serviceArt(spec(kind, 0.9)).items, (item) =>
				expect(Math.hypot(item.x, item.y)).toBeLessThan(CORNER),
			),
		)
	})

	it("builds nothing but its square furniture on a road", () => {
		// Roads leave east and west along the x axis.
		const art = serviceArt(spec("service", 0.8, [0, Math.PI]))
		const onRoad = Arr.filter(
			art.items,
			(item) => item.sprite !== "well" && Math.abs(item.y) < 14 && Math.abs(item.x) > 30,
		)
		expect(onRoad).toEqual([])
	})

	it("is the same tile every time, and a different one for another service", () => {
		expect(serviceArt(spec("service", 0.6))).toEqual(serviceArt(spec("service", 0.6)))
		expect(serviceArt(spec("service", 0.6)).items).not.toEqual(
			serviceArt({ ...spec("service", 0.6), id: "other" }).items,
		)
	})

	it("lights every kind of tile after dark", () => {
		Arr.forEach(["service", "edge", "database", "queue", "external"] as const, (kind) =>
			expect(serviceArt(spec(kind, 0.5)).lamp).not.toBeNull(),
		)
	})
})

describe("biomes in pixel art", () => {
	it("gives every biome a ground, a cottage and trees that are on the sheet", () => {
		Arr.forEach(BIOMES, (each) => {
			const look = lookOf(each)
			Arr.forEach([look.ground, look.cottage, ...look.trees], (sprite) =>
				expect(SPRITES[sprite]).toBeDefined(),
			)
		})
		expect(new Set(Arr.map(BIOMES, (each) => lookOf(each).ground)).size).toBe(BIOMES.length)
	})
})

describe("open country and lakes in pixel art", () => {
	it("fills a forest with trees and crowns a mountain tile with peaks", () => {
		expect(wildArt("1,2", biome, "forest").items.length).toBeGreaterThan(12)
		expect(count(wildArt("1,2", biome, "mountain"), ["mountain"])).toBeGreaterThan(0)
		expect(count(wildArt("1,2", biome, "hills"), ["hill"])).toBeGreaterThan(1)
		expect(count(wildArt("1,2", biome, "farm"), ["barn"])).toBe(1)
		expect(Arr.map(wildArt("1,2", biome, "farm").patches, (patch) => patch.ground)).toContain(
			"wheatField",
		)
	})

	it("has no lamp where nobody lives", () => {
		expect(wildArt("1,2", biome, "meadow").lamp).toBeNull()
		expect(lakeArt("0,0").lamp).toBeNull()
	})

	it("makes a lake of sand, water and deep water, with reeds on the shore", () => {
		const lake = lakeArt("0,0")
		expect(Arr.map(lake.patches, (patch) => patch.ground)).toEqual(["sand", "water", "deepWater"])
		expect(count(lake, ["reeds"])).toBeGreaterThan(2)
	})
})

describe("landmarks and walls in pixel art", () => {
	it("marks the landmark a click can ring or sound, where its sprite stands", () => {
		const kinds = Arr.map(["edge", "database", "queue", "external"] as const, (kind) => {
			const art = serviceArt(spec(kind, 0.5))
			const sprite = Arr.findFirst(art.items, (item) =>
				["lighthouse", "observatory", "windmill", "keep"].includes(item.sprite),
			)
			expect(sprite._tag).toBe("Some")
			expect(sprite._tag === "Some" ? [sprite.value.x, sprite.value.y] : []).toEqual([
				Math.round(art.landmark?.x ?? 999),
				Math.round(art.landmark?.y ?? 999),
			])
			return art.landmark?.kind
		})
		expect(kinds).toEqual(["lighthouse", "observatory", "windmill", "keep"])
	})

	it("marks a town's church, and nothing in a hamlet", () => {
		expect(serviceArt(spec("service", 0.9)).landmark?.kind).toBe("church")
		expect(serviceArt(spec("service", 0.1)).landmark).toBeNull()
	})

	it("walls only a city, inside its tile and outside its houses' yard", () => {
		expect(serviceArt(spec("service", 0.5)).wall).toBe(0)
		const city = serviceArt(spec("service", 1))
		expect(city.wall).toBeGreaterThan(100)
		expect(city.wall).toBeLessThan(CORNER * Math.cos(Math.PI / 6))
		expect(wildArt("1,2", biome, "farm").wall).toBe(0)
	})
})

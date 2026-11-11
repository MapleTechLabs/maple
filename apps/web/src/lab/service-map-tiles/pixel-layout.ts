import { Array as Arr, Order } from "effect"
import type { Node3DKind } from "../../page/service-map/three/types"
import type { SpriteName } from "./art/sprites.generated"
import type { Biome } from "./biome"
import { HEX_SIZE } from "./hex"
import { seeded } from "./solid"
import { settlementOf } from "./tile"
import type { Feature } from "./wild"

// The pixel-art look's tiles: which sprites stand where. Positions are in art pixels from the
// tile's middle, x to the right and y down the screen, and a sprite's position is its foot.

/** Art pixels per world unit: a tile is about 277 pixels wide. */
export const PX = 40
/** From a tile's middle to the middle of a side, and to a corner, in art pixels. */
export const INRADIUS = HEX_SIZE * Math.cos(Math.PI / 6) * PX
export const CORNER = HEX_SIZE * PX

export type GroundName = Extract<
	SpriteName,
	| "grass"
	| "dryGrass"
	| "forestFloor"
	| "autumn"
	| "rocky"
	| "flowerGrass"
	| "snow"
	| "dirt"
	| "water"
	| "deepWater"
	| "sand"
	| "wheatField"
>

export interface Placed {
	readonly sprite: SpriteName
	readonly x: number
	readonly y: number
}

/** A round patch of another ground laid on the tile: a yard, a pond, a field. */
export interface Patch {
	readonly ground: GroundName
	readonly x: number
	readonly y: number
	readonly radius: number
}

export interface TileArt {
	readonly ground: GroundName
	/** Laid in order, so a pond's water goes over its sand. */
	readonly patches: ReadonlyArray<Patch>
	readonly items: ReadonlyArray<Placed>
	/** Where the tile is lit from after dark, and how far the light reaches. */
	readonly lamp: { readonly x: number; readonly y: number; readonly radius: number } | null
}

interface Look {
	readonly ground: GroundName
	readonly cottage: SpriteName
	readonly trees: ReadonlyArray<SpriteName>
}

const MEADOW: Look = { ground: "grass", cottage: "cottageRed", trees: ["oak", "bushyTree"] }

const LOOKS = new Map<string, Look>([
	["meadow", MEADOW],
	["farmland", { ground: "dryGrass", cottage: "cottageThatch", trees: ["bushyTree", "oak"] }],
	["pinewood", { ground: "forestFloor", cottage: "cottageThatch", trees: ["pine"] }],
	[
		"maple-grove",
		{ ground: "autumn", cottage: "cottageRed", trees: ["orangeTree", "redTree", "yellowTree"] },
	],
	["highland", { ground: "rocky", cottage: "cottageBlue", trees: ["pine"] }],
	["lakeland", { ground: "flowerGrass", cottage: "cottageBlue", trees: ["bushyTree", "oak"] }],
	["snowfield", { ground: "snow", cottage: "cottageSnow", trees: ["snowPine"] }],
])

export const lookOf = (biome: Biome): Look => LOOKS.get(biome.id) ?? MEADOW

type Spot = readonly [number, number]

const span = (a: Spot, b: Spot): number => Math.hypot(a[0] - b[0], a[1] - b[1])

/** Distance from a tile's middle to its border in the direction `angle`. */
const borderAt = (angle: number): number => {
	const sixth = Math.PI / 3
	return INRADIUS / Math.cos(angle - Math.round(angle / sixth) * sixth)
}

interface Ground {
	readonly random: () => number
	/** Spots already built on, with how much room each takes. */
	readonly taken: Array<readonly [number, number, number]>
	/** Directions roads and railways leave in: kept clear. */
	readonly corridors: ReadonlyArray<number>
}

/** Whether a road or a railway runs within `room` pixels of `spot`. */
const onWay = (ground: Ground, spot: Spot, room: number): boolean =>
	Arr.some(ground.corridors, (corridor) => {
		const along = spot[0] * Math.cos(corridor) + spot[1] * Math.sin(corridor)
		const across = Math.abs(spot[1] * Math.cos(corridor) - spot[0] * Math.sin(corridor))
		return along > 0 && across < room
	})

/** Up to `count` free spots between `near` pixels from the middle and `far` of the way to the
 * border. `room` is the radius the thing takes up: two things stand at least the sum of their
 * rooms apart, and `wayRoom` clear of a road. */
const scatter = (
	ground: Ground,
	count: number,
	room: number,
	near: number,
	far: number,
	wayRoom = room,
): ReadonlyArray<Spot> => {
	const spots: Array<Spot> = []
	for (let attempt = 0; attempt < count * 40 && spots.length < count; attempt++) {
		const angle = ground.random() * Math.PI * 2
		const reach = borderAt(angle) * far
		if (reach <= near) continue
		const distance = near + (reach - near) * Math.sqrt(ground.random())
		const spot: Spot = [Math.cos(angle) * distance, Math.sin(angle) * distance]
		if (onWay(ground, spot, wayRoom)) continue
		if (Arr.some(ground.taken, (other) => span([other[0], other[1]], spot) < room + other[2])) continue
		ground.taken.push([spot[0], spot[1], room])
		spots.push(spot)
	}
	return spots
}

const pick = <A>(items: ReadonlyArray<A>, random: () => number, fallback: A): A =>
	items[Math.floor(random() * items.length)] ?? fallback

const angleBetween = (a: number, b: number): number => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)))

/** The tile's corners, the one furthest from every road first: landmarks stand towards them. */
const clearCorners = (ground: Ground): ReadonlyArray<number> => {
	const first = Math.floor(ground.random() * 6)
	const angles = Arr.makeBy(6, (index) => (Math.PI / 180) * (60 * ((index + first) % 6) - 30))
	const clearance = (angle: number) =>
		Math.min(Math.PI, ...Arr.map(ground.corridors, (corridor) => angleBetween(angle, corridor)))
	return Arr.sort(angles, Order.flip(Order.mapInput(Order.Number, clearance)))
}

const towards = (angle: number, distance: number): Spot => [
	Math.cos(angle) * distance,
	Math.sin(angle) * distance,
]

const at = (sprite: SpriteName, [x, y]: Spot): Placed => ({ sprite, x: Math.round(x), y: Math.round(y) })

export interface ServiceSpec {
	readonly id: string
	readonly kind: Node3DKind
	/** 0 to 1: where the node's throughput sits among the map's. */
	readonly size: number
	readonly biome: Biome
	readonly corridors: ReadonlyArray<number>
}

/** A service's tile: a settlement that grows with its throughput, or the landmark its kind calls for. */
export const serviceArt = (spec: ServiceSpec): TileArt => {
	const ground: Ground = { random: seeded(`pixel:${spec.id}`), taken: [], corridors: spec.corridors }
	const look = lookOf(spec.biome)
	const [facing = -Math.PI / 6, second = Math.PI / 6] = clearCorners(ground)
	const items: Array<Placed> = []
	const patches: Array<Patch> = []
	const tree = () => pick(look.trees, ground.random, "oak")
	const claim = (spot: Spot, room: number) => ground.taken.push([spot[0], spot[1], room])
	const trees = (count: number, near: number) =>
		Arr.forEach(
			scatter(ground, Math.round(count * Math.min(1.6, spec.biome.woodland)), 15, near, 0.9, 16),
			(spot) => items.push(at(tree(), spot)),
		)
	const cottages = (count: number, near: number, far: number, townShare = 0, barnShare = 0) =>
		Arr.forEach(scatter(ground, count, 27, near, far, 34), (spot) => {
			const roll = ground.random()
			const central = span(spot, [0, 0]) < 96
			items.push(
				at(
					central && roll < townShare ? "townhouse" : roll > 1 - barnShare ? "barn" : look.cottage,
					spot,
				),
			)
		})
	const rocks = (count: number) =>
		Arr.forEach(scatter(ground, count, 13, 50, 0.88, 14), (spot) =>
			items.push(at(ground.random() < 0.5 ? "boulder" : "rocks", spot)),
		)
	const wheat = (count: number) =>
		Arr.forEach(scatter(ground, count, 14, 70, 0.86, 16), (spot) =>
			items.push(at(ground.random() < 0.25 ? "haystack" : "wheat", spot)),
		)
	// The square in the middle is kept clear: roads meet there.
	claim([0, 0], 20)
	if (spec.kind === "edge") {
		const tower = towards(facing, 62)
		const pond = towards(facing, 104)
		patches.push({ ground: "dirt", x: 0, y: 0, radius: 60 })
		patches.push({ ground: "sand", x: pond[0], y: pond[1], radius: 34 })
		patches.push({ ground: "water", x: pond[0], y: pond[1], radius: 27 })
		claim(tower, 30)
		claim(pond, 36)
		items.push(at("lighthouse", tower), at("well", [0, 8]))
		cottages(Math.round(2 + spec.size * 3), 50, 0.7)
		trees(4, 70)
		return { ground: look.ground, patches, items, lamp: { x: 0, y: -10, radius: 150 } }
	}
	if (spec.kind === "database") {
		const dome = towards(facing, 34)
		claim(dome, 40)
		items.push(at("observatory", dome))
		trees(13, 40)
		rocks(spec.biome.boulders > 1 ? 2 : 0)
		return { ground: look.ground, patches, items, lamp: { x: dome[0], y: dome[1] - 24, radius: 95 } }
	}
	if (spec.kind === "queue") {
		const mill = towards(facing, 58)
		patches.push({ ground: "dirt", x: 0, y: 0, radius: 44 })
		claim(mill, 34)
		items.push(at("windmill", mill))
		cottages(Math.round(1 + spec.size * 2), 50, 0.7, 0, 0.5)
		wheat(7)
		trees(3, 80)
		return { ground: look.ground, patches, items, lamp: { x: 0, y: -10, radius: 120 } }
	}
	if (spec.kind === "external") {
		const tower = towards(facing, 44)
		claim(tower, 38)
		items.push(at("keep", tower))
		cottages(1, 60, 0.7)
		rocks(4)
		trees(5, 60)
		return { ground: look.ground, patches, items, lamp: { x: tower[0], y: tower[1] - 24, radius: 100 } }
	}
	const town = settlementOf(spec.size)
	patches.push({ ground: "dirt", x: 0, y: 0, radius: Math.round(40 + spec.size * 62) })
	if (town.hasChurch) {
		const church = towards(facing, 70)
		claim(church, 36)
		items.push(at("church", church))
	}
	if (town.hasHall) {
		const hall = towards(second, 72)
		claim(hall, 40)
		items.push(at("townHall", hall))
	}
	if (town.hasWell) items.push(at("well", [0, 10]))
	Arr.forEach(
		Arr.take([towards(facing + 2.2, 44), towards(facing - 2.2, 44)], Math.min(2, town.stalls)),
		(spot) => {
			if (onWay(ground, spot, 26)) return
			claim(spot, 26)
			items.push(at("stall", spot))
		},
	)
	cottages(
		Math.round(2 + spec.size * 8),
		48,
		Math.min(0.78, 0.5 + spec.size * 0.3),
		town.townShare,
		town.barnShare,
	)
	wheat(town.fields > 0 || spec.biome.fieldCount > 2 ? 4 : 0)
	rocks(spec.biome.boulders > 1 ? 2 : 0)
	trees(3 + (1 - spec.size) * 4, 90)
	return {
		ground: look.ground,
		patches,
		items,
		lamp: { x: 0, y: -10, radius: Math.round(110 + spec.size * 70) },
	}
}

/** A tile of open country. */
export const wildArt = (key: string, biome: Biome, feature: Feature): TileArt => {
	const ground: Ground = { random: seeded(`pixel-wild:${key}`), taken: [], corridors: [] }
	const look = lookOf(biome)
	const items: Array<Placed> = []
	const patches: Array<Patch> = []
	const tree = () => pick(look.trees, ground.random, "oak")
	const put = (sprite: () => SpriteName, count: number, room: number, near: number, far = 0.9) =>
		Arr.forEach(scatter(ground, count, room, near, far), (spot) => items.push(at(sprite(), spot)))
	if (feature === "forest") {
		put(tree, 22, 16, 0)
		put(() => "bush", 4, 12, 0)
	} else if (feature === "hills") {
		put(() => "hill", 4, 26, 0, 0.7)
		put(tree, 6, 16, 20)
		put(() => "rocks", 3, 13, 20)
	} else if (feature === "mountain") {
		put(() => "mountain", 2, 36, 0, 0.5)
		put(() => (ground.random() < 0.5 ? "boulder" : "rocks"), 5, 14, 40)
		put(tree, 5, 16, 60)
	} else if (feature === "farm") {
		Arr.forEach(scatter(ground, 3, 38, 70, 0.62), ([x, y]) =>
			patches.push({ ground: "wheatField", x, y, radius: 40 }),
		)
		ground.taken.length = 0
		put(() => "barn", 1, 28, 0, 0.2)
		put(() => look.cottage, 1, 27, 30, 0.5)
		put(() => "haystack", 3, 14, 40)
		put(tree, 4, 16, 80)
	} else {
		put(() => "flowers", 7, 12, 0)
		put(tree, 4, 16, 20)
		put(() => "bush", 3, 12, 20)
		put(() => "boulder", 1, 14, 30)
	}
	return { ground: look.ground, patches, items, lamp: null }
}

/** How far from a lake's middle the ducks paddle. */
export const DUCK_LOOP = 52

/** A lake: sand, water, deep water, and reeds round the shore. */
export const lakeArt = (key: string): TileArt => {
	const random = seeded(`pixel-lake:${key}`)
	return {
		ground: "grass",
		patches: [
			{ ground: "sand", x: 0, y: 0, radius: 112 },
			{ ground: "water", x: 0, y: 0, radius: 102 },
			{ ground: "deepWater", x: 4, y: 4, radius: 56 },
		],
		items: Arr.makeBy(8, (index) => {
			const angle = (index / 8) * Math.PI * 2 + random() * 0.5
			return at(random() < 0.75 ? "reeds" : "rocks", towards(angle, 100 + random() * 12))
		}),
		lamp: null,
	}
}

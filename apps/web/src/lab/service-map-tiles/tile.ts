import { Array as Arr, Option, Order } from "effect"
import * as THREE from "three"
import type { Node3DKind } from "../../page/service-map/three/types"
import type { Biome, TreeKind } from "./biome"
import { corners, HEX_SIZE, ORIGIN, type Point } from "./hex"
import type { TilePalette } from "./palette"
import { band, creases, fuse, gable, loft, moved, part, pickFrom, seeded, vary, type Vec3 } from "./solid"

// One hex tile of land per service. Its namespace's biome is the country it lies in (the ground,
// the trees, the roofs), and what stands on it says what the node is: a village for a service
// (more houses the busier it is, a church in the busiest), a pond and lighthouse where traffic
// enters, an observatory for a database, a windmill for a queue and a keep for an external
// dependency.

/** How thick the block of earth under a tile is. */
export const TILE_DEPTH = 1.05

const OUTLINE = corners(ORIGIN)
const INRADIUS = HEX_SIZE * Math.cos(Math.PI / 6)
const SIXTH = Math.PI / 3

/** A tile's own outline around its middle, for rings and plates laid on it. */
export const tileOutline: ReadonlyArray<Point> = OUTLINE

/** Distance from a tile's centre to its border in the direction `angle`. */
export const borderReach = (angle: number): number =>
	INRADIUS / Math.cos(angle - Math.round(angle / SIXTH) * SIXTH)

export interface TileSpec {
	readonly id: string
	readonly kind: Node3DKind
	/** 0 to 1: where the node's throughput sits among the map's, on a log scale. */
	readonly size: number
	readonly biome: Biome
	readonly palette: TilePalette
	/** Directions (radians, from the centre) its roads and railways leave in: kept clear. */
	readonly corridors: ReadonlyArray<number>
}

export interface Tile {
	readonly geometry: THREE.BufferGeometry
	readonly ink: THREE.BufferGeometry
	/** The tallest thing on the tile. */
	readonly height: number
	/** A windmill's sails, turning with the traffic: where the hub is and which way it faces. */
	readonly sails: {
		readonly geometry: THREE.BufferGeometry
		readonly hub: Vec3
		readonly turn: number
	} | null
}

type Parts = ReadonlyArray<THREE.BufferGeometry>

const wall = (palette: TilePalette, index: number): string => palette.walls[index] ?? palette.dome

/** The block of earth every tile is cut from: soil below, the biome's growth as a lip, `top` as its lid. */
export const earthBlock = (palette: TilePalette, lip: string, top: string): THREE.BufferGeometry =>
	loft(
		OUTLINE,
		[
			{ y: -TILE_DEPTH, scale: 0.97, color: palette.soilShade },
			{ y: -TILE_DEPTH * 0.5, scale: 1, color: palette.soilShade },
			{ y: -0.12, scale: 1, color: palette.soil },
			{ y: 0, scale: 1, color: lip },
		],
		{ lid: top, floor: palette.soilShade },
	)

const house = (palette: TilePalette, random: () => number, roofs: ReadonlyArray<string>): Parts => {
	const width = 0.32 + random() * 0.12
	const depth = 0.38 + random() * 0.18
	const height = (0.22 + random() * 0.1) * (random() < 0.25 ? 1.5 : 1)
	return [
		part(
			new THREE.BoxGeometry(width, height, depth),
			vary(pickFrom(palette.walls, random, palette.dome), random, 0.03),
			{ position: [0, height / 2, 0] },
		),
		gable(
			width * 1.18,
			0.16 + random() * 0.08,
			depth * 1.12,
			vary(pickFrom(roofs, random, palette.banner), random),
		).translate(0, height, 0),
	]
}

const trunk = (palette: TilePalette, height: number, radius: number): THREE.BufferGeometry =>
	part(new THREE.CylinderGeometry(radius * 0.7, radius, height, 5), palette.timber, {
		position: [0, height / 2, 0],
	})

/** A tree of the biome's kind standing on y = 0: a leafy crown, tiers of pine, a maple on a tall
 * trunk, or a pine under snow. */
const tree = (palette: TilePalette, biome: Biome, random: () => number): Parts => {
	const size = 0.2 + random() * 0.13
	const leaf = () => vary(pickFrom(biome.foliage, random, biome.turf), random, 0.04)
	const crown = (radius: number, x: number, y: number, z: number) =>
		part(new THREE.IcosahedronGeometry(radius, 0), leaf(), {
			position: [x, y, z],
			turn: random() * Math.PI,
			scale: [1, 1.15, 1],
		})
	const tier = (radius: number, height: number, y: number, color: string | THREE.Color) =>
		part(new THREE.ConeGeometry(radius, height, 6), color, { position: [0, y + height / 2, 0] })
	const pine = (cap: string | THREE.Color): Parts => [
		trunk(palette, size * 0.5, size * 0.14),
		tier(size * 0.95, size * 1.3, size * 0.4, leaf()),
		tier(size * 0.72, size * 1.1, size * 1.15, leaf()),
		tier(size * 0.5, size * 0.9, size * 1.85, cap),
	]
	const grown = {
		broadleaf: () =>
			random() < 0.4
				? [
						trunk(palette, size * 0.6, size * 0.16),
						crown(size, 0, size * 1.25, 0),
						crown(size * 0.75, size * 0.8, size * 1.05, size * 0.3),
					]
				: [trunk(palette, size * 0.6, size * 0.16), crown(size, 0, size * 1.25, 0)],
		maple: () => [trunk(palette, size * 1.2, size * 0.17), crown(size * 1.15, 0, size * 1.95, 0)],
		pine: () => pine(leaf()),
		snowpine: () => pine(palette.snow),
	} satisfies Record<TreeKind, () => Parts>
	return grown[biome.trees]()
}

const boulder = (palette: TilePalette, random: () => number): Parts => {
	const size = 0.14 + random() * 0.16
	return [
		part(new THREE.IcosahedronGeometry(size, 0), vary(palette.rock, random, 0.05), {
			position: [0, size * 0.45, 0],
			turn: random() * Math.PI,
			scale: [1, 0.7, 1.2],
		}),
	]
}

const church = (palette: TilePalette, biome: Biome, random: () => number): Parts => {
	const roof = vary(pickFrom(biome.roofs, random, palette.banner), random)
	return [
		part(new THREE.BoxGeometry(0.5, 0.44, 0.92), wall(palette, 2), { position: [0, 0.22, 0.1] }),
		gable(0.58, 0.28, 0.98, roof).translate(0, 0.44, 0.1),
		part(new THREE.BoxGeometry(0.34, 1.02, 0.34), wall(palette, 0), { position: [0, 0.51, -0.5] }),
		part(new THREE.ConeGeometry(0.29, 0.74, 4), roof, {
			position: [0, 1.02 + 0.37, -0.5],
			turn: Math.PI / 4,
		}),
	]
}

const lighthouse = (palette: TilePalette): Parts => [
	part(new THREE.CylinderGeometry(0.34, 0.4, 0.14, 10), palette.stone, { position: [0, 0.07, 0] }),
	part(new THREE.CylinderGeometry(0.15, 0.24, 1.05, 12), palette.dome, { position: [0, 0.14 + 0.525, 0] }),
	part(new THREE.CylinderGeometry(0.185, 0.205, 0.2, 12), palette.banner, { position: [0, 0.62, 0] }),
	part(new THREE.CylinderGeometry(0.2, 0.2, 0.05, 12), palette.stone, { position: [0, 1.215, 0] }),
	part(new THREE.CylinderGeometry(0.11, 0.11, 0.18, 8), palette.lamp, { position: [0, 1.33, 0] }),
	part(new THREE.ConeGeometry(0.18, 0.2, 8), palette.banner, { position: [0, 1.52, 0] }),
]

const observatory = (palette: TilePalette, random: () => number): Parts => {
	const slate = vary(pickFrom(palette.slates, random, palette.stone), random, 0.03)
	const wing = (x: number) => [
		part(new THREE.BoxGeometry(0.42, 0.32, 0.46), wall(palette, 1), { position: [x, 0.16, 0.06] }),
		part(new THREE.ConeGeometry(0.36, 0.22, 4), slate, { position: [x, 0.43, 0.06], turn: Math.PI / 4 }),
	]
	return [
		part(new THREE.BoxGeometry(0.78, 0.46, 0.64), wall(palette, 0), { position: [0, 0.23, 0] }),
		part(new THREE.CylinderGeometry(0.33, 0.35, 0.14, 14), palette.stoneLight, {
			position: [0, 0.53, 0],
		}),
		part(new THREE.SphereGeometry(0.32, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2), palette.dome, {
			position: [0, 0.6, 0],
		}),
		part(new THREE.BoxGeometry(0.07, 0.32, 0.2), slate, { position: [0, 0.75, 0.17] }),
		...wing(-0.6),
		...wing(0.6),
	]
}

const windmill = (palette: TilePalette, biome: Biome, random: () => number): Parts => [
	part(new THREE.CylinderGeometry(0.16, 0.29, 0.84, 8), wall(palette, 0), { position: [0, 0.42, 0] }),
	part(new THREE.ConeGeometry(0.23, 0.26, 8), vary(pickFrom(biome.roofs, random, palette.banner), random), {
		position: [0, 0.97, 0],
	}),
]

/** Where a windmill's hub sits on its tower, before the mill is placed and turned. */
const HUB: Vec3 = [0, 0.75, 0.2]

/** Four sails about the origin, turning in the xy plane. */
const sailsOf = (palette: TilePalette): THREE.BufferGeometry =>
	fuse(
		Arr.flatMap(Arr.range(0, 3), (index) => {
			const arm = new THREE.BoxGeometry(0.04, 0.58, 0.02).translate(0, 0.29, 0)
			const cloth = new THREE.BoxGeometry(0.14, 0.4, 0.012).translate(0.09, 0.33, 0)
			const turn = new THREE.Matrix4().makeRotationZ((index * Math.PI) / 2)
			return [
				part(arm, palette.timber).applyMatrix4(turn),
				part(cloth, palette.sail).applyMatrix4(turn),
			]
		}),
	)

const keep = (palette: TilePalette): Parts => [
	part(new THREE.CylinderGeometry(0.35, 0.4, 0.74, 10), palette.stone, { position: [0, 0.37, 0] }),
	...Arr.map(Arr.range(0, 5), (index) => {
		const angle = (index / 6) * Math.PI * 2
		return part(new THREE.BoxGeometry(0.15, 0.12, 0.1), palette.stoneLight, {
			position: [Math.cos(angle) * 0.32, 0.8, Math.sin(angle) * 0.32],
			turn: -angle + Math.PI / 2,
		})
	}),
	part(new THREE.CylinderGeometry(0.014, 0.014, 0.56, 5), palette.timber, { position: [0, 1.02, 0] }),
	part(new THREE.BoxGeometry(0.26, 0.15, 0.012), palette.banner, { position: [0.14, 1.21, 0] }),
]

interface Plan {
	/** Radius of the worn village ground round the square; 0 for none. */
	readonly yard: number
	readonly landmark: Parts
	/** How far from the middle the landmark stands, towards a corner. */
	readonly offset: number
	/** Ground kept clear round the landmark. */
	readonly clearing: number
	readonly houses: number
	readonly roofs: ReadonlyArray<string>
	readonly trees: number
	readonly fields: number
	readonly boulders: number
	/** Radius of a pond beyond the landmark; 0 for none. */
	readonly pond: number
	readonly height: number
}

/** What the node's kind puts on the tile, before the biome has its say. */
const standingOn = ({ kind, size, biome, palette }: TileSpec, random: () => number): Plan => {
	const none = { yard: 0, houses: 0, fields: 0, boulders: 0, pond: 0, roofs: biome.roofs }
	if (kind === "edge")
		return {
			...none,
			yard: 1.5,
			landmark: lighthouse(palette),
			offset: 1.35,
			clearing: 0.65,
			houses: 7,
			trees: 9,
			pond: 1.25,
			height: 1.65,
		}
	if (kind === "database")
		return {
			...none,
			landmark: observatory(palette, random),
			offset: 1.45,
			clearing: 1.05,
			roofs: palette.slates,
			trees: 26,
			height: 0.95,
		}
	if (kind === "queue")
		return {
			...none,
			yard: 1.1,
			landmark: windmill(palette, biome, random),
			offset: 1.5,
			clearing: 0.7,
			houses: 4,
			trees: 7,
			fields: 3,
			height: 1.3,
		}
	if (kind === "external")
		return {
			...none,
			landmark: keep(palette),
			offset: 1.4,
			clearing: 0.7,
			houses: 2,
			roofs: palette.slates,
			trees: 9,
			boulders: 5,
			height: 1.35,
		}
	const busy = size > 0.6
	return {
		...none,
		yard: 1.25 + size * 1.1,
		landmark: busy ? church(palette, biome, random) : [],
		offset: 1.2,
		clearing: busy ? 0.8 : 0,
		houses: 7 + Math.round(size * 22),
		trees: 10 + Math.round(random() * 4),
		fields: size < 0.4 ? 2 : 0,
		height: busy ? 1.8 : 0.65,
	}
}

/** The tile's plan: what its kind stands on it, then the biome's woods, fields, rocks and pond. */
const planOf = (spec: TileSpec, random: () => number): Plan => {
	const plan = standingOn(spec, random)
	const { biome } = spec
	return {
		...plan,
		trees: Math.round(plan.trees * biome.woodland),
		fields: plan.fields + biome.fieldCount,
		boulders: plan.boulders + biome.boulders,
		pond: plan.pond > 0 ? plan.pond : biome.hasPond ? 0.95 : 0,
	}
}

interface Spot {
	readonly at: Point
	readonly angle: number
}

const span = (a: Point, b: Point): number => Math.hypot(a[0] - b[0], a[1] - b[1])

/** Up to `count` spots on the tile at least `spacing` apart, between `near` units from the middle
 * and `far` of the way to the border. The corridors play no part here, so a new road removes the
 * spots in its way and moves none of the others. */
const scatter = (
	random: () => number,
	count: number,
	spacing: number,
	near: number,
	far: number,
	taken: Array<Point>,
): ReadonlyArray<Spot> => {
	const spots: Array<Spot> = []
	for (let attempt = 0; attempt < count * 30 && spots.length < count; attempt++) {
		const angle = random() * Math.PI * 2
		const distance = near + (borderReach(angle) * far - near) * Math.sqrt(random())
		const at: Point = [Math.cos(angle) * distance, Math.sin(angle) * distance]
		if (Arr.some(taken, (other) => span(other, at) < spacing)) continue
		taken.push(at)
		spots.push({ at, angle })
	}
	return spots
}

/** A blob of ground: a circle bent a little, flat at `y`. */
export const patch = (
	random: () => number,
	radius: number,
	y: number,
	color: string,
): THREE.BufferGeometry => {
	const phase = random() * Math.PI * 2
	const outline = Arr.makeBy(18, (index): Point => {
		const angle = (index / 18) * Math.PI * 2
		const bend = 1 + 0.1 * Math.sin(2 * angle + phase) + 0.06 * Math.sin(3 * angle + phase * 2)
		return [radius * bend * Math.cos(angle), radius * bend * Math.sin(angle)]
	})
	return band(outline, y, 0, 1, color)
}

/** A ploughed strip: a slightly crooked rectangle, flat on the ground. */
const field = (biome: Biome, random: () => number): THREE.BufferGeometry => {
	const [w, d] = [0.5 + random() * 0.3, 0.36 + random() * 0.22]
	const skew = () => 0.88 + random() * 0.24
	const outline: ReadonlyArray<Point> = [
		[w * skew(), d * skew()],
		[-w * skew(), d * skew()],
		[-w * skew(), -d * skew()],
		[w * skew(), -d * skew()],
	]
	return band(outline, 0.012, 0, 1, pickFrom(biome.fields, random, biome.yard))
}

const angleBetween = (a: number, b: number): number => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)))

/** The corner the landmark stands towards: the one furthest from every road and railway. */
const landmarkAngle = (corridors: ReadonlyArray<number>, random: () => number): number => {
	const first = Math.floor(random() * 6)
	const angles = Arr.makeBy(6, (index) => (Math.PI / 180) * (60 * ((index + first) % 6) - 30))
	const clearance = (angle: number) =>
		Math.min(Math.PI, ...Arr.map(corridors, (corridor) => angleBetween(angle, corridor)))
	return Option.getOrElse(
		Arr.head(Arr.sort(angles, Order.flip(Order.mapInput(Order.Number, clearance)))),
		() => -Math.PI / 6,
	)
}

export const buildTile = (spec: TileSpec): Tile => {
	const { palette, biome, corridors } = spec
	const random = seeded(`tile:${spec.id}`)
	const plan = planOf(spec, random)
	const facing = landmarkAngle(corridors, random)
	const at = (distance: number): Point => [Math.cos(facing) * distance, Math.sin(facing) * distance]
	const landmark = at(plan.offset)
	const pond = at(plan.offset + plan.pond + 0.25)
	/** A spot is free when no road or railway runs over it and it is off the square, the landmark and the pond. */
	const free = (spot: Point, room: number): boolean =>
		span(spot, [0, 0]) > 0.6 + room &&
		(plan.landmark.length === 0 || span(spot, landmark) > plan.clearing + room) &&
		(plan.pond === 0 || span(spot, pond) > plan.pond + 0.15 + room) &&
		!Arr.some(corridors, (corridor) => {
			const along = spot[0] * Math.cos(corridor) + spot[1] * Math.sin(corridor)
			const across = Math.abs(spot[1] * Math.cos(corridor) - spot[0] * Math.sin(corridor))
			return along > 0 && across < 0.3 + room
		})
	const taken: Array<Point> = []
	const fields = Arr.flatMap(scatter(random, plan.fields, 1.45, 1.5, 0.7, taken), (spot) => {
		const strip = field(biome, random).rotateY(random() * Math.PI)
		return free(spot.at, 0.5) ? [strip.translate(spot.at[0], 0, spot.at[1])] : []
	})
	const houses = Arr.flatMap(scatter(random, plan.houses, 0.62, 0.85, 0.66, taken), (spot) => {
		const built = house(palette, random, plan.roofs)
		const turn = -spot.angle + (random() - 0.5)
		return free(spot.at, 0.2) ? moved(built, { position: [spot.at[0], 0, spot.at[1]], turn }) : []
	})
	const boulders = Arr.flatMap(scatter(random, plan.boulders, 0.5, 0.9, 0.86, taken), (spot) => {
		const rock = boulder(palette, random)
		return free(spot.at, 0.05) ? moved(rock, { position: [spot.at[0], 0, spot.at[1]] }) : []
	})
	const trees = Arr.flatMap(scatter(random, plan.trees, 0.46, 0.9, 0.88, taken), (spot) => {
		const grown = tree(palette, biome, random)
		return free(spot.at, 0.12) ? moved(grown, { position: [spot.at[0], 0, spot.at[1]] }) : []
	})
	// The landmark looks back at the village square: its local +z points to the tile's middle.
	const turn = Math.atan2(-Math.cos(facing), -Math.sin(facing))
	const water =
		plan.pond === 0
			? []
			: [
					patch(random, plan.pond + 0.12, 0.008, palette.sand).translate(pond[0], 0, pond[1]),
					patch(random, plan.pond, 0.014, palette.water).translate(pond[0], 0, pond[1]),
				]
	const inked = fuse([
		...moved(plan.landmark, { position: [landmark[0], 0, landmark[1]], turn }),
		...houses,
		...boulders,
		...trees,
		...fields,
		...Arr.drop(water, 1),
	])
	const ink = creases(inked)
	const block = earthBlock(
		palette,
		biome.turf,
		vary(pickFrom(biome.grounds, random, biome.turf), random, 0.008).getStyle(),
	)
	const ground = [
		...(plan.yard === 0 ? [] : [patch(random, plan.yard, 0.005, biome.yard)]),
		patch(random, 0.6, 0.018, palette.road),
		...Arr.take(water, 1),
	]
	const hub = new THREE.Vector3(...HUB).applyAxisAngle(new THREE.Vector3(0, 1, 0), turn)
	return {
		geometry: fuse([block, ...ground, inked]),
		ink,
		height: plan.height,
		sails:
			spec.kind === "queue"
				? { geometry: sailsOf(palette), hub: [landmark[0] + hub.x, hub.y, landmark[1] + hub.z], turn }
				: null,
	}
}

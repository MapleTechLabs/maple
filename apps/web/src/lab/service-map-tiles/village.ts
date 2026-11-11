import { Array as Arr } from "effect"
import * as THREE from "three"
import type { Biome } from "./biome"
import type { TilePalette } from "./palette"
import { gable, moved, part, pickFrom, type Placing, vary, type Vec3 } from "./solid"

// What a settlement is built from: cottages, townhouses, barns, a church, a town hall, market
// stalls, a well and a town wall. Every building stands on y = 0 with its front on +z.

type Parts = ReadonlyArray<THREE.BufferGeometry>

export interface Building {
	/** Walls and roofs: the volumes the ink follows. */
	readonly solid: Parts
	/** Doors, windows, beams and footings: too small to outline. */
	readonly trim: Parts
}

/** `building` put somewhere on the tile. */
export const placed = (building: Building, placing: Placing): Building => ({
	solid: moved(building.solid, placing),
	trim: moved(building.trim, placing),
})

const slab = (
	width: number,
	height: number,
	depth: number,
	color: string | THREE.Color,
	at: Vec3,
): THREE.BufferGeometry => part(new THREE.BoxGeometry(width, height, depth), color, { position: at })

/** Height of the stone footing every building stands on. */
const FOOT = 0.04
/** How far a door or a window stands proud of its wall. */
const PROUD = 0.005

/** Window panes: dark by day, lit at night. */
const glassOf = (palette: TilePalette): string => (palette.night ? palette.lamp : palette.glass)

/** A pitched roof on a wall top `width` by `depth` at height `base`: the two gable ends filled in
 * with wall, and two roof planes with thickness that overhang the walls by `eave`. */
const pitched = (
	width: number,
	rise: number,
	depth: number,
	base: number,
	walls: THREE.Color,
	roof: THREE.Color,
	eave: number,
): Parts => {
	const pitch = Math.atan2(rise, width / 2)
	const reach = width / 2 + eave
	const length = reach / Math.cos(pitch)
	const thickness = 0.035
	const plane = (side: number) =>
		part(
			new THREE.BoxGeometry(length, thickness, depth + eave * 2)
				.rotateZ(-side * pitch)
				.translate(
					(side * reach) / 2 + side * Math.sin(pitch) * (thickness / 2),
					base + rise - (reach / 2) * Math.tan(pitch) + Math.cos(pitch) * (thickness / 2),
					0,
				),
			roof,
		)
	return [gable(width, rise, depth, walls).translate(0, base, 0), plane(1), plane(-1)]
}

const chimney = (palette: TilePalette, x: number, top: number, z: number): Building => ({
	solid: [slab(0.07, 0.2, 0.07, palette.stone, [x, top - 0.1, z])],
	trim: [slab(0.09, 0.025, 0.09, palette.steel, [x, top + 0.012, z])],
})

/** Windows along a wall facing +z at depth `z`: `count` of them spread over `width`. */
const windowsAcross = (
	palette: TilePalette,
	count: number,
	width: number,
	y: number,
	z: number,
	size: readonly [number, number] = [0.06, 0.07],
): Parts =>
	Arr.makeBy(count, (index) =>
		slab(size[0], size[1], 0.014, glassOf(palette), [
			(index - (count - 1) / 2) * (width / count),
			y,
			z + PROUD,
		]),
	)

/** A cottage: one storey under a pitched roof, a door between two windows, a chimney. */
export const cottage = (palette: TilePalette, biome: Biome, random: () => number): Building => {
	const width = 0.36 + random() * 0.1
	const depth = 0.44 + random() * 0.12
	const height = 0.2 + random() * 0.08
	const rise = 0.17 + random() * 0.07
	const walls = vary(pickFrom(palette.walls, random, palette.dome), random, 0.03)
	const roof = vary(pickFrom(biome.roofs, random, palette.banner), random)
	const stack = chimney(palette, width * 0.2, FOOT + height + rise * 0.95, -depth * 0.2)
	return {
		solid: [
			slab(width, height, depth, walls, [0, FOOT + height / 2, 0]),
			...pitched(width, rise, depth, FOOT + height, walls, roof, 0.05),
			...stack.solid,
		],
		trim: [
			slab(width + 0.05, FOOT, depth + 0.05, palette.stone, [0, FOOT / 2, 0]),
			slab(0.08, 0.13, 0.014, palette.timber, [0, FOOT + 0.065, depth / 2 + PROUD]),
			...Arr.map([-1, 1], (side) =>
				slab(0.06, 0.065, 0.014, glassOf(palette), [
					side * width * 0.31,
					FOOT + height * 0.6,
					depth / 2 + PROUD,
				]),
			),
			...Arr.map([-1, 1], (side) =>
				slab(0.014, 0.065, 0.08, glassOf(palette), [
					side * (width / 2 + PROUD),
					FOOT + height * 0.6,
					-depth * 0.05,
				]),
			),
			...stack.trim,
		],
	}
}

/** A townhouse: a stone ground floor, one or two timber-framed storeys jettied out over it, a
 * steep roof. Towns are built of these. */
export const townhouse = (palette: TilePalette, biome: Biome, random: () => number): Building => {
	const width = 0.3 + random() * 0.08
	const depth = 0.36 + random() * 0.1
	const storey = 0.19
	const upperFloors = random() < 0.4 ? 2 : 1
	const upper = storey * upperFloors
	const rise = 0.24 + random() * 0.08
	const jetty = 0.05
	const walls = vary(pickFrom(palette.walls, random, palette.dome), random, 0.03)
	const roof = vary(pickFrom(biome.roofs, random, palette.banner), random)
	const eaves = FOOT + storey + upper
	const front = (depth + jetty) / 2
	const stack = chimney(palette, -width * 0.22, eaves + rise * 0.95, -depth * 0.15)
	return {
		solid: [
			slab(width, storey, depth, palette.stoneLight, [0, FOOT + storey / 2, 0]),
			slab(width + jetty, upper, depth + jetty, walls, [0, FOOT + storey + upper / 2, 0]),
			...pitched(width + jetty, rise, depth + jetty, eaves, walls, roof, 0.04),
			...stack.solid,
		],
		trim: [
			slab(width + 0.05, FOOT, depth + 0.05, palette.stone, [0, FOOT / 2, 0]),
			slab(0.08, 0.14, 0.014, palette.timber, [-width * 0.2, FOOT + 0.07, depth / 2 + PROUD]),
			slab(0.07, 0.07, 0.014, glassOf(palette), [
				width * 0.22,
				FOOT + storey * 0.58,
				depth / 2 + PROUD,
			]),
			...Arr.flatMap(Arr.range(0, upperFloors - 1), (floor) => {
				const level = FOOT + storey + floor * storey
				return [
					...windowsAcross(palette, 2, width, level + storey * 0.55, front),
					// The frame: a beam under each floor, and posts at the corners and the middle.
					slab(width + jetty + 0.01, 0.018, 0.012, palette.timber, [
						0,
						level + 0.009,
						front + PROUD,
					]),
				]
			}),
			...Arr.map([-1, 0, 1], (post) =>
				slab(0.018, upper, 0.012, palette.timber, [
					(post * (width + jetty - 0.018)) / 2,
					FOOT + storey + upper / 2,
					front + PROUD,
				]),
			),
			...stack.trim,
		],
	}
}

/** A barn: wide, low, planked, with a door a cart could drive through. */
export const barn = (palette: TilePalette, biome: Biome, random: () => number): Building => {
	const width = 0.48 + random() * 0.1
	const depth = 0.56 + random() * 0.12
	const height = 0.2
	const rise = 0.24 + random() * 0.05
	const planks = vary(palette.plank, random, 0.04)
	const roof = vary(pickFrom(biome.roofs, random, palette.banner), random)
	return {
		solid: [
			slab(width, height, depth, planks, [0, FOOT + height / 2, 0]),
			...pitched(width, rise, depth, FOOT + height, planks, roof, 0.06),
		],
		trim: [
			slab(width + 0.05, FOOT, depth + 0.05, palette.stone, [0, FOOT / 2, 0]),
			slab(0.2, 0.17, 0.014, palette.timber, [0, FOOT + 0.085, depth / 2 + PROUD]),
			slab(0.08, 0.07, 0.014, palette.steel, [0, FOOT + height + rise * 0.35, depth / 2 + PROUD]),
		],
	}
}

/** A church: a nave with tall windows and an apse, and a tower with a belfry under a spire.
 * `grand` scales it up for a city. */
export const church = (palette: TilePalette, biome: Biome, random: () => number, grand: number): Building => {
	const roof = vary(pickFrom(biome.roofs, random, palette.banner), random)
	const walls = new THREE.Color(palette.walls[2] ?? palette.dome)
	const [width, height, depth] = [0.5, 0.44, 0.92]
	const tower = 1.02
	const apse = new THREE.CylinderGeometry(
		width * 0.42,
		width * 0.42,
		height * 0.85,
		8,
		1,
		false,
		0,
		Math.PI,
	)
		.rotateY(Math.PI / 2)
		.translate(0, FOOT + (height * 0.85) / 2, 0.1 + depth / 2)
	const apseRoof = new THREE.ConeGeometry(width * 0.46, 0.2, 8, 1, false, 0, Math.PI)
		.rotateY(Math.PI / 2)
		.translate(0, FOOT + height * 0.85 + 0.1, 0.1 + depth / 2)
	const building: Building = {
		solid: [
			slab(width, height, depth, walls, [0, FOOT + height / 2, 0.1]),
			...Arr.map(pitched(width, 0.28, depth, FOOT + height, walls, roof, 0.04), (piece) =>
				piece.translate(0, 0, 0.1),
			),
			part(apse, walls),
			part(apseRoof, roof),
			slab(0.34, tower, 0.34, palette.walls[0] ?? palette.dome, [0, FOOT + tower / 2, -0.5]),
			part(new THREE.ConeGeometry(0.29, 0.74, 4), roof, {
				position: [0, FOOT + tower + 0.37, -0.5],
				turn: Math.PI / 4,
			}),
		],
		trim: [
			slab(width + 0.06, FOOT, depth + 0.06, palette.stone, [0, FOOT / 2, 0.1]),
			slab(0.4, FOOT, 0.4, palette.stone, [0, FOOT / 2, -0.5]),
			// Tall windows down both sides of the nave, and buttresses between them.
			...Arr.flatMap([-1, 1], (side) => [
				...Arr.map([-0.2, 0.08, 0.36], (z) =>
					slab(0.014, 0.2, 0.07, glassOf(palette), [
						side * (width / 2 + PROUD),
						FOOT + height * 0.55,
						z,
					]),
				),
				...Arr.map([-0.06, 0.22], (z) =>
					slab(0.05, height * 0.8, 0.06, palette.stoneLight, [
						side * (width / 2 + 0.02),
						FOOT + height * 0.4,
						z,
					]),
				),
			]),
			// Belfry openings on every face of the tower, and the west door at its foot.
			...Arr.map([0, 1, 2, 3], (face) =>
				part(new THREE.BoxGeometry(0.1, 0.16, 0.014), palette.steel, {
					position: [
						Math.sin((face * Math.PI) / 2) * (0.17 + PROUD),
						FOOT + tower - 0.16,
						-0.5 + Math.cos((face * Math.PI) / 2) * (0.17 + PROUD),
					],
					turn: (face * Math.PI) / 2,
				}),
			),
			slab(0.1, 0.17, 0.014, palette.timber, [0, FOOT + 0.085, -0.5 - 0.17 - PROUD]),
			slab(0.016, 0.14, 0.016, palette.stoneLight, [0, FOOT + tower + 0.8, -0.5]),
			slab(0.07, 0.016, 0.016, palette.stoneLight, [0, FOOT + tower + 0.82, -0.5]),
		],
	}
	return placed(building, { scale: [grand, grand, grand] })
}

/** How tall a church stands, for the tile's height and the top of its spire. */
export const CHURCH_HEIGHT = 1.9

/** A town hall: an arcade at street level, a row of windows above, a hipped roof and a clock turret. */
export const townHall = (palette: TilePalette, biome: Biome, random: () => number): Building => {
	const [width, height, depth] = [0.66, 0.42, 0.52]
	const roof = vary(pickFrom(biome.roofs, random, palette.banner), random)
	const top = FOOT + height
	return {
		solid: [
			slab(width, height, depth, palette.walls[2] ?? palette.dome, [0, FOOT + height / 2, 0]),
			part(new THREE.ConeGeometry(0.5, 0.26, 4), roof, {
				position: [0, top + 0.13, 0],
				turn: Math.PI / 4,
				scale: [1, 1, 0.82],
			}),
			slab(0.17, 0.26, 0.17, palette.walls[0] ?? palette.dome, [0, top + 0.26, 0]),
			part(new THREE.ConeGeometry(0.14, 0.3, 4), roof, {
				position: [0, top + 0.54, 0],
				turn: Math.PI / 4,
			}),
		],
		trim: [
			slab(width + 0.08, FOOT, depth + 0.08, palette.stone, [0, FOOT / 2, 0]),
			...Arr.map([-0.24, -0.08, 0.08, 0.24], (x) =>
				slab(0.09, 0.15, 0.014, palette.steel, [x, FOOT + 0.075, depth / 2 + PROUD]),
			),
			...windowsAcross(palette, 4, width * 0.92, FOOT + height * 0.72, depth / 2),
			part(new THREE.CylinderGeometry(0.05, 0.05, 0.012, 10).rotateX(Math.PI / 2), palette.dome, {
				position: [0, top + 0.31, 0.085 + PROUD],
			}),
		],
	}
}

/** A market stall: a counter under a striped awning on four posts. */
export const stall = (palette: TilePalette, random: () => number): Building => {
	const awning = pickFrom(palette.awnings, random, palette.banner)
	return {
		solid: [
			part(new THREE.BoxGeometry(0.28, 0.02, 0.2).rotateX(0.22), awning, { position: [0, 0.2, 0] }),
			slab(0.22, 0.07, 0.1, palette.plank, [0, 0.035, -0.02]),
		],
		trim: Arr.flatMap([-1, 1], (x) =>
			Arr.map([-1, 1], (z) => slab(0.016, 0.2, 0.016, palette.timber, [x * 0.12, 0.1, z * 0.08])),
		),
	}
}

/** The well in the square: a stone ring of water under a small roof. */
export const well = (palette: TilePalette, biome: Biome, random: () => number): Building => ({
	solid: [
		part(new THREE.CylinderGeometry(0.1, 0.11, 0.09, 10), palette.stone, { position: [0, 0.045, 0] }),
		...pitched(
			0.16,
			0.06,
			0.2,
			0.24,
			new THREE.Color(palette.timber),
			vary(pickFrom(biome.roofs, random, palette.banner), random),
			0.03,
		),
	],
	trim: [
		part(new THREE.CylinderGeometry(0.075, 0.075, 0.01, 10), palette.waterDeep, {
			position: [0, 0.092, 0],
		}),
		slab(0.018, 0.24, 0.018, palette.timber, [-0.085, 0.12, 0]),
		slab(0.018, 0.24, 0.018, palette.timber, [0.085, 0.12, 0]),
	],
})

/** Corners in the town wall's ring. */
const WALL_CORNERS = 18

/** A town wall `radius` out from the square: stretches of wall between round towers, open where
 * a road or a railway (`corridors`, radians) leaves the town. */
export const townWall = (
	palette: TilePalette,
	biome: Biome,
	random: () => number,
	radius: number,
	corridors: ReadonlyArray<number>,
): Building => {
	const roof = vary(pickFrom(biome.roofs, random, palette.banner), random)
	const gate = Math.asin(Math.min(1, 0.55 / radius))
	const corner = (index: number): readonly [number, number] => {
		const angle = ((index % WALL_CORNERS) / WALL_CORNERS) * Math.PI * 2
		return [Math.cos(angle) * radius, Math.sin(angle) * radius]
	}
	/** A stretch stands unless a way out of the town passes through it. */
	const stands = (index: number): boolean => {
		const middle = ((index + 0.5) / WALL_CORNERS) * Math.PI * 2
		return !Arr.some(
			corridors,
			(corridor) =>
				Math.abs(Math.atan2(Math.sin(middle - corridor), Math.cos(middle - corridor))) < gate,
		)
	}
	const stretches = Arr.filter(Arr.range(0, WALL_CORNERS - 1), stands)
	// A tower at each gate, and one every third corner along an unbroken wall.
	const towers = Arr.filter(
		Arr.range(0, WALL_CORNERS - 1),
		(index) =>
			(stands(index) || stands(index + WALL_CORNERS - 1)) &&
			(stands(index) !== stands(index + WALL_CORNERS - 1) || index % 3 === 0),
	)
	const along = (index: number, width: number, height: number, depth: number, y: number, color: string) => {
		const [from, to] = [corner(index), corner(index + 1)]
		return part(
			new THREE.BoxGeometry(Math.hypot(to[0] - from[0], to[1] - from[1]) + width, height, depth),
			color,
			{
				position: [(from[0] + to[0]) / 2, y, (from[1] + to[1]) / 2],
				turn: -Math.atan2(to[1] - from[1], to[0] - from[0]),
			},
		)
	}
	return {
		solid: [
			...Arr.map(stretches, (index) => along(index, 0, 0.3, 0.09, 0.15, palette.stone)),
			...Arr.flatMap(towers, (index) => {
				const [x, z] = corner(index)
				return [
					part(new THREE.CylinderGeometry(0.11, 0.125, 0.44, 8), palette.stone, {
						position: [x, 0.22, z],
					}),
					part(new THREE.ConeGeometry(0.15, 0.17, 8), roof, { position: [x, 0.525, z] }),
				]
			}),
		],
		trim: Arr.map(stretches, (index) => along(index, 0.02, 0.035, 0.12, 0.3, palette.stoneLight)),
	}
}

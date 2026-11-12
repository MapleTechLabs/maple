import { Array as Arr } from "effect"
import * as THREE from "three"
import type { Point } from "./hex"
import type { TilePalette } from "./palette"
import { fuse, part, ribbon, seeded, type Vec3 } from "./solid"

// The two ways between tiles: a dirt road straight across a shared side, and a railway on a
// gravel bed along the tile borders, with its points and its stations.

/** Where a road leaves a village square, from the tile's middle. */
const SQUARE = 0.45
/** How wide a road is: a footpath on the quietest link, a highway on the busiest. */
const ROAD_WIDTH = { quiet: 0.28, busy: 0.52 }

export interface Way {
	readonly geometry: THREE.BufferGeometry
	/** The road's middle, square to square: carts keep to the right of it. */
	readonly track: ReadonlyArray<Vec3>
}

/** A point `along` the way `heading` faces and `aside` to its right. */
const beside = ([x, z]: Point, heading: number, along: number, aside: number): Vec3 => [
	x + Math.cos(heading) * along - Math.sin(heading) * aside,
	0,
	z + Math.sin(heading) * along + Math.cos(heading) * aside,
]

const lifted = ([x, , z]: Vec3, y: number): Vec3 => [x, y, z]

const shade = (color: string, by: number): string => new THREE.Color(color).multiplyScalar(by).getStyle()

/** Points `spacing` apart from `from` towards `to`, starting and stopping `inset` short of each end. */
const paced = (from: Point, to: Point, spacing: number, inset: number): ReadonlyArray<Point> => {
	const length = Math.hypot(to[0] - from[0], to[1] - from[1])
	const room = length - inset * 2
	if (room <= 0) return []
	const steps = Math.max(1, Math.round(room / spacing))
	return Arr.makeBy(steps + 1, (step): Point => {
		const along = (inset + (room * step) / steps) / length
		return [from[0] + (to[0] - from[0]) * along, from[1] + (to[1] - from[1]) * along]
	})
}

/** A road from one tile's square to the next one's. How busy the link is (`busy`, 0 for the
 * quietest road on the map to 1 for the busiest) says what kind of road it is: a footpath of
 * stepping stones, a cart road with a cobble here and there, or a paved highway between stone kerbs. Every road
 * has a darker verge, and a milestone where it crosses from one tile to the next. */
export const buildRoad = (from: Point, to: Point, palette: TilePalette, busy = 0.5): Way => {
	const length = Math.hypot(to[0] - from[0], to[1] - from[1])
	const angle = Math.atan2(to[1] - from[1], to[0] - from[0])
	const at = (distance: number): Point => [
		from[0] + Math.cos(angle) * distance,
		from[1] + Math.sin(angle) * distance,
	]
	const start = at(SQUARE)
	const end = at(length - SQUARE)
	const line = [start, end]
	const width = ROAD_WIDTH.quiet + (ROAD_WIDTH.busy - ROAD_WIDTH.quiet) * Math.min(1, Math.max(0, busy))
	const turn = -angle
	const isPath = busy < 0.25
	const isHighway = busy >= 0.6
	const stones = isPath
		? Arr.map(paced(start, end, 0.3, 0.12), ([x, z], index) =>
				part(
					new THREE.BoxGeometry(0.13, 0.012, 0.1),
					index % 2 === 0 ? palette.stoneLight : palette.stone,
					{
						position: [x, 0.033, z],
						turn: turn + (index % 3) * 0.4,
					},
				),
			)
		: []
	// Cobbles here and there across a cart road. Never two lines along it: that is a railway.
	const random = seeded(
		`road:${from[0].toFixed(2)}:${from[1].toFixed(2)}:${to[0].toFixed(2)}:${to[1].toFixed(2)}`,
	)
	const cobbles = isPath
		? []
		: Arr.map(paced(start, end, isHighway ? 0.16 : 0.28, 0.1), ([x, z]) => {
				const size = 0.05 + random() * 0.05
				return part(
					new THREE.BoxGeometry(size * 1.3, 0.008, size),
					shade(random() < 0.5 ? palette.stoneLight : palette.road, 0.9 + random() * 0.08),
					{
						position: lifted(beside([x, z], angle, 0, (random() - 0.5) * (width - 0.12)), 0.033),
						turn: turn + random() * Math.PI,
					},
				)
			})
	const kerbs = isHighway
		? Arr.flatMap([-1, 1], (side) =>
				Arr.map(paced(start, end, 0.2, 0.08), ([x, z], index) =>
					part(
						new THREE.BoxGeometry(0.15, 0.04, 0.05),
						index % 2 === 0 ? palette.stoneLight : palette.stone,
						{ position: lifted(beside([x, z], angle, 0, (side * width) / 2), 0.035), turn },
					),
				),
			)
		: []
	// The milestone stands at the border between the two tiles, on the right of the road.
	const border = at(length / 2)
	const milestone = [
		part(new THREE.BoxGeometry(0.07, 0.15, 0.07), palette.stoneLight, {
			position: lifted(beside(border, angle, 0, width / 2 + 0.13), 0.075),
			turn,
		}),
		part(new THREE.BoxGeometry(0.08, 0.03, 0.08), palette.banner, {
			position: lifted(beside(border, angle, 0, width / 2 + 0.13), 0.165),
			turn,
		}),
	]
	return {
		geometry: fuse([
			ribbon(line, 0.022, width + 0.1, shade(palette.road, 0.86)),
			ribbon(line, 0.03, width, palette.road),
			...cobbles,
			...stones,
			...kerbs,
			...milestone,
		]),
		track: [
			[start[0], 0.03, start[1]],
			[end[0], 0.03, end[1]],
		],
	}
}

/** `line` as points at most `spacing` apart, corners kept: sleepers are laid on these. */
const resample = (line: ReadonlyArray<Point>, spacing: number): ReadonlyArray<Point> =>
	Arr.flatMap(line, (point, index) => {
		const after = line[index + 1]
		if (after === undefined) return [point]
		const steps = Math.max(1, Math.round(Math.hypot(after[0] - point[0], after[1] - point[1]) / spacing))
		return Arr.makeBy(steps, (step): Point => {
			const t = step / steps
			return [point[0] + (after[0] - point[0]) * t, point[1] + (after[1] - point[1]) * t]
		})
	})

/** How high the top of the rails stands: trains ride on it. */
export const RAIL_TOP = 0.065

/** How far apart the telegraph poles stand along a railway, in sleepers' spacings. */
const POLE_EVERY = 9

/** The telegraph beside a railway: a pole every so often on the side away from the platforms,
 * and the wire from one to the next. A stretch too short for a pole has none. */
const telegraph = (laid: ReadonlyArray<Point>, palette: TilePalette): ReadonlyArray<THREE.BufferGeometry> => {
	const tops = Arr.flatMap(laid, ([x, z], index): Array<Vec3> => {
		const after = laid[index + 1]
		const isDue = index % POLE_EVERY === Math.floor(POLE_EVERY / 2)
		if (after === undefined || !isDue || index < 3 || index > laid.length - 4) return []
		return [lifted(beside([x, z], Math.atan2(after[1] - z, after[0] - x), 0, -0.36), 0.44)]
	})
	const poles = Arr.flatMap(tops, ([x, y, z]) => [
		part(new THREE.BoxGeometry(0.035, y, 0.035), palette.timber, { position: [x, y / 2, z] }),
		part(new THREE.BoxGeometry(0.16, 0.022, 0.022), palette.timber, { position: [x, y - 0.05, z] }),
	])
	const wires = Arr.map(Arr.zip(tops, Arr.drop(tops, 1)), ([a, b]) =>
		part(new THREE.BoxGeometry(Math.hypot(b[0] - a[0], b[2] - a[2]), 0.008, 0.008), palette.steel, {
			position: [(a[0] + b[0]) / 2, a[1] - 0.03, (a[2] + b[2]) / 2],
			turn: -Math.atan2(b[2] - a[2], b[0] - a[0]),
		}),
	)
	return [...poles, ...wires]
}

/** One stretch of railway along `line`: a gravel bed on a darker shoulder, sleepers, two rails,
 * and the telegraph alongside. */
export const buildTrack = (line: ReadonlyArray<Point>, palette: TilePalette): THREE.BufferGeometry => {
	const laid = resample(line, 0.2)
	const sleepers = Arr.flatMap(laid, ([x, z], index) => {
		const after = laid[index + 1]
		if (after === undefined || index % 2 === 1) return []
		return [
			part(new THREE.BoxGeometry(0.07, 0.02, 0.3), palette.timber, {
				position: [x, 0.045, z],
				turn: -Math.atan2(after[1] - z, after[0] - x),
			}),
		]
	})
	return fuse([
		ribbon(laid, 0.028, 0.48, shade(palette.gravel, 0.88)),
		ribbon(laid, 0.035, 0.36, palette.gravel),
		...sleepers,
		...telegraph(laid, palette),
		ribbon(laid, 0.062, 0.035, palette.steel, -0.085),
		ribbon(laid, 0.062, 0.035, palette.steel, 0.085),
	])
}

/** The lever beside a set of points: a post with a signal disc, on a timber base, and the long
 * timbers the blades slide on. `heading` is the way a train faces as it runs into the junction. */
export const buildPoints = (
	at: Point,
	heading: number,
	palette: TilePalette,
): ReadonlyArray<THREE.BufferGeometry> => {
	const post = beside(at, heading, 0, 0.34)
	const turn = -heading
	return [
		...Arr.map([0.1, 0.3, 0.5], (along) =>
			part(new THREE.BoxGeometry(0.07, 0.022, 0.5), palette.timber, {
				position: lifted(beside(at, heading, along, 0.06), 0.046),
				turn,
			}),
		),
		part(new THREE.BoxGeometry(0.16, 0.03, 0.1), palette.timber, { position: lifted(post, 0.05), turn }),
		part(new THREE.BoxGeometry(0.022, 0.3, 0.022), palette.steel, { position: lifted(post, 0.2), turn }),
		part(new THREE.CylinderGeometry(0.06, 0.06, 0.016, 10).rotateZ(Math.PI / 2), palette.banner, {
			position: lifted(post, 0.36),
			turn,
		}),
		part(new THREE.BoxGeometry(0.02, 0.02, 0.2), palette.steel, {
			position: lifted(beside(at, heading, 0, 0.22), 0.07),
			turn,
		}),
	]
}

/** How long a station's platform is, from the buffer along the track. */
const PLATFORM = 0.95

/** The end of a line: a buffer stop across the track, a platform beside it and a small shelter.
 * `heading` is the way the track leaves the buffer. */
export const buildStation = (
	at: Point,
	heading: number,
	palette: TilePalette,
): ReadonlyArray<THREE.BufferGeometry> => {
	const turn = -heading
	const platform = beside(at, heading, PLATFORM / 2 - 0.05, 0.33)
	const shelter = beside(at, heading, 0.22, 0.37)
	return [
		part(new THREE.BoxGeometry(0.05, 0.14, 0.26), palette.timber, {
			position: lifted(beside(at, heading, -0.06, 0), 0.11),
			turn,
		}),
		part(new THREE.BoxGeometry(0.03, 0.07, 0.2), palette.banner, {
			position: lifted(beside(at, heading, -0.03, 0), 0.13),
			turn,
		}),
		part(new THREE.BoxGeometry(PLATFORM, 0.06, 0.24), palette.stoneLight, {
			position: lifted(platform, 0.03),
			turn,
		}),
		part(new THREE.BoxGeometry(0.3, 0.16, 0.12), palette.plank, {
			position: lifted(shelter, 0.14),
			turn,
		}),
		part(new THREE.BoxGeometry(0.38, 0.025, 0.24), palette.banner, {
			position: lifted(beside(at, heading, 0.22, 0.33), 0.235),
			turn,
		}),
	]
}

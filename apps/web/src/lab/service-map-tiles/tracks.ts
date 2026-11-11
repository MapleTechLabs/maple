import { Array as Arr } from "effect"
import * as THREE from "three"
import type { Point } from "./hex"
import type { TilePalette } from "./palette"
import { fuse, part, ribbon, type Vec3 } from "./solid"

// The two ways between tiles: a dirt road straight across a shared side, and a railway on a
// gravel bed along the tile borders, with its points and its stations.

/** Where a road leaves a village square, from the tile's middle. */
const SQUARE = 0.45
const ROAD_WIDTH = 0.38

export interface Way {
	readonly geometry: THREE.BufferGeometry
	/** The road's middle, square to square: carts keep to the right of it. */
	readonly track: ReadonlyArray<Vec3>
}

/** A road from one tile's square to the next one's. */
export const buildRoad = (from: Point, to: Point, palette: TilePalette): Way => {
	const length = Math.hypot(to[0] - from[0], to[1] - from[1])
	const angle = Math.atan2(to[1] - from[1], to[0] - from[0])
	const at = (distance: number): Point => [
		from[0] + Math.cos(angle) * distance,
		from[1] + Math.sin(angle) * distance,
	]
	const start = at(SQUARE)
	const end = at(length - SQUARE)
	return {
		geometry: part(
			new THREE.BoxGeometry(length - SQUARE * 2, 0.02, ROAD_WIDTH).translate(length / 2, 0.02, 0),
			palette.road,
			{ position: [from[0], 0, from[1]], turn: -angle },
		),
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

/** One stretch of railway along `line`: a gravel bed, sleepers and two rails. */
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
		ribbon(laid, 0.035, 0.36, palette.gravel),
		...sleepers,
		ribbon(laid, 0.062, 0.035, palette.steel, -0.085),
		ribbon(laid, 0.062, 0.035, palette.steel, 0.085),
	])
}

/** A point `along` the way `heading` faces and `aside` to its right. */
const beside = ([x, z]: Point, heading: number, along: number, aside: number): Vec3 => [
	x + Math.cos(heading) * along - Math.sin(heading) * aside,
	0,
	z + Math.sin(heading) * along + Math.cos(heading) * aside,
]

const lifted = ([x, , z]: Vec3, y: number): Vec3 => [x, y, z]

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

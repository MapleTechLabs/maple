import { Array as Arr } from "effect"
import * as THREE from "three"
import type { Point } from "./hex"
import type { TilePalette } from "./palette"
import { fuse, part, ribbon, type Vec3 } from "./solid"

// The two ways between tiles: a dirt road straight across a shared side, and a railway on a
// gravel bed along the tile borders.

/** Where a road leaves a village square, from the tile's middle. */
const SQUARE = 0.45
const ROAD_WIDTH = 0.38

export interface Way {
	readonly geometry: THREE.BufferGeometry
	/** The line a cart or an engine follows, end to end. */
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

/** A railway through `points`: a gravel bed, sleepers and two rails, bent smoothly at each corner. */
export const buildRail = (points: ReadonlyArray<Point>, palette: TilePalette): Way => {
	const curve = new THREE.CatmullRomCurve3(
		Arr.map(points, ([x, z]) => new THREE.Vector3(x, 0, z)),
		false,
		"centripetal",
	)
	const line = Arr.map(
		curve.getSpacedPoints(Math.max(2, Math.round(curve.getLength() / 0.2))),
		(point): Point => [point.x, point.z],
	)
	const sleepers = Arr.flatMap(line, ([x, z], index) => {
		const after = line[index + 1]
		if (after === undefined || index % 2 === 1) return []
		return [
			part(new THREE.BoxGeometry(0.07, 0.02, 0.3), palette.timber, {
				position: [x, 0.045, z],
				turn: -Math.atan2(after[1] - z, after[0] - x),
			}),
		]
	})
	return {
		geometry: fuse([
			ribbon(line, 0.035, 0.36, palette.gravel),
			...sleepers,
			ribbon(line, 0.062, 0.035, palette.steel, -0.085),
			ribbon(line, 0.062, 0.035, palette.steel, 0.085),
		]),
		track: Arr.map(line, ([x, z]): Vec3 => [x, 0.065, z]),
	}
}

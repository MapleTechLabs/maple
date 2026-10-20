import type { FactoryLink } from "./factory-routing"
import {
	beltGap,
	beltPoints,
	type BeltPoints,
	blob,
	type Blob,
	type Creek,
	creekPath,
	hillOf,
	lakeOf,
	fbm,
	type Meadow,
	meadowOf,
	smoothstep,
	type Zone,
	zoneGap,
	zonesOf,
} from "./maple-scenery-field"
import { hash } from "./maple-scenery-sketch"
import type { District } from "./spatial-layout"

/** Everything the planting avoids or follows: zones, belts, the meadow edge and the creek. */
export interface World {
	zones: Zone[]
	belts: BeltPoints
	meadow: Meadow
	creek: Creek
	lake: Blob
	/** Hill terraces, widest first. */
	hill: Blob[]
}

export function worldOf(districts: ReadonlyArray<District>, links: ReadonlyArray<FactoryLink>): World {
	const zones = zonesOf(districts)
	const belts = beltPoints(links)
	const meadow = meadowOf(zones)
	const lake = lakeOf(zones, belts, meadow)
	const hill = hillOf(zones, belts, meadow)
	return { zones, belts, meadow, lake, hill, creek: creekPath(zones, belts, meadow, lake) }
}

/** Positive within `margin` of the lake or the hill's footprint. */
export const onLand = (world: World, x: number, z: number, margin: number) =>
	world.lake.rim(x, z) > -margin || (world.hill[0]?.rim(x, z) ?? -Infinity) > -margin

/** Distance from the creek's nearer bank; negative in the water. */
export const creekGap = (creek: Creek, x: number, z: number) =>
	creek.samples.reduce((gap, p) => Math.min(gap, Math.hypot(x - p.x, z - p.z) - p.w), Infinity)

/** Room for a landmark: clear of zones by `gap`, of belts by 0.75 plus a little, and of the creek. */
function roomy(world: World, x: number, z: number, gap: number) {
	return (
		zoneGap(world.zones, x, z) >= gap &&
		beltGap(world.belts, x, z) >= Math.max(0.75, gap - 0.4) &&
		creekGap(world.creek, x, z) >= 0.6 &&
		!onLand(world, x, z, 0.5)
	)
}

/** The first point along a ray, past the outermost zone, with room for a landmark. */
function along(world: World, theta: number, gap: number) {
	const { meadow } = world
	const at = (r: number) => [meadow.cx + Math.cos(theta) * r, meadow.cz + Math.sin(theta) * r] as const
	const radii = Array.from({ length: Math.ceil(meadow.reach / 0.2) }, (_, i) => i * 0.2)
	// Skip the gaps between zones: only look beyond the last point still near one.
	const past = radii.reduce((last, r) => (zoneGap(world.zones, ...at(r)) < gap ? r : last), 0)
	const radius = radii.find((r) => r > past && roomy(world, ...at(r), gap))
	return at(radius ?? meadow.radiusAt(theta))
}

/** Landmarks the forest grows around. The campfire and fence sit on the screen-left side,
 * away from the creek, so the smoke rises clear of the machines. */
export function landmarks(world: World) {
	const { creek, lake, meadow } = world
	const ford = creek.at(creek.bridge),
		snag = creek.at(creek.length * 0.55)
	const bearing = Math.atan2(lake.cz - meadow.cz, lake.cx - meadow.cx)
	// The dock faces the clearing, turned away from where the creek leaves the lake.
	const dockAngle = bearing + Math.PI + 0.7
	const shore = (angle: number, out: number) =>
		[
			lake.cx + Math.cos(angle) * (lake.radiusAt(angle) + out),
			-0.14,
			lake.cz + Math.sin(angle) * (lake.radiusAt(angle) + out),
		] as const
	const [fx, fz] = along(world, 0.8 * Math.PI, 2.2)
	const fenceTheta = 0.97 * Math.PI
	const [mx, mz] = along(world, fenceTheta, 1.8)
	const [tx, tz] = [-Math.sin(fenceTheta), Math.cos(fenceTheta)]
	// The longest fence, up to 3.4 units, whose every post keeps clear.
	const half =
		[1.7, 1.2, 0.8, 0.4].find((h) =>
			Array.from({ length: 7 }, (_, i) => -h + (2 * h * i) / 6).every((d) =>
				roomy(world, mx + tx * d, mz + tz * d, 0.9),
			),
		) ?? 0.3
	const floor = -0.14
	return {
		bridge: { at: [ford.x, floor, ford.z] as const, yaw: Math.atan2(ford.nx, ford.nz) },
		campfire: [fx, floor, fz] as const,
		fence: {
			from: [mx - tx * half, mz - tz * half] as const,
			to: [mx + tx * half, mz + tz * half] as const,
		},
		fox: [mx + tx * (half + 0.7), floor, mz + tz * (half + 0.7)] as const,
		dock: { at: shore(dockAngle, 0.15), yaw: Math.atan2(-Math.cos(dockAngle), -Math.sin(dockAngle)) },
		deer: shore(bearing - 0.6, 0.6),
		perch: [snag.x + snag.nx * (snag.w + 0.75), floor, snag.z + snag.nz * (snag.w + 0.75)] as const,
	}
}

export type Landmarks = ReturnType<typeof landmarks>

function blocked(marks: Landmarks, x: number, z: number) {
	const near = ([sx, , sz]: readonly [number, number, number], r: number) => Math.hypot(x - sx, z - sz) < r
	if (near(marks.campfire, 1.25) || near(marks.bridge.at, 0.95) || near(marks.dock.at, 0.8)) return true
	if ([marks.deer, marks.fox, marks.perch].some((mark) => near(mark, 0.85))) return true
	const [ax, az] = marks.fence.from,
		[bx, bz] = marks.fence.to
	const [dx, dz] = [bx - ax, bz - az]
	const t = Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)))
	return Math.hypot(x - (ax + dx * t), z - (az + dz * t)) < 0.6
}

export type Growth =
	| "maple"
	| "birch"
	| "pine"
	| "spruce"
	| "sapling"
	| "stump"
	| "rock"
	| "bush"
	| "log"
	| "mushrooms"
	| "grass"

export interface Plant {
	kind: Growth
	x: number
	z: number
	seed: number
	/** Shrinks toward the paper beyond the meadow's edge. */
	size: number
	/** Distance outside the nearest zone. */
	gap: number
}

/** Woods shaped by a distance field to the zones plus low-frequency noise: groves hug some
 * zones, meadow bays open by others, lobes reach outward and outliers thin into the paper.
 * The gaps between zones get small planting wherever no belt runs. */
export function forestPlan(world: World, marks: Landmarks, ground: Ground) {
	const { meadow } = world
	const extent = Math.max(...meadow.radii) + 5.5
	const step = 1.15
	const cells = Math.ceil((extent * 2) / step)
	return Array.from({ length: cells * cells }, (_, n): Plant | null => {
		const gx = meadow.cx - extent + (n % cells) * step,
			gz = meadow.cz - extent + Math.floor(n / cells) * step
		const x = gx + (hash(gx, gz) - 0.5) * 0.8,
			z = gz + (hash(gz, gx) - 0.5) * 0.8
		const out = -meadow.rim(x, z)
		if (out > 5) return null
		const gap = zoneGap(world.zones, x, z)
		if (gap < 0.35) return null
		const belt = beltGap(world.belts, x, z)
		if (belt < 0.75 || creekGap(world.creek, x, z) < 0.45 || blocked(marks, x, z)) return null
		if (onLand(world, x, z, 0.4) || underfoot(ground, x, z, 0.3)) return null
		const grove = fbm(x * 0.2 + 11, z * 0.2 - 4)
		const chance =
			out > 0
				? (1 - smoothstep(0, 5, out)) * (0.3 + 0.55 * grove)
				: smoothstep(0.36, 0.7, grove) * 0.9 + (gap < 0.9 ? 0.15 : 0)
		if (hash(x * 3.1, z * 0.7) > chance) return null
		const seed = hash(x * 1.7, z),
			roll = hash(z, x * 2.3)
		// Trees need room for their crowns; tight spots by zones and belts get low growth only.
		const tight = gap < 0.9 || belt < 1.1
		// Small debris stays on the meadow; past its edge only trees thin into the paper.
		if ((tight || seed < 0.3) && out > 0.5) return null
		const kind = tight ? low(roll) : seed < 0.3 ? undergrowth(roll) : canopy(roll)
		const size = (1 - 0.45 * smoothstep(0, 5, out)) * (tight ? 0.8 : 1)
		return { kind, x, z, seed, size, gap }
	}).filter((plant): plant is Plant => plant !== null)
}

const canopy = (roll: number): Growth =>
	roll < 0.2
		? "pine"
		: roll < 0.32
			? "spruce"
			: roll < 0.44
				? "birch"
				: roll < 0.5
					? "sapling"
					: roll < 0.54
						? "stump"
						: "maple"

const undergrowth = (roll: number): Growth =>
	roll < 0.28 ? "rock" : roll < 0.55 ? "bush" : roll < 0.66 ? "log" : roll < 0.76 ? "mushrooms" : "grass"

const low = (roll: number): Growth =>
	roll < 0.35 ? "grass" : roll < 0.65 ? "bush" : roll < 0.85 ? "rock" : "sapling"

/** Open meadow ground for tufts and flowers: off the zones, belts, water and landmarks. */
export const openGround = (world: World, marks: Landmarks, ground: Ground, x: number, z: number) =>
	zoneGap(world.zones, x, z) >= 0.35 &&
	beltGap(world.belts, x, z) >= 0.75 &&
	creekGap(world.creek, x, z) >= 0.3 &&
	!blocked(marks, x, z) &&
	!onLand(world, x, z, 0.2) &&
	!underfoot(ground, x, z, 0.1)

/** On a mound or a footpath, give or take `margin`. */
const underfoot = (ground: Ground, x: number, z: number, margin: number) =>
	ground.pathGap(x, z) < 0.25 + margin ||
	ground.mounds.some((layers) => (layers[0]?.rim(x, z) ?? -1) > -margin)

type Point = readonly [number, number]

/** Low mounds in the outer meadow and footpaths out to the campfire and the dock. */
export function groundOf(world: World, marks: Landmarks) {
	const { meadow } = world
	const landmarks: Point[] = [
		marks.campfire,
		marks.dock.at,
		marks.bridge.at,
		marks.deer,
		marks.fox,
		marks.perch,
	].map(([x, , z]) => [x, z] as const)
	const footpath = (end: Point) => {
		const bearing = Math.atan2(end[1] - meadow.cz, end[0] - meadow.cx)
		return (
			[-0.4, 0.4]
				.map((turn) => trail(along(world, bearing + turn, 1.1), end))
				.find((points) =>
					points.every(([x, z], i) => i > points.length - 4 || walkable(world, x, z)),
				) ?? null
		)
	}
	const paths = [
		footpath([marks.campfire[0], marks.campfire[2]]),
		footpath([marks.dock.at[0], marks.dock.at[2]]),
	].filter((path): path is Point[] => path !== null)
	const pathGap = (x: number, z: number) =>
		paths.flat().reduce((gap, [px, pz]) => Math.min(gap, Math.hypot(x - px, z - pz)), Infinity)
	const mounds = Array.from({ length: 24 }, (_, i) => {
		const radius = 0.9 + hash(i, 3.3) * 0.5
		const [x, z] = meadow.point(hash(i, 9.9) * Math.PI * 2, 0.8 + hash(5.5, i) * 1.8 + radius)
		const room = radius * 1.3
		const clear =
			zoneGap(world.zones, x, z) >= room + 0.9 &&
			beltGap(world.belts, x, z) >= room + 0.75 &&
			creekGap(world.creek, x, z) >= room + 0.3 &&
			!onLand(world, x, z, room + 0.3) &&
			pathGap(x, z) >= room + 0.3 &&
			landmarks.every(([lx, lz]) => Math.hypot(x - lx, z - lz) >= room + 0.8)
		return clear ? { x, z, radius, steps: 1 + Math.floor(hash(z, x) * 2) } : null
	})
		.filter((mound): mound is { x: number; z: number; radius: number; steps: number } => mound !== null)
		.filter((mound, i, all) =>
			all.slice(0, i).every((other) => Math.hypot(mound.x - other.x, mound.z - other.z) > 3.5),
		)
		.slice(0, 3)
		.map((mound, i) =>
			Array.from({ length: mound.steps }, (_, step) =>
				blob(mound.x, mound.z, mound.radius * (1 - step * 0.45), 0.25, 8.3 + i * 1.7, 24),
			),
		)
	return { paths, mounds, pathGap }
}

export type Ground = ReturnType<typeof groundOf>

/** Paths keep off zones and belts with room to spare, and off the water and the hill. */
function walkable(world: World, x: number, z: number) {
	return (
		zoneGap(world.zones, x, z) >= 0.9 &&
		beltGap(world.belts, x, z) >= 0.9 &&
		creekGap(world.creek, x, z) >= 0.3 &&
		world.lake.rim(x, z) < -0.1 &&
		(world.hill[0]?.rim(x, z) ?? -1) < -0.3
	)
}

/** A winding trail: a bowed curve between two points with a little noise along it. */
function trail([ax, az]: Point, [bx, bz]: Point): Point[] {
	const length = Math.hypot(bx - ax, bz - az) || 1
	const [px, pz] = [-(bz - az) / length, (bx - ax) / length]
	const bow = (hash(ax, bz) - 0.5) * 2 * Math.min(1.2, length * 0.3)
	const count = Math.max(6, Math.ceil(length / 0.3))
	return Array.from({ length: count + 1 }, (_, i) => {
		const t = i / count
		const sway =
			bow * 4 * t * (1 - t) + (fbm(ax + t * 3, az - t * 3) - 0.5) * 0.35 * Math.sin(Math.PI * t)
		return [ax + (bx - ax) * t + px * sway, az + (bz - az) * t + pz * sway] as const
	})
}

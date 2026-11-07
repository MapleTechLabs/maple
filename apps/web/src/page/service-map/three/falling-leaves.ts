import { Array as Arr, Option } from "effect"
import { hash } from "../../../components/service-map/three/maple-scenery-sketch"
import type { District } from "../../../components/service-map/three/spatial-layout"

// Where a falling leaf is at time `t`, as a pure function, so motion never accumulates drift and
// a paused map holds every leaf exactly. Each leaf runs a cycle: it grows in at a crown, flutters
// down on the shared breeze, settles flat on the ground, rests, shrinks away and waits.

/** A deciduous crown leaves can break off: its centre, height and spread. */
export interface LeafSource {
	readonly x: number
	readonly z: number
	readonly top: number
	readonly radius: number
}

export interface LeafPose {
	readonly x: number
	readonly y: number
	readonly z: number
	/** Euler angles in radians (XYZ). */
	readonly rx: number
	readonly ry: number
	readonly rz: number
	/** 0 while hidden, 1 while fully grown. */
	readonly scale: number
}

/** Seconds a leaf takes to bud on the crown and to shrink away after resting. */
const GROW = 0.6
const SHRINK = 0.9
/** The breeze: a steady drift with slow gusts, the same for every leaf. */
const WIND_DIRECTION = { x: 0.92, z: -0.39 }

/** Breeze speed (units per second) at time `t`: gentle, with gusts every half minute or so. */
export const windAt = (t: number) => {
	const gust = Math.max(0, Math.sin(t * 0.21) * Math.sin(t * 0.083 + 1.3))
	return 0.12 + 0.05 * Math.sin(t * 0.37) + 0.28 * gust
}

/** Where a leaf comes to rest: on a zone's grass, else the meadow floor. */
export const groundAt = (districts: ReadonlyArray<District>, floor: number, x: number, z: number) => {
	const zone = Arr.findFirst(
		districts,
		(d) => Math.abs(x - d.position[0]) <= d.width / 2 && Math.abs(z - d.position[2]) <= d.depth / 2,
	)
	return Option.match(zone, { onNone: () => floor + 0.012, onSome: (d) => d.position[1] + 0.168 })
}

export interface LeafWorld {
	readonly sources: ReadonlyArray<LeafSource>
	readonly districts: ReadonlyArray<District>
	readonly floor: number
}

/** Leaf `index`'s pose at `t`. The tree, start point, rhythm and rest are drawn per cycle, so a
 * leaf falls from a different crown each time round. */
export const leafPose = (world: LeafWorld, index: number, t: number): LeafPose => {
	const hidden: LeafPose = { x: 0, y: -100, z: 0, rx: 0, ry: 0, rz: 0, scale: 0 }
	if (world.sources.length === 0) return hidden
	// A fixed cycle per leaf, long enough for the tallest fall plus rest and a pause.
	const cycle = 22 + hash(index, 9.1) * 10
	const clock = t + hash(index, 4.4) * cycle
	const round = Math.floor(clock / cycle)
	const age = clock - round * cycle
	const pick = (salt: number) => hash(index * 7.3 + round * 1.7, salt)

	const source = world.sources[Math.floor(pick(1) * world.sources.length)] ?? world.sources[0]
	if (source === undefined) return hidden
	const angle = pick(2) * Math.PI * 2
	const reach = Math.sqrt(pick(3)) * source.radius
	const start = {
		x: source.x + Math.cos(angle) * reach,
		y: source.top * (0.7 + pick(4) * 0.25),
		z: source.z + Math.sin(angle) * reach,
	}
	// Flutter: a pendulum across the breeze, its own period, size and starting side.
	const period = 1.6 + pick(5) * 1.4
	const omega = (Math.PI * 2) / period
	const swing = 0.16 + pick(6) * 0.2
	const phase = pick(7) * Math.PI * 2
	const sink = 0.22 + pick(8) * 0.12
	const tumbler = pick(9) < 0.2
	// Bigger than the litter: a falling leaf is seen against the meadow from far above.
	const size = 1.3 + pick(10) * 0.6
	// The breeze when it let go carries it the whole way down.
	const wind = windAt(t - age)
	const across = { x: -WIND_DIRECTION.z, z: WIND_DIRECTION.x }

	const at = (u: number, calm = 1) => {
		const sway = Math.sin(omega * u + phase) * swing
		const drift = wind * u
		return {
			x: start.x + WIND_DIRECTION.x * drift + across.x * sway,
			z: start.z + WIND_DIRECTION.z * drift + across.z * sway,
			// It sinks fastest through the middle of a swing and floats at the ends.
			y: start.y - sink * u + 0.05 * calm * Math.cos(2 * (omega * u + phase)),
		}
	}
	// Fall time to the ground under where it is heading, refined once for the landing spot.
	const firstGuess = Math.max(0.5, (start.y - world.floor) / sink)
	const guess = at(firstGuess)
	const ground = groundAt(world.districts, world.floor, guess.x, guess.z)
	const fall = Math.max(0.5, (start.y - ground) / sink)
	const rest = 4 + pick(11) * 5
	const yaw = pick(12) * Math.PI * 2

	// Euler XYZ on a leaf drawn in its XY plane: rz spins it in its own plane (its heading once
	// flat), ry rocks it into the swing, and rx lays it down (-PI/2 is flat).
	const spin = (u: number) => yaw + u * 0.25
	// A tumbler turns end over end, then eases into the whole turn nearest its landing.
	const TUMBLE_RATE = 3.1
	const landingTurn = Math.round((fall * TUMBLE_RATE) / (Math.PI * 2)) * Math.PI * 2
	const tumble = (u: number, calm: number) => landingTurn + (u * TUMBLE_RATE - landingTurn) * calm
	if (age < fall) {
		// Bob, rocking and pitch ease out over the last half second: it touches down flat, on the ground.
		const calm = Math.min(1, (fall - age) / 0.5)
		const p = at(age, calm)
		const rock = Math.cos(omega * age + phase) * 0.75 * calm
		const grown = Math.min(1, age / GROW)
		return tumbler
			? {
					...p,
					rx: -Math.PI / 2 + tumble(age, calm),
					ry: rock * 0.5,
					rz: spin(age),
					scale: size * grown,
				}
			: { ...p, rx: -Math.PI / 2 + 0.35 * calm, ry: rock, rz: spin(age), scale: size * grown }
	}
	const settled = at(fall, 0)
	const lying = { x: settled.x, y: ground, z: settled.z, rx: -Math.PI / 2, ry: 0, rz: spin(fall) }
	if (age < fall + rest) return { ...lying, scale: size }
	const fading = (age - fall - rest) / SHRINK
	return fading < 1 ? { ...lying, scale: size * (1 - fading) } : hidden
}

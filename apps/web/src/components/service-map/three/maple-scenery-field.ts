import type { FactoryLink } from "./factory-routing"
import { hash } from "./maple-scenery-sketch"
import type { District } from "./spatial-layout"

/** Zone rectangles on the ground plane: centre and half extents. */
export interface Zone {
	cx: number
	cz: number
	hw: number
	hd: number
}

export const zonesOf = (districts: ReadonlyArray<District>): Zone[] =>
	districts.map((d) => ({ cx: d.position[0], cz: d.position[2], hw: d.width / 2, hd: d.depth / 2 }))

/** Signed distance to the nearest zone rectangle: positive outside, negative inside. */
export function zoneGap(zones: ReadonlyArray<Zone>, x: number, z: number) {
	return zones.reduce((gap, zone) => {
		const dx = Math.abs(x - zone.cx) - zone.hw,
			dz = Math.abs(z - zone.cz) - zone.hd
		const signed = Math.hypot(Math.max(dx, 0), Math.max(dz, 0)) + Math.min(Math.max(dx, dz), 0)
		return Math.min(gap, signed)
	}, Infinity)
}

/** Belt curves flattened to ground points about every 0.4 units, as [x, z] pairs. */
export function beltPoints(belts: ReadonlyArray<FactoryLink>) {
	return belts.flatMap((belt) => {
		const count = Math.max(2, Math.ceil(belt.curve.getLength() / 0.4))
		// getPointAt only accepts t in [0, 1].
		return Array.from({ length: count + 1 }, (_, i) => {
			const point = belt.curve.getPointAt(Math.min(1, i / count))
			return [point.x, point.z] as const
		})
	})
}

export type BeltPoints = ReturnType<typeof beltPoints>

export const beltGap = (points: BeltPoints, x: number, z: number) =>
	points.reduce((gap, [px, pz]) => Math.min(gap, Math.hypot(x - px, z - pz)), Infinity)

/** Smooth value noise in [0, 1], seeded so a layout always grows the same land. */
export function noise(x: number, z: number) {
	const i = Math.floor(x),
		j = Math.floor(z)
	const fx = x - i,
		fz = z - j
	const u = fx * fx * (3 - 2 * fx),
		v = fz * fz * (3 - 2 * fz)
	const corner = (a: number, b: number) => hash(a * 1.618 + 0.31, b * 2.414 + 0.77)
	const a = corner(i, j),
		b = corner(i + 1, j),
		c = corner(i, j + 1),
		d = corner(i + 1, j + 1)
	return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}

/** Two octaves of noise: broad groves with some ragged detail. */
export const fbm = (x: number, z: number) => noise(x, z) * 0.65 + noise(x * 2.1 + 5.3, z * 2.1 - 1.7) * 0.35

export const smoothstep = (from: number, to: number, value: number) => {
	const t = Math.min(Math.max((value - from) / (to - from), 0), 1)
	return t * t * (3 - 2 * t)
}

/** Moving average, so an outline has no spikes; `wrap` closes the loop, otherwise ends hold. */
export function soften(values: number[], passes: number, wrap = true) {
	const n = values.length
	const index = (i: number) => (wrap ? (i + n) % n : Math.min(Math.max(i, 0), n - 1))
	return Array.from({ length: passes }).reduce<number[]>(
		(current) =>
			current.map(
				(value, i) =>
					((current[index(i - 1)] ?? value) + value * 2 + (current[index(i + 1)] ?? value)) / 4,
			),
		values,
	)
}

/** Bearings from the zones' centre (x = cos, z = sin) for the big landforms. Lake and hill
 * sit on the far side (-x, -z), so nothing tall stands between the camera and a machine. */
export function bearings(zones: ReadonlyArray<Zone>) {
	const jitter = (hash(zones.length, 2.7) - 0.5) * 0.4
	return {
		lake: -0.38 * Math.PI + jitter,
		hill: -0.74 * Math.PI + jitter * 0.5,
		bay: 0.55 * Math.PI - jitter,
	}
}

/** A smooth angular bump centred on `at`, wrapping round the circle. */
const bump = (theta: number, at: number, width: number) => {
	const diff = Math.atan2(Math.sin(theta - at), Math.cos(theta - at))
	return Math.exp(-((diff / width) ** 2))
}

/** The meadow: a blobby outline round the zones, 3 to 7 units out depending on the noise.
 * Polar around the zones' centre, so every zone sits inside however the lobes fall. */
export function meadowOf(zones: ReadonlyArray<Zone>) {
	const xs = zones.flatMap((z) => [z.cx - z.hw, z.cx + z.hw]),
		zs = zones.flatMap((z) => [z.cz - z.hd, z.cz + z.hd])
	const cx = (Math.min(...xs) + Math.max(...xs)) / 2,
		cz = (Math.min(...zs) + Math.max(...zs)) / 2
	const reach = Math.max(...xs.map((x) => Math.abs(x - cx)), ...zs.map((z) => Math.abs(z - cz))) * 1.5 + 9
	const count = 120
	const raw = Array.from({ length: count }, (_, k) => {
		const theta = (k / count) * Math.PI * 2
		const { lake, hill, bay } = bearings(zones)
		// Big seeded lobes make the silhouette lopsided: a far reach for the lake, a
		// shoulder for the hill, and a bay pulled in close on one side.
		const margin = Math.max(
			2.2,
			3 +
				3.5 * fbm(Math.cos(theta) * 1.4 + 7, Math.sin(theta) * 1.4 + 3) +
				5.5 * bump(theta, lake, 0.5) +
				4.5 * bump(theta, hill, 0.45) -
				3.2 * bump(theta, bay, 0.55),
		)
		// The furthest point along the ray that is still within this margin of some zone.
		return Array.from({ length: Math.ceil(reach / 0.25) }, (_, i) => i * 0.25).reduce(
			(radius, step) =>
				zoneGap(zones, cx + Math.cos(theta) * step, cz + Math.sin(theta) * step) <= margin
					? step
					: radius,
			0,
		)
	})
	const radii = soften(raw, 3)
	const radiusAt = (theta: number) => {
		const f = ((((theta / (Math.PI * 2)) % 1) + 1) % 1) * count
		const i = Math.floor(f) % count
		const a = radii[i] ?? 0,
			b = radii[(i + 1) % count] ?? a
		return a + (b - a) * (f - Math.floor(f))
	}
	/** Positive inside the meadow, negative beyond its edge, in rough units. */
	const rim = (x: number, z: number) => radiusAt(Math.atan2(z - cz, x - cx)) - Math.hypot(x - cx, z - cz)
	const point = (theta: number, inset = 0) => {
		const r = radiusAt(theta) - inset
		return [cx + Math.cos(theta) * r, cz + Math.sin(theta) * r] as const
	}
	return { cx, cz, count, reach, radii, radiusAt, rim, point }
}

export type Meadow = ReturnType<typeof meadowOf>

/** Widest the creek gets, so clearances hold at every width. */
const CREEK_WIDEST = 0.4

/** The creek flows out of the lake, follows the meadow's back and right edge with a noisy
 * meander, and leaves into the paper. It is pushed outward wherever it would come within
 * 0.9 of a zone or 0.75 of a belt. */
export function creekPath(zones: ReadonlyArray<Zone>, belts: BeltPoints, meadow: Meadow, lake: Blob) {
	const from = Math.atan2(lake.cz - meadow.cz, lake.cx - meadow.cx),
		to = 0.3 * Math.PI,
		steps = 160
	const source = Math.hypot(lake.cx - meadow.cx, lake.cz - meadow.cz)
	const thetas = Array.from({ length: steps + 1 }, (_, k) => from + ((to - from) * k) / steps)
	const insets = soften(
		thetas.map((theta, k) => {
			const meander = 1.5 + Math.sin(theta * 9 + 1.3) * 0.45 + (fbm(theta * 2.3, 4.1) - 0.5) * 1.2
			return meander - 4.5 * (1 - smoothstep(0, 0.14, (steps - k) / steps))
		}),
		4,
		false,
	)
	const safe = (x: number, z: number) =>
		zoneGap(zones, x, z) >= 0.9 + CREEK_WIDEST && beltGap(belts, x, z) >= 0.75 + CREEK_WIDEST
	const pushed = thetas.map((theta, k) => {
		// Near its source the creek leaves the lake's centre and eases out to the edge track.
		const track = meadow.radiusAt(theta) - (insets[k] ?? 0)
		const start = source + (track - source) * smoothstep(0, 0.16, k / steps)
		const tries = Array.from({ length: 60 }, (_, i) => start + i * 0.2)
		return (
			tries.find((r) => safe(meadow.cx + Math.cos(theta) * r, meadow.cz + Math.sin(theta) * r)) ??
			start + 12
		)
	})
	// Soften the pushes, then keep whichever radius is further out so the clearance still holds.
	const radii = soften(pushed, 3, false).map((r, k) => Math.max(r, pushed[k] ?? r))
	const line = thetas.map(
		(theta, k) =>
			[
				meadow.cx + Math.cos(theta) * (radii[k] ?? 0),
				meadow.cz + Math.sin(theta) * (radii[k] ?? 0),
			] as const,
	)
	return resample(line, meadow)
}

/** Even samples every quarter unit along the creek: centre, outward normal, half width.
 */
function resample(line: ReadonlyArray<readonly [number, number]>, meadow: Meadow) {
	const lengths = line.reduce<number[]>((acc, [x, z], i) => {
		const [px, pz] = line[i - 1] ?? [x, z]
		return [...acc, (acc.at(-1) ?? 0) + Math.hypot(x - px, z - pz)]
	}, [])
	const length = lengths.at(-1) ?? 0
	const bridge = length * 0.4
	const along = (s: number) => {
		const i = Math.max(
			0,
			lengths.findIndex((l) => l >= s),
		)
		const [ax, az] = line[Math.max(0, i - 1)] ?? [0, 0]
		const [bx, bz] = line[i] ?? [ax, az]
		const span = (lengths[i] ?? 0) - (lengths[Math.max(0, i - 1)] ?? 0)
		const f = span > 0 ? (s - (lengths[i - 1] ?? 0)) / span : 0
		return [ax + (bx - ax) * f, az + (bz - az) * f] as const
	}
	const count = Math.max(2, Math.ceil(length / 0.25))
	const samples = Array.from({ length: count + 1 }, (_, k) => {
		const s = (length * k) / count
		const [x, z] = along(s)
		const [ax, az] = along(Math.max(0, s - 0.2)),
			[bx, bz] = along(Math.min(length, s + 0.2))
		const [tx, tz] = [bx - ax, bz - az]
		const norm = Math.hypot(tx, tz) || 1
		// Of the two normals, the outward one points away from the meadow's centre.
		const outward = (x - meadow.cx) * tz - (z - meadow.cz) * tx >= 0 ? 1 : -1
		const w = 0.28 + Math.sin(s * 0.9) * 0.06
		return { x, z, nx: (outward * tz) / norm, nz: (-outward * tx) / norm, w }
	})
	const at = (s: number) => {
		const f = (Math.min(Math.max(s, 0), length) / length) * count
		const i = Math.min(Math.floor(f), count - 1)
		const a = samples[i] ?? samples[0],
			b = samples[i + 1] ?? a
		const t = f - i
		const mix = (p: number, q: number) => p + (q - p) * t
		return a && b
			? {
					x: mix(a.x, b.x),
					z: mix(a.z, b.z),
					nx: mix(a.nx, b.nx),
					nz: mix(a.nz, b.nz),
					w: mix(a.w, b.w),
				}
			: { x: meadow.cx, z: meadow.cz, nx: 0, nz: -1, w: 0.3 }
	}
	return { length, samples, at, bridge }
}

export type Creek = ReturnType<typeof creekPath>

/** An organic closed outline round a centre: polar radii wobbled by noise, softened. */
export function blob(
	cx: number,
	cz: number,
	radius: number,
	wobble: number,
	seed: number,
	count = 40,
	/** Elongation along `axis`, so a shape need not read as a circle. */
	stretch = 0,
	axis = 0,
	/** A shape this one must stay inside, like the step below it. */
	within?: Blob,
): Blob {
	const soft = soften(
		Array.from({ length: count }, (_, k) => {
			const theta = (k / count) * Math.PI * 2
			return (
				radius *
				(1 + wobble * (fbm(Math.cos(theta) * 1.6 + seed, Math.sin(theta) * 1.6 - seed) - 0.5) * 2) *
				(1 + stretch * Math.cos(2 * (theta - axis)))
			)
		}),
		2,
	)
	// Pull in any part that would overhang the shape below, so no step floats.
	const radii = soft.map((r, k) => {
		const theta = (k / count) * Math.PI * 2
		const fits = (q: number) =>
			!within || within.rim(cx + Math.cos(theta) * q, cz + Math.sin(theta) * q) >= 0.03
		return Array.from({ length: 40 }, (_, i) => r * (1 - i * 0.025)).find(fits) ?? r * 0.02
	})
	const radiusAt = (theta: number) => {
		const f = ((((theta / (Math.PI * 2)) % 1) + 1) % 1) * count
		const i = Math.floor(f) % count
		const a = radii[i] ?? radius,
			b = radii[(i + 1) % count] ?? a
		return a + (b - a) * (f - Math.floor(f))
	}
	const outline = radii.map(
		(r, k) =>
			[
				cx + Math.cos((k / count) * Math.PI * 2) * r,
				cz + Math.sin((k / count) * Math.PI * 2) * r,
			] as const,
	)
	/** Positive inside the outline, negative outside. */
	const rim = (x: number, z: number) => radiusAt(Math.atan2(z - cz, x - cx)) - Math.hypot(x - cx, z - cz)
	return { cx, cz, radius, outline, radiusAt, rim }
}

export interface Blob {
	cx: number
	cz: number
	radius: number
	outline: ReadonlyArray<readonly [number, number]>
	radiusAt: (theta: number) => number
	/** Positive inside the outline, negative outside. */
	rim: (x: number, z: number) => number
}

/** The nearest centre along a bearing, past the outermost zone, where a feature of
 * `radius` keeps 0.9 from every zone and 0.75 from every belt. */
export function seat(
	zones: ReadonlyArray<Zone>,
	belts: BeltPoints,
	meadow: Meadow,
	theta: number,
	radius: number,
) {
	const at = (r: number) => [meadow.cx + Math.cos(theta) * r, meadow.cz + Math.sin(theta) * r] as const
	const radii = Array.from({ length: Math.ceil((meadow.reach + 10) / 0.2) }, (_, i) => i * 0.2)
	const past = radii.reduce((last, r) => (zoneGap(zones, ...at(r)) < radius + 0.9 ? r : last), 0)
	const found = radii.find(
		(r) => r > past && zoneGap(zones, ...at(r)) >= radius + 1 && beltGap(belts, ...at(r)) >= radius + 0.9,
	)
	return at(found ?? past + radius + 1)
}

/** The lake: an organic water body on the far side, fed out into the creek. */
export function lakeOf(zones: ReadonlyArray<Zone>, belts: BeltPoints, meadow: Meadow) {
	const radius = 1.9 + hash(zones.length, 4.4) * 0.6
	const [x, z] = seat(zones, belts, meadow, bearings(zones).lake, radius * 1.4)
	return blob(x, z, radius, 0.28, 3.7)
}

/** A rocky outcrop of 3 or 4 steps. Each step has its own outline and stretch, and the
 * upper steps crowd toward the map, so that flank is a steep stone face while the far
 * flank climbs in broad grassy ledges. The steep face looks at the camera. */
export function hillOf(zones: ReadonlyArray<Zone>, belts: BeltPoints, meadow: Meadow) {
	const radius = 2.4 + hash(zones.length, 6.1) * 0.6
	const theta = bearings(zones).hill
	const [x, z] = seat(zones, belts, meadow, theta, radius * 1.6)
	const steep = theta + Math.PI + (hash(z, x) - 0.5) * 0.6
	const steps = 3 + Math.floor(hash(x, z) * 2)
	return Array.from({ length: steps }).reduce<Blob[]>((layers, _, i) => {
		const r = radius * (1 - i * 0.24 - hash(i, x) * 0.06)
		const shift = (radius - r) * 0.8
		const side = (hash(z, i) - 0.5) * 0.5 * i
		const cx = x + Math.cos(steep) * shift - Math.sin(steep) * side,
			cz = z + Math.sin(steep) * shift + Math.cos(steep) * side
		const below = layers.at(-1)
		const layer = blob(
			cx,
			cz,
			r,
			0.3,
			1.9 + i * 2.3,
			32,
			0.15 + hash(i, z) * 0.15,
			theta + hash(x, i) * 2,
			below,
		)
		return [...layers, layer]
	}, [])
}

/** Anything ducks can paddle along: arc length and a pose at each point. */
export interface Waterway {
	length: number
	at: (s: number) => { x: number; z: number; nx: number; nz: number; w: number }
}

/** A loop round the inside of the lake, a little in from the shore; it never ends. */
export function lakeLoop(lake: Blob, inset = 0.55): Waterway {
	const circumference = lake.radius * inset * Math.PI * 2
	return {
		length: circumference,
		at: (s) => {
			const theta = (s / circumference) * Math.PI * 2
			const r = lake.radiusAt(theta) * inset
			return {
				x: lake.cx + Math.cos(theta) * r,
				z: lake.cz + Math.sin(theta) * r,
				nx: Math.cos(theta),
				nz: Math.sin(theta),
				w: lake.radius * 0.25,
			}
		},
	}
}

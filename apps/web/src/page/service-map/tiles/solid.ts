import { Array as Arr, Option, String as Str } from "effect"
import * as THREE from "three"
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js"
import type { Point } from "./hex"

// Building blocks for the landscape's meshes: every part is a non-indexed geometry with baked
// vertex colours, so one tile (or every road) merges into a single mesh and a single ink draw.

export type Vec3 = readonly [number, number, number]

/** A deterministic 0..1 stream from a string, so a tile looks the same on every build. */
export const seeded = (seed: string): (() => number) => {
	const state = {
		value: Arr.reduce(
			Arr.fromIterable(seed),
			2166136261,
			(hash, char) =>
				Math.imul(hash ^ Option.getOrElse(Str.codePointAt(char, 0), () => 0), 16777619) >>> 0,
		),
	}
	return () => {
		state.value = (state.value + 0x6d2b79f5) >>> 0
		const mixed = Math.imul(state.value ^ (state.value >>> 15), 1 | state.value)
		const again = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
		return ((again ^ (again >>> 14)) >>> 0) / 4294967296
	}
}

export const pickFrom = <A>(items: ReadonlyArray<A>, random: () => number, fallback: A): A =>
	items[Math.floor(random() * items.length)] ?? fallback

/** `color` a touch lighter or darker, so a row of roofs is not one flat tone. */
export const vary = (color: string, random: () => number, amount = 0.05): THREE.Color =>
	new THREE.Color(color).offsetHSL((random() - 0.5) * 0.02, 0, (random() - 0.5) * 2 * amount)

export interface Placing {
	readonly position?: Vec3
	/** Turn about the vertical axis, radians. */
	readonly turn?: number
	readonly scale?: Vec3
}

const matrixOf = ({ position = [0, 0, 0], turn = 0, scale = [1, 1, 1] }: Placing): THREE.Matrix4 =>
	new THREE.Matrix4().compose(
		new THREE.Vector3(...position),
		new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), turn),
		new THREE.Vector3(...scale),
	)

/** `geometry` placed and painted one colour, ready to merge. Takes ownership of `geometry`. */
export const part = (
	geometry: THREE.BufferGeometry,
	color: string | THREE.Color,
	placing: Placing = {},
): THREE.BufferGeometry => {
	const flat = geometry.index === null ? geometry : geometry.toNonIndexed()
	if (flat !== geometry) geometry.dispose()
	flat.deleteAttribute("uv")
	flat.applyMatrix4(matrixOf(placing))
	const tone = typeof color === "string" ? new THREE.Color(color) : color
	const count = flat.getAttribute("position").count
	const colors = new Float32Array(count * 3)
	for (let index = 0; index < count; index++) colors.set([tone.r, tone.g, tone.b], index * 3)
	flat.setAttribute("color", new THREE.BufferAttribute(colors, 3))
	if (flat.getAttribute("normal") === undefined) flat.computeVertexNormals()
	return flat
}

/** Applies one more placement to parts that are already painted (a whole house, a whole tree). */
export const moved = (
	parts: ReadonlyArray<THREE.BufferGeometry>,
	placing: Placing,
): ReadonlyArray<THREE.BufferGeometry> => {
	const matrix = matrixOf(placing)
	return Arr.map(parts, (geometry) => geometry.applyMatrix4(matrix))
}

/** One geometry from many parts; the parts are freed. An empty list gives an empty geometry. */
export const fuse = (parts: ReadonlyArray<THREE.BufferGeometry>): THREE.BufferGeometry => {
	if (parts.length === 0) return new THREE.BufferGeometry()
	const merged = mergeGeometries([...parts], false)
	Arr.forEach(parts, (geometry) => geometry.dispose())
	return merged
}

interface Mesh {
	readonly positions: Array<number>
	readonly colors: Array<number>
}

/** Adds a triangle wound so that its face looks along `outward`. */
const triangle = (
	mesh: Mesh,
	a: THREE.Vector3,
	b: THREE.Vector3,
	c: THREE.Vector3,
	outward: THREE.Vector3,
	color: THREE.Color,
) => {
	const normal = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a))
	const [second, third] = normal.dot(outward) >= 0 ? [b, c] : [c, b]
	mesh.positions.push(a.x, a.y, a.z, second.x, second.y, second.z, third.x, third.y, third.z)
	for (let index = 0; index < 3; index++) mesh.colors.push(color.r, color.g, color.b)
}

const finish = (mesh: Mesh): THREE.BufferGeometry => {
	const geometry = new THREE.BufferGeometry()
	geometry.setAttribute("position", new THREE.Float32BufferAttribute(mesh.positions, 3))
	geometry.setAttribute("color", new THREE.Float32BufferAttribute(mesh.colors, 3))
	geometry.computeVertexNormals()
	return geometry
}

export interface Level {
	readonly y: number
	/** The outline's scale at this height. */
	readonly scale: number
	/** Colour of the band that rises to this level (unused on the first). */
	readonly color: string
}

const UP = new THREE.Vector3(0, 1, 0)
const DOWN = new THREE.Vector3(0, -1, 0)

/** A closed outline swept up through `levels`: one band of wall between each pair, an optional
 * lid on the last level and floor under the first. `outline` is around the origin. */
export const loft = (
	outline: ReadonlyArray<Point>,
	levels: ReadonlyArray<Level>,
	caps: { readonly lid?: string; readonly floor?: string } = {},
): THREE.BufferGeometry => {
	const mesh: Mesh = { positions: [], colors: [] }
	const at = (level: Level, index: number): THREE.Vector3 => {
		const [x, z] = outline[index % outline.length] ?? [0, 0]
		return new THREE.Vector3(x * level.scale, level.y, z * level.scale)
	}
	Arr.forEach(Arr.zip(levels, Arr.drop(levels, 1)), ([lower, upper]) => {
		const color = new THREE.Color(upper.color)
		Arr.forEach(outline, ([x, z], index) => {
			const outward = new THREE.Vector3(x, 0, z).normalize()
			// A band that widens upward is an overhang and faces down; one that narrows faces up.
			outward.y = Math.sign(lower.scale - upper.scale) * 0.5
			const [a, b, c, d] = [
				at(lower, index),
				at(lower, index + 1),
				at(upper, index + 1),
				at(upper, index),
			]
			triangle(mesh, a, b, c, outward, color)
			triangle(mesh, a, c, d, outward, color)
		})
	})
	const cap = (level: Level | undefined, color: string | undefined, facing: THREE.Vector3) => {
		if (level === undefined || color === undefined) return
		const centre = new THREE.Vector3(0, level.y, 0)
		const tone = new THREE.Color(color)
		Arr.forEach(outline, (_, index) =>
			triangle(mesh, centre, at(level, index), at(level, index + 1), facing, tone),
		)
	}
	cap(levels[levels.length - 1], caps.lid, UP)
	cap(levels[0], caps.floor, DOWN)
	return finish(mesh)
}

/** A flat band between two scales of the outline, facing up: foam, a shoal, a selection ring. */
export const band = (
	outline: ReadonlyArray<Point>,
	y: number,
	inner: number,
	outer: number,
	color: string,
): THREE.BufferGeometry =>
	loft(outline, [
		{ y, scale: outer, color },
		{ y, scale: inner, color },
	])

/** A flat strip along `points`, `width` wide and facing up; `offset` shifts it sideways (a rail
 * beside the track's middle). */
export const ribbon = (
	points: ReadonlyArray<Point>,
	y: number,
	width: number,
	color: string,
	offset = 0,
): THREE.BufferGeometry => {
	const mesh: Mesh = { positions: [], colors: [] }
	const tone = new THREE.Color(color)
	const edges = Arr.map(points, ([x, z], index) => {
		const before = points[Math.max(0, index - 1)] ?? [x, z]
		const after = points[Math.min(points.length - 1, index + 1)] ?? [x, z]
		// Two points on one spot give no direction: any unit length keeps the strip finite.
		const length = Math.max(1e-6, Math.hypot(after[0] - before[0], after[1] - before[1]))
		const across: Point = [-(after[1] - before[1]) / length, (after[0] - before[0]) / length]
		const side = (distance: number) =>
			new THREE.Vector3(x + across[0] * distance, y, z + across[1] * distance)
		return { left: side(offset - width / 2), right: side(offset + width / 2) }
	})
	Arr.forEach(Arr.zip(edges, Arr.drop(edges, 1)), ([a, b]) => {
		triangle(mesh, a.left, a.right, b.right, UP, tone)
		triangle(mesh, a.left, b.right, b.left, UP, tone)
	})
	return finish(mesh)
}

/** A gable roof: `width` across the ridge, `depth` along it, sitting on y = 0. */
export const gable = (
	width: number,
	height: number,
	depth: number,
	color: THREE.Color,
): THREE.BufferGeometry => {
	const mesh: Mesh = { positions: [], colors: [] }
	const [w, d] = [width / 2, depth / 2]
	const corner = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
	const [a, b, c, e] = [corner(-w, 0, -d), corner(w, 0, -d), corner(w, 0, d), corner(-w, 0, d)]
	const [back, front] = [corner(0, height, -d), corner(0, height, d)]
	const left = new THREE.Vector3(-1, 1, 0)
	const right = new THREE.Vector3(1, 1, 0)
	triangle(mesh, a, e, front, left, color)
	triangle(mesh, a, front, back, left, color)
	triangle(mesh, b, c, front, right, color)
	triangle(mesh, b, front, back, right, color)
	triangle(mesh, e, c, front, new THREE.Vector3(0, 0, 1), color)
	triangle(mesh, a, b, back, new THREE.Vector3(0, 0, -1), color)
	return finish(mesh)
}

/** The ink for a fused geometry: one line per crease sharper than `angle` degrees. */
export const creases = (geometry: THREE.BufferGeometry, angle = 28): THREE.BufferGeometry =>
	new THREE.EdgesGeometry(geometry, angle)

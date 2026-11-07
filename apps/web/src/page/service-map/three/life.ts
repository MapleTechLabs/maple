import type { Creek } from "../../../components/service-map/three/maple-scenery-field"
import { hash } from "../../../components/service-map/three/maple-scenery-sketch"
import type { InkPalette } from "../../../components/service-map/three/palette"
import type { District } from "../../../components/service-map/three/spatial-layout"
import * as THREE from "three"
import { type LeafWorld, leafPose } from "./falling-leaves"
import type { Child, Running, Scope, Vec3 } from "./kit"
import { Array as Arr } from "effect"

/** Short pale strokes slide downstream on the creek; they wrap at its ends. */
export function ripples(
	scope: Scope,
	{
		creek,
		floor,
		palette,
		running,
	}: { creek: Creek; floor: number; palette: InkPalette; running: Running },
): THREE.LineSegments {
	const count = 30
	const elapsed = { value: 0 }
	const geometry = new THREE.BufferGeometry()
	geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 6), 3))
	const seeds = Array.from({ length: count }, (_, i) => ({
		phase: (i + hash(i, 3.3) * 0.6) / count,
		lane: (hash(4.7, i) - 0.5) * 1.1,
		speed: 0.22 + hash(i * 1.9, 2) * 0.12,
	}))
	scope.frames.push((delta) => {
		if (running()) elapsed.value += Math.min(delta, 0.05)
		const position = geometry.getAttribute("position")
		const { length } = creek
		Arr.forEach(seeds, (seed, i) => {
			const s = ((seed.phase + (elapsed.value * seed.speed) / length) % 1) * (length - 0.3)
			const set = (index: number, point: ReturnType<Creek["at"]>) =>
				position.setXYZ(
					index,
					point.x - point.nx * seed.lane * point.w,
					floor + 0.012,
					point.z - point.nz * seed.lane * point.w,
				)
			set(i * 2, creek.at(s))
			set(i * 2 + 1, creek.at(s + 0.24))
		})
		position.needsUpdate = true
	})
	const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: palette.birch }))
	lines.frustumCulled = false
	return lines
}

/** True when the paper is dark, so the woods are at night. */
export const isNight = (palette: InkPalette) =>
	new THREE.Color(palette.paper).getHSL({ h: 0, s: 0, l: 0 }).l < 0.3

/** Glow motes wander slow loops among the trees. Steady light: they never blink. */
export function fireflies(
	scope: Scope,
	{
		anchors,
		floor,
		palette,
		running,
	}: { anchors: ReadonlyArray<Vec3>; floor: number; palette: InkPalette; running: Running },
): Child {
	const count = anchors.length
	const elapsed = { value: 0 }
	const pose = new THREE.Object3D()
	const geometry = new THREE.OctahedronGeometry(0.045, 0)
	const glow = new THREE.OctahedronGeometry(0.14, 1)
	if (count === 0) return null
	// A steady core inside a faint fixed halo: easy to spot at night, never brighter or dimmer.
	const mesh = new THREE.InstancedMesh(
		geometry,
		new THREE.MeshBasicMaterial({ color: palette.glow }),
		count,
	)
	mesh.frustumCulled = false
	const halo = new THREE.InstancedMesh(
		glow,
		new THREE.MeshBasicMaterial({
			color: palette.glow,
			transparent: true,
			opacity: 0.14,
			depthWrite: false,
		}),
		count,
	)
	halo.frustumCulled = false
	halo.renderOrder = 1
	scope.frames.push((delta) => {
		if (running()) elapsed.value += Math.min(delta, 0.05)
		const t = elapsed.value
		Arr.forEach(anchors, ([x, , z], i) => {
			const phase = hash(x, z) * 6.28
			pose.position.set(
				x + Math.sin(t * 0.35 + phase) * 0.38,
				floor + 0.45 + Math.sin(t * 0.22 + phase * 2) * 0.2,
				z + Math.cos(t * 0.29 + phase) * 0.38,
			)
			pose.updateMatrix()
			mesh.setMatrixAt(i, pose.matrix)
			halo.setMatrixAt(i, pose.matrix)
		})
		mesh.instanceMatrix.needsUpdate = true
		halo.instanceMatrix.needsUpdate = true
	})
	return [mesh, halo]
}

type LeafCut = "birch" | "maple"

/** Half a leaf's outline, stem to tip, x >= 0; mirrored for the other half. Unit height. */
const HALF_OUTLINES = {
	// A flag-style maple leaf: a short stem, two side lobes and a tall centre lobe, notched between.
	maple: [
		[0.03, -0.5],
		[0.03, -0.3],
		[0.21, -0.35],
		[0.18, -0.26],
		[0.39, -0.09],
		[0.31, -0.06],
		[0.35, 0.09],
		[0.22, 0.05],
		[0.23, 0.16],
		[0.12, 0.1],
		[0.15, 0.31],
		[0.07, 0.26],
		[0, 0.5],
	],
	// A birch leaf: an oval narrowing to a pointed tip, on a short stem.
	birch: [
		[0.02, -0.5],
		[0.02, -0.36],
		[0.15, -0.32],
		[0.23, -0.17],
		[0.24, 0.0],
		[0.19, 0.18],
		[0.1, 0.34],
		[0, 0.5],
	],
} satisfies Record<LeafCut, ReadonlyArray<readonly [number, number]>>

/** Leaf sizes in scene units, before each leaf's own scale. */
const LEAF_SIZE = { maple: 0.22, birch: 0.19 } satisfies Record<LeafCut, number>

/** A flat leaf in its XY plane, centred on its middle, stem toward -y. */
function leafGeometry(cut: LeafCut) {
	const half = HALF_OUTLINES[cut]
	const outline = [...half, ...Arr.map(Arr.reverse(half.slice(0, -1)), ([x, y]) => [-x, y] as const)]
	const blade = new THREE.Shape()
	Arr.forEach(outline, ([x, y], i) => {
		const px = x * LEAF_SIZE[cut]
		const py = y * LEAF_SIZE[cut]
		if (i === 0) blade.moveTo(px, py)
		else blade.lineTo(px, py)
	})
	return new THREE.ShapeGeometry(blade)
}

/** `lift` brightens and warms the leaf colours: falling leaves catch the light above the litter. */
function leafMesh(count: number, palette: InkPalette, cut: LeafCut, offset: number, lift = 0) {
	const geometry = leafGeometry(cut)
	const paint = (mesh: THREE.InstancedMesh) => {
		const color = new THREE.Color()
		for (let i = 0; i < count; i++)
			mesh.setColorAt(
				i,
				color
					.set(palette.foliage[(i + offset) % Math.max(1, palette.foliage.length)] ?? palette.kraft)
					.offsetHSL(-0.01 * lift, 0.18 * lift, 0.1 * lift),
			)
		if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
	}
	return { geometry, paint }
}

/** Fallen leaves lying flat on every zone, split between the two cuts. */
function litterCut({
	matrices,
	palette,
	cut,
}: {
	matrices: ReadonlyArray<THREE.Matrix4>
	palette: InkPalette
	cut: LeafCut
}): Child {
	const { geometry, paint } = leafMesh(matrices.length, palette, cut, cut === "maple" ? 2 : 0)
	if (matrices.length === 0) return null
	const mesh = new THREE.InstancedMesh(
		geometry,
		new THREE.MeshBasicMaterial({
			side: THREE.DoubleSide,
			polygonOffset: true,
			polygonOffsetFactor: -1,
			polygonOffsetUnits: -1,
		}),
		matrices.length,
	)
	Arr.forEach(matrices, (matrix, i) => mesh.setMatrixAt(i, matrix))
	mesh.instanceMatrix.needsUpdate = true
	paint(mesh)
	mesh.computeBoundingSphere()
	return mesh
}

export function leafLitter(
	_scope: Scope,
	{ districts, palette }: { districts: ReadonlyArray<District>; palette: InkPalette },
): Child {
	const leaves = Arr.flatMap(districts, (district) =>
		Array.from({ length: Math.round((district.width * district.depth) / 3) }, (_, i) => {
			const u = hash(i + district.position[0], district.position[2] - i)
			const v = hash(district.position[2] + i * 1.7, i - district.position[0])
			// Each leaf sits a hair above the last few, so overlapping leaves never fight for depth.
			return new THREE.Matrix4().compose(
				new THREE.Vector3(
					district.position[0] + (u - 0.5) * (district.width - 0.3),
					district.position[1] + 0.162 + (i % 6) * 0.0015,
					district.position[2] + (v - 0.5) * (district.depth - 0.3),
				),
				new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, u * 6)),
				new THREE.Vector3(1, 1, 1),
			)
		}),
	)
	return [
		litterCut({ matrices: Arr.filter(leaves, (_, i) => i % 3 !== 0), palette, cut: "birch" }),
		litterCut({ matrices: Arr.filter(leaves, (_, i) => i % 3 === 0), palette, cut: "maple" }),
	]
}

/** One cut of falling leaves, posed every frame by `leafPose`; `first` is its first leaf index. */
function fallingCut(
	scope: Scope,
	{
		world,
		palette,
		running,
		cut,
		count,
		first,
	}: {
		world: LeafWorld
		palette: InkPalette
		running: Running
		cut: LeafCut
		count: number
		first: number
	},
): THREE.InstancedMesh {
	const { geometry, paint } = leafMesh(count, palette, cut, first, 1)
	const elapsed = { value: 0 }
	const pose = new THREE.Object3D()
	const mesh = new THREE.InstancedMesh(
		geometry,
		new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
		count,
	)
	mesh.frustumCulled = false
	paint(mesh)
	scope.frames.push((delta) => {
		if (running()) elapsed.value += Math.min(delta, 0.05)
		Arr.forEach(
			Arr.makeBy(count, (i) => i),
			(i) => {
				const leaf = leafPose(world, first + i, elapsed.value)
				pose.position.set(leaf.x, leaf.y, leaf.z)
				pose.rotation.set(leaf.rx, leaf.ry, leaf.rz)
				pose.scale.setScalar(Math.max(leaf.scale, 1e-4))
				pose.updateMatrix()
				mesh.setMatrixAt(i, pose.matrix)
			},
		)
		mesh.instanceMatrix.needsUpdate = true
	})
	return mesh
}

/** Leaves break off the deciduous crowns, flutter down on the breeze, rest and fade. */
export function fallingLeaves(
	scope: Scope,
	{ world, palette, running }: { world: LeafWorld; palette: InkPalette; running: Running },
): Child {
	if (world.sources.length === 0) return null
	return [
		fallingCut(scope, { world, palette, running, cut: "birch", count: 22, first: 0 }),
		fallingCut(scope, { world, palette, running, cut: "maple", count: 14, first: 22 }),
	]
}

import type { Creek } from "../../../components/service-map/three/maple-scenery-field"
import { type Bounds, hash } from "../../../components/service-map/three/maple-scenery-sketch"
import type { InkPalette } from "../../../components/service-map/three/palette"
import type { District } from "../../../components/service-map/three/spatial-layout"
import * as THREE from "three"
import type { Child, Running, Scope, Vec3 } from "./kit"

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
		seeds.forEach((seed, i) => {
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
		anchors.forEach(([x, , z], i) => {
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

/** Two leaf cuts: a plain diamond and a five-lobed maple star. */
function leafGeometry(cut: "diamond" | "maple") {
	if (cut === "diamond") return new THREE.PlaneGeometry(0.16, 0.16).rotateZ(Math.PI / 4)
	const star = new THREE.Shape()
	Array.from({ length: 10 }, (_, i) => {
		const angle = Math.PI / 2 + (i * Math.PI) / 5
		const radius = i % 2 === 0 ? 0.11 : 0.05
		return [Math.cos(angle) * radius, Math.sin(angle) * radius] as const
	}).forEach(([x, y], i) => (i === 0 ? star.moveTo(x, y) : star.lineTo(x, y)))
	return new THREE.ShapeGeometry(star)
}

/** Flat leaves, one draw per cut: litter on the ground, or falling ones. */
function leafMesh(count: number, palette: InkPalette, cut: "diamond" | "maple", offset: number) {
	const geometry = leafGeometry(cut)
	const paint = (mesh: THREE.InstancedMesh) => {
		const color = new THREE.Color()
		for (let i = 0; i < count; i++)
			mesh.setColorAt(
				i,
				color.set(
					palette.foliage[(i + offset) % Math.max(1, palette.foliage.length)] ?? palette.kraft,
				),
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
	cut: "diamond" | "maple"
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
	matrices.forEach((matrix, i) => mesh.setMatrixAt(i, matrix))
	mesh.instanceMatrix.needsUpdate = true
	paint(mesh)
	mesh.computeBoundingSphere()
	return mesh
}

export function leafLitter(
	_scope: Scope,
	{ districts, palette }: { districts: ReadonlyArray<District>; palette: InkPalette },
): Child {
	const leaves = districts.flatMap((district) =>
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
		litterCut({ matrices: leaves.filter((_, i) => i % 3 !== 0), palette, cut: "diamond" }),
		litterCut({ matrices: leaves.filter((_, i) => i % 3 === 0), palette, cut: "maple" }),
	]
}

/** Leaves drift down, swaying and tumbling, and start again from the canopy. */
function fallingCut(
	scope: Scope,
	{
		bounds,
		palette,
		running,
		cut,
		count,
		salt,
	}: {
		bounds: Bounds
		palette: InkPalette
		running: Running
		cut: "diamond" | "maple"
		count: number
		salt: number
	},
): THREE.InstancedMesh {
	const { geometry, paint } = leafMesh(count, palette, cut, salt)
	const elapsed = { value: 0 }
	const pose = new THREE.Object3D()
	const seeds = Array.from({ length: count }, (_, n) => {
		const i = n + salt * 100
		return {
			x: hash(i, 1.3),
			z: hash(2.1, i),
			phase: hash(i, i * 0.7),
			speed: 0.35 + hash(i * 3.1, 7) * 0.3,
		}
	})
	const mesh = new THREE.InstancedMesh(
		geometry,
		new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
		count,
	)
	mesh.frustumCulled = false
	paint(mesh)
	scope.frames.push((delta) => {
		if (running()) elapsed.value += Math.min(delta, 0.05)
		const height = 5.5
		const t = elapsed.value
		seeds.forEach((seed, i) => {
			const fall = (seed.phase * height + t * seed.speed) % height
			const sway = Math.sin(t * 1.3 + seed.phase * 9) * 0.45
			pose.position.set(
				bounds.minX + seed.x * (bounds.maxX - bounds.minX) + sway,
				bounds.floor + height - fall,
				bounds.minZ + seed.z * (bounds.maxZ - bounds.minZ) - sway * 0.4,
			)
			pose.rotation.set(t * 1.7 + seed.phase * 6, seed.phase * 4, t * 0.9)
			pose.updateMatrix()
			mesh.setMatrixAt(i, pose.matrix)
		})
		mesh.instanceMatrix.needsUpdate = true
	})
	return mesh
}

export function fallingLeaves(
	scope: Scope,
	{ bounds, palette, running }: { bounds: Bounds; palette: InkPalette; running: Running },
): Child {
	return [
		fallingCut(scope, { bounds, palette, running, cut: "diamond", count: 28, salt: 0 }),
		fallingCut(scope, { bounds, palette, running, cut: "maple", count: 20, salt: 1 }),
	]
}

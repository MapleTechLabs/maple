import { useMemo, useRef } from "react"
import { useFrame } from "@react-three/fiber"
import * as THREE from "three"
import { useMountEffect } from "@/hooks/use-mount-effect"
import type { InkPalette } from "./appearance"
import type { District } from "./spatial-layout"
import type { Creek } from "./maple-scenery-field"
import { type Bounds, hash } from "./maple-scenery-kit"
import type { Vec3 } from "./types"

/** Short pale strokes slide downstream on the creek; they wrap at its ends. */
export function Ripples({
	creek,
	floor,
	palette,
	running,
}: {
	creek: Creek
	floor: number
	palette: InkPalette
	running: boolean
}) {
	const count = 30
	const elapsed = useRef(0)
	const geometry = useMemo(() => {
		const lines = new THREE.BufferGeometry()
		lines.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 6), 3))
		return lines
	}, [])
	useMountEffect(() => () => geometry.dispose())
	const seeds = useMemo(
		() =>
			Array.from({ length: count }, (_, i) => ({
				phase: (i + hash(i, 3.3) * 0.6) / count,
				lane: (hash(4.7, i) - 0.5) * 1.1,
				speed: 0.22 + hash(i * 1.9, 2) * 0.12,
			})),
		[],
	)
	useFrame((_, delta) => {
		if (running) elapsed.current += Math.min(delta, 0.05)
		const position = geometry.getAttribute("position")
		const { length } = creek
		seeds.forEach((seed, i) => {
			const s = ((seed.phase + (elapsed.current * seed.speed) / length) % 1) * (length - 0.3)
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
	return (
		<lineSegments geometry={geometry} frustumCulled={false}>
			<lineBasicMaterial color={palette.birch} />
		</lineSegments>
	)
}

/** True when the paper is dark, so the woods are at night. */
export const isNight = (palette: InkPalette) =>
	new THREE.Color(palette.paper).getHSL({ h: 0, s: 0, l: 0 }).l < 0.3

/** Glow motes wander slow loops among the trees. Steady light: they never blink. */
export function Fireflies({
	anchors,
	floor,
	palette,
	running,
}: {
	anchors: ReadonlyArray<Vec3>
	floor: number
	palette: InkPalette
	running: boolean
}) {
	const count = anchors.length
	const mesh = useRef<THREE.InstancedMesh>(null)
	const halo = useRef<THREE.InstancedMesh>(null)
	const elapsed = useRef(0)
	const pose = useMemo(() => new THREE.Object3D(), [])
	const geometry = useMemo(() => new THREE.OctahedronGeometry(0.045, 0), [])
	const glow = useMemo(() => new THREE.OctahedronGeometry(0.14, 1), [])
	useMountEffect(() => () => {
		geometry.dispose()
		glow.dispose()
	})
	useFrame((_, delta) => {
		if (!mesh.current || !halo.current) return
		if (running) elapsed.current += Math.min(delta, 0.05)
		const t = elapsed.current
		anchors.forEach(([x, , z], i) => {
			const phase = hash(x, z) * 6.28
			pose.position.set(
				x + Math.sin(t * 0.35 + phase) * 0.38,
				floor + 0.45 + Math.sin(t * 0.22 + phase * 2) * 0.2,
				z + Math.cos(t * 0.29 + phase) * 0.38,
			)
			pose.updateMatrix()
			mesh.current?.setMatrixAt(i, pose.matrix)
			halo.current?.setMatrixAt(i, pose.matrix)
		})
		mesh.current.instanceMatrix.needsUpdate = true
		halo.current.instanceMatrix.needsUpdate = true
	})
	if (count === 0) return null
	// A steady core inside a faint fixed halo: easy to spot at night, never brighter or dimmer.
	return (
		<>
			<instancedMesh ref={mesh} args={[geometry, undefined, count]} frustumCulled={false}>
				<meshBasicMaterial color={palette.glow} />
			</instancedMesh>
			<instancedMesh ref={halo} args={[glow, undefined, count]} frustumCulled={false} renderOrder={1}>
				<meshBasicMaterial color={palette.glow} transparent opacity={0.14} depthWrite={false} />
			</instancedMesh>
		</>
	)
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
function useLeafMesh(count: number, palette: InkPalette, cut: "diamond" | "maple", offset: number) {
	const geometry = useMemo(() => leafGeometry(cut), [cut])
	useMountEffect(() => () => geometry.dispose())
	const paint = (mesh: THREE.InstancedMesh | null) => {
		if (!mesh) return
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
function LitterCut({
	matrices,
	palette,
	cut,
}: {
	matrices: THREE.Matrix4[]
	palette: InkPalette
	cut: "diamond" | "maple"
}) {
	const { geometry, paint } = useLeafMesh(matrices.length, palette, cut, cut === "maple" ? 2 : 0)
	if (matrices.length === 0) return null
	return (
		<instancedMesh
			args={[geometry, undefined, matrices.length]}
			ref={(mesh) => {
				if (!mesh) return
				matrices.forEach((matrix, i) => mesh.setMatrixAt(i, matrix))
				mesh.instanceMatrix.needsUpdate = true
				paint(mesh)
				mesh.computeBoundingSphere()
			}}
		>
			<meshBasicMaterial
				side={THREE.DoubleSide}
				polygonOffset
				polygonOffsetFactor={-1}
				polygonOffsetUnits={-1}
			/>
		</instancedMesh>
	)
}

export function LeafLitter({
	districts,
	palette,
}: {
	districts: ReadonlyArray<District>
	palette: InkPalette
}) {
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
	return (
		<>
			<LitterCut matrices={leaves.filter((_, i) => i % 3 !== 0)} palette={palette} cut="diamond" />
			<LitterCut matrices={leaves.filter((_, i) => i % 3 === 0)} palette={palette} cut="maple" />
		</>
	)
}

/** Leaves drift down, swaying and tumbling, and start again from the canopy. */
function FallingCut({
	bounds,
	palette,
	running,
	cut,
	count,
	salt,
}: {
	bounds: Bounds
	palette: InkPalette
	running: boolean
	cut: "diamond" | "maple"
	count: number
	salt: number
}) {
	const { geometry, paint } = useLeafMesh(count, palette, cut, salt)
	const mesh = useRef<THREE.InstancedMesh>(null)
	const elapsed = useRef(0)
	const pose = useMemo(() => new THREE.Object3D(), [])
	const seeds = useMemo(
		() =>
			Array.from({ length: count }, (_, n) => {
				const i = n + salt * 100
				return {
					x: hash(i, 1.3),
					z: hash(2.1, i),
					phase: hash(i, i * 0.7),
					speed: 0.35 + hash(i * 3.1, 7) * 0.3,
				}
			}),
		[count, salt],
	)
	useFrame((_, delta) => {
		if (!mesh.current) return
		if (running) elapsed.current += Math.min(delta, 0.05)
		const height = 5.5
		const t = elapsed.current
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
			mesh.current?.setMatrixAt(i, pose.matrix)
		})
		mesh.current.instanceMatrix.needsUpdate = true
	})
	return (
		<instancedMesh
			ref={(instance) => {
				mesh.current = instance
				paint(instance)
			}}
			args={[geometry, undefined, count]}
			frustumCulled={false}
		>
			<meshBasicMaterial side={THREE.DoubleSide} />
		</instancedMesh>
	)
}

export function FallingLeaves({
	bounds,
	palette,
	running,
}: {
	bounds: Bounds
	palette: InkPalette
	running: boolean
}) {
	return (
		<>
			<FallingCut
				bounds={bounds}
				palette={palette}
				running={running}
				cut="diamond"
				count={28}
				salt={0}
			/>
			<FallingCut bounds={bounds} palette={palette} running={running} cut="maple" count={20} salt={1} />
		</>
	)
}

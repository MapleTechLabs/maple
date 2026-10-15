import { useMemo, useRef, useState } from "react"
import { useFrame } from "@react-three/fiber"
import * as THREE from "three"
import { useMountEffect } from "@/hooks/use-mount-effect"
import type { InkPalette } from "./appearance"
import { InkSolid } from "./factory-primitives"
import { DEER_NECK, DEER_YAW, drawBird, drawDeerHead, drawDuck } from "./maple-scenery"
import type { Waterway } from "./maple-scenery-field"
import { type Bounds, hash, prototypes, type Sketch, SketchDrawing, sketchOf } from "./maple-scenery-kit"
import type { Vec3 } from "./types"

/** Seconds of motion so far; frozen while paused. */
function useClock(running: boolean) {
	const elapsed = useRef(0)
	useFrame((_, delta) => {
		if (running) elapsed.current += Math.min(delta, 0.05)
	})
	return elapsed
}

/** Mallards paddle a steady loop round the lake. */
export function Ducks({
	water,
	floor,
	palette,
	running,
}: {
	water: Waterway
	floor: number
	palette: InkPalette
	running: boolean
}) {
	const ducks = useRef<Array<THREE.Group | null>>([])
	const clock = useClock(running)
	const flock = useMemo(
		() => [0.12, 0.16, 0.6].map((phase, i) => ({ phase, lane: (hash(i, 8.1) - 0.5) * 0.7, speed: 0.13 })),
		[],
	)
	useFrame(() => {
		flock.forEach((duck, i) => {
			const group = ducks.current[i]
			if (!group) return
			const s = (duck.phase * water.length + clock.current * duck.speed) % water.length
			const point = water.at(s)
			// The tangent is the outward normal turned a quarter: (-nz, nx).
			group.position.set(
				point.x - point.nx * duck.lane * point.w,
				floor,
				point.z - point.nz * duck.lane * point.w,
			)
			group.rotation.y = Math.atan2(-point.nx, -point.nz)
		})
	})
	const draw = (sketch: Sketch) => {
		const stock = prototypes()
		drawDuck(sketch, stock, palette)
		stock.dispose()
	}
	return (
		<>
			{flock.map((_, i) => (
				<group
					key={i}
					ref={(group) => {
						ducks.current[i] = group
					}}
				>
					<SketchDrawing key={`${palette.paper}:${palette.ink}`} draw={draw} ink={palette.ink} />
				</group>
			))}
		</>
	)
}

/** Birds glide slow arcs high behind the map, where they can never cover a machine:
 * one along the far side, a pair down the left. One draw for every bird. */
export function Birds({
	bounds,
	palette,
	running,
}: {
	bounds: Bounds
	palette: InkPalette
	running: boolean
}) {
	const mesh = useRef<THREE.InstancedMesh>(null)
	const clock = useClock(running)
	const pose = useMemo(() => new THREE.Object3D(), [])
	// Built once; the caller keys Birds on the ink colour.
	const [geometry] = useState(() => {
		const { mesh: body, outline } = sketchOf((sketch, stock) => drawBird(sketch, stock, palette.ink))
		outline.dispose()
		return body
	})
	useMountEffect(() => () => geometry.dispose())
	const { minX, maxX, minZ, maxZ } = bounds
	const route = (lane: number, u: number): Vec3 =>
		lane === 0
			? [minX - 6 + u * (maxX - minX + 12), 4.4, minZ - 4 - Math.sin(u * Math.PI) * 1.6]
			: [minX - 4 - Math.sin(u * Math.PI) * 1.6, 4.1, maxZ + 6 - u * (maxZ - minZ + 12)]
	const flight = [
		{ lane: 0, phase: 0.1, side: 0, back: 0 },
		{ lane: 1, phase: 0.55, side: 0, back: 0 },
		{ lane: 1, phase: 0.55, side: 0.32, back: 0.28 },
	]
	useFrame(() => {
		if (!mesh.current) return
		flight.forEach((bird, i) => {
			const span = bird.lane === 0 ? maxX - minX + 12 : maxZ - minZ + 12
			const u = (bird.phase + (clock.current * 0.3) / span) % 1
			const [x, y, z] = route(bird.lane, u)
			const [ax, , az] = route(bird.lane, u + 0.01)
			const yaw = Math.atan2(-(az - z), ax - x)
			// Wingmates hold station behind and beside the leader, in the leader's frame.
			const [c, s] = [Math.cos(yaw), Math.sin(yaw)]
			const [lx, lz] = [-bird.back, bird.side]
			pose.position.set(x + lx * c + lz * s, y, z - lx * s + lz * c)
			pose.rotation.set(0, yaw, 0)
			pose.updateMatrix()
			mesh.current?.setMatrixAt(i, pose.matrix)
		})
		mesh.current.instanceMatrix.needsUpdate = true
	})
	return (
		<instancedMesh ref={mesh} args={[geometry, undefined, flight.length]} frustumCulled={false}>
			<meshBasicMaterial vertexColors />
		</instancedMesh>
	)
}

/** Woodsmoke from the campfire: puffs rise, swell and thin out, drifting away from the map. */
export function Campfire({
	at,
	palette,
	night,
	running,
}: {
	at: Vec3
	palette: InkPalette
	night: boolean
	running: boolean
}) {
	const puffs = useRef<Array<THREE.Group | null>>([])
	const clock = useClock(running)
	const puff = useMemo(() => new THREE.IcosahedronGeometry(0.11, 0), [])
	const disc = useMemo(() => new THREE.CircleGeometry(0.85, 24).rotateX(-Math.PI / 2), [])
	useMountEffect(() => () => disc.dispose())
	useFrame(() => {
		puffs.current.forEach((group, i) => {
			if (!group) return
			const t = (clock.current * 0.26 + i / 3) % 1
			group.position.set(-t * 0.3, 0.3 + t * 1.1, -t * 0.2)
			group.scale.setScalar(Math.max(0.001, Math.sin(Math.PI * t) * (0.7 + t * 0.6)))
		})
	})
	const [x, y, z] = at
	return (
		<group position={[x, y, z]}>
			{night ? (
				// A steady warm pool of firelight on the ground; it never flickers.
				<mesh geometry={disc} position={[0, 0.012, 0]} renderOrder={1}>
					<meshBasicMaterial color={palette.glow} transparent opacity={0.16} depthWrite={false} />
				</mesh>
			) : null}
			{[0, 1, 2].map((i) => (
				<group
					key={i}
					ref={(group) => {
						puffs.current[i] = group
					}}
				>
					<InkSolid geometry={puff} color={palette.cloud} ink={palette.ink} />
				</group>
			))}
		</group>
	)
}

/** The deer's head turns slowly from side to side while it grazes by the water. */
export function DeerHead({ at, palette, running }: { at: Vec3; palette: InkPalette; running: boolean }) {
	const neck = useRef<THREE.Group>(null)
	const clock = useClock(running)
	useFrame(() => {
		if (neck.current) neck.current.rotation.y = Math.sin(clock.current * 0.3) * 0.5
	})
	const draw = (sketch: Sketch) => {
		const stock = prototypes()
		drawDeerHead(sketch, stock, palette)
		stock.dispose()
	}
	return (
		<group position={[...at]} rotation={[0, DEER_YAW, 0]}>
			<group ref={neck} position={[...DEER_NECK]}>
				<SketchDrawing key={`${palette.paper}:${palette.ink}`} draw={draw} ink={palette.ink} />
			</group>
		</group>
	)
}

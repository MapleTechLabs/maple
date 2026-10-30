import type { InkPalette } from "../../../components/service-map/three/palette"
import {
	DEER_NECK,
	DEER_YAW,
	drawBird,
	drawDeerHead,
	drawDuck,
} from "../../../components/service-map/three/maple-scenery"
import type { Waterway } from "../../../components/service-map/three/maple-scenery-field"
import {
	type Bounds,
	hash,
	prototypes,
	type Sketch,
	sketchOf,
} from "../../../components/service-map/three/maple-scenery-sketch"
import * as THREE from "three"
import { group, inkSolid, mesh, type Running, type Scope, sketchDrawing, type Vec3 } from "./kit"

/** Seconds of motion so far; frozen while paused. */
export function clock(scope: Scope, running: Running): { value: number } {
	const elapsed = { value: 0 }
	scope.frames.push((delta) => {
		if (running()) elapsed.value += Math.min(delta, 0.05)
	})
	return elapsed
}

/** Seconds a clicked duck spends hopping. */
export const HOP = 0.45

/** Mallards paddle a steady loop round the lake. A click makes one hop and quack: each group
 * carries `userData.quack`, which the scene's click handler calls. */
export function ducks(
	scope: Scope,
	{
		water,
		floor,
		palette,
		running,
	}: { water: Waterway; floor: number; palette: InkPalette; running: Running },
): ReadonlyArray<THREE.Group> {
	const elapsed = clock(scope, running)
	const flock = [0.12, 0.16, 0.6].map((phase, i) => ({
		phase,
		lane: (hash(i, 8.1) - 0.5) * 0.7,
		speed: 0.13,
		hop: 0,
	}))
	const draw = (sketch: Sketch) => {
		const stock = prototypes()
		drawDuck(sketch, stock, palette)
		stock.dispose()
	}
	// The duck is tiny on screen, so a roomier invisible box takes its clicks.
	const target = () =>
		mesh(new THREE.BoxGeometry(0.4, 0.3, 0.3), new THREE.MeshBasicMaterial({ visible: false }), {
			position: [0, 0.1, 0],
		})
	const groups = flock.map((duck) => {
		const node = group({}, [group({}, [sketchDrawing(draw, palette.ink)]), target()])
		node.userData.quack = () => {
			duck.hop = HOP
		}
		return node
	})
	scope.frames.push((delta) => {
		flock.forEach((duck, i) => {
			const node = groups[i]
			const body = node?.children[0]
			if (!node || !body) return
			const s = (duck.phase * water.length + elapsed.value * duck.speed) % water.length
			const point = water.at(s)
			// The tangent is the outward normal turned a quarter: (-nz, nx).
			node.position.set(
				point.x - point.nx * duck.lane * point.w,
				floor,
				point.z - point.nz * duck.lane * point.w,
			)
			node.rotation.y = Math.atan2(-point.nx, -point.nz)
			// The hop runs on real time, so a paused map still answers the click.
			duck.hop = Math.max(0, duck.hop - Math.min(delta, 0.05))
			const t = 1 - duck.hop / HOP
			body.position.y = duck.hop > 0 ? Math.sin(Math.PI * t) * 0.12 : 0
			body.rotation.z = duck.hop > 0 ? Math.sin(Math.PI * 2 * t) * 0.25 : 0
		})
	})
	return groups
}

/** Birds glide slow arcs high behind the map, where they can never cover a machine:
 * one along the far side, a pair down the left. One draw for every bird. */
export function birds(
	scope: Scope,
	{ bounds, palette, running }: { bounds: Bounds; palette: InkPalette; running: Running },
): THREE.InstancedMesh {
	const elapsed = clock(scope, running)
	const pose = new THREE.Object3D()
	const { mesh: geometry, outline } = sketchOf((sketch, stock) => drawBird(sketch, stock, palette.ink))
	outline.dispose()
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
	const instanced = new THREE.InstancedMesh(
		geometry,
		new THREE.MeshBasicMaterial({ vertexColors: true }),
		flight.length,
	)
	instanced.frustumCulled = false
	scope.frames.push(() => {
		flight.forEach((bird, i) => {
			const span = bird.lane === 0 ? maxX - minX + 12 : maxZ - minZ + 12
			const u = (bird.phase + (elapsed.value * 0.3) / span) % 1
			const [x, y, z] = route(bird.lane, u)
			const [ax, , az] = route(bird.lane, u + 0.01)
			const yaw = Math.atan2(-(az - z), ax - x)
			// Wingmates hold station behind and beside the leader, in the leader's frame.
			const [c, s] = [Math.cos(yaw), Math.sin(yaw)]
			const [lx, lz] = [-bird.back, bird.side]
			pose.position.set(x + lx * c + lz * s, y, z - lx * s + lz * c)
			pose.rotation.set(0, yaw, 0)
			pose.updateMatrix()
			instanced.setMatrixAt(i, pose.matrix)
		})
		instanced.instanceMatrix.needsUpdate = true
	})
	return instanced
}

/** Woodsmoke from the campfire: puffs rise, swell and thin out, drifting away from the map. */
export function campfire(
	scope: Scope,
	{ at, palette, night, running }: { at: Vec3; palette: InkPalette; night: boolean; running: Running },
): THREE.Group {
	const elapsed = clock(scope, running)
	const puff = new THREE.IcosahedronGeometry(0.11, 0)
	const disc = new THREE.CircleGeometry(0.85, 24).rotateX(-Math.PI / 2)
	const glow = night
		? // A steady warm pool of firelight on the ground; it never flickers.
			mesh(
				disc,
				new THREE.MeshBasicMaterial({
					color: palette.glow,
					transparent: true,
					opacity: 0.16,
					depthWrite: false,
				}),
				{ position: [0, 0.012, 0] },
			)
		: null
	if (glow) glow.renderOrder = 1
	const puffs = [0, 1, 2].map(() =>
		group({}, [inkSolid({ geometry: puff, color: palette.cloud, ink: palette.ink })]),
	)
	scope.frames.push(() => {
		puffs.forEach((node, i) => {
			const t = (elapsed.value * 0.26 + i / 3) % 1
			node.position.set(-t * 0.3, 0.3 + t * 1.1, -t * 0.2)
			node.scale.setScalar(Math.max(0.001, Math.sin(Math.PI * t) * (0.7 + t * 0.6)))
		})
	})
	const [x, y, z] = at
	return group({ position: [x, y, z] }, [glow, puffs])
}

/** The deer's head turns slowly from side to side while it grazes by the water. */
export function deerHead(
	scope: Scope,
	{ at, palette, running }: { at: Vec3; palette: InkPalette; running: Running },
): THREE.Group {
	const elapsed = clock(scope, running)
	const draw = (sketch: Sketch) => {
		const stock = prototypes()
		drawDeerHead(sketch, stock, palette)
		stock.dispose()
	}
	const neck = group({ position: DEER_NECK }, [sketchDrawing(draw, palette.ink)])
	scope.frames.push(() => {
		neck.rotation.y = Math.sin(elapsed.value * 0.3) * 0.5
	})
	return group({ position: at, rotation: [0, DEER_YAW, 0] }, [neck])
}

import type { InkPalette } from "../../../components/service-map/three/palette"
import {
	DEER_NECK,
	DEER_YAW,
	drawBird,
	drawBlimp,
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
import { group, inkBox, inkSolid, mesh, type Running, type Scope, sketchDrawing, type Vec3 } from "./kit"

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

/** Seconds a startled duck takes to fly off, and later to glide back in. */
export const FLIGHT = 2.6

/** Clicks in quick succession that scare a duck off the lake. */
const STARTLE = 5

/** Seconds a duck stays away before it comes back. */
const AWAY = 25

/** What a click on a duck did: the scene keeps drawing for `seconds` and quacks `alarm` or not.
 * `null` when the duck is off the lake, so the click is a plain miss. */
export type DuckClick = { readonly seconds: number; readonly alarm: boolean } | null

interface Duck {
	readonly phase: number
	readonly lane: number
	readonly speed: number
	/** When the current hop lands, in seconds on `performance.now()`'s clock. */
	landsAt: number
	/** Quick clicks so far, and when the last one came. */
	strikes: number
	struckAt: number
	/** When the duck took off; `null` while it is on the water. */
	tookOffAt: number | null
}

/** Mallards paddle a steady loop round the lake. A click makes one hop and quack; a few quick
 * clicks and the duck flies off, gliding back in a while later. Each duck's hit box carries
 * `userData.quack`, which the scene's click handler calls. */
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
	const flock = [0.12, 0.16, 0.6].map((phase, i): Duck => ({
		phase,
		lane: (hash(i, 8.1) - 0.5) * 0.7,
		speed: 0.13,
		landsAt: 0,
		strikes: 0,
		struckAt: 0,
		tookOffAt: null,
	}))
	const now = () => performance.now() / 1000
	const draw = (sketch: Sketch) => {
		const stock = prototypes()
		drawDuck(sketch, stock, palette)
		stock.dispose()
	}
	const click = (duck: Duck): DuckClick => {
		const t = now()
		if (duck.tookOffAt !== null) return null
		duck.strikes = t - duck.struckAt < 1.5 ? duck.strikes + 1 : 1
		duck.struckAt = t
		if (duck.strikes < STARTLE) {
			duck.landsAt = t + HOP
			return { seconds: HOP, alarm: false }
		}
		duck.strikes = 0
		duck.landsAt = 0
		duck.tookOffAt = t
		return { seconds: FLIGHT, alarm: true }
	}
	// The duck is tiny on screen, so a roomier invisible box takes its clicks.
	const target = (duck: Duck) => {
		const box = mesh(
			new THREE.BoxGeometry(0.4, 0.3, 0.3),
			new THREE.MeshBasicMaterial({ visible: false }),
			{
				position: [0, 0.1, 0],
			},
		)
		box.userData.quack = (): DuckClick => click(duck)
		return box
	}
	// Wings hinge at the shoulders, folded out of sight until the duck takes off.
	const wing = (side: number) => {
		const hinge = group({ position: [-0.01, 0.09, side * 0.055] }, [
			inkBox({
				size: [0.11, 0.014, 0.17],
				position: [0, 0, side * 0.085],
				color: palette.soil,
				ink: palette.ink,
			}),
		])
		hinge.visible = false
		return hinge
	}
	const wings = flock.map(() => [wing(-1), wing(1)] as const)
	const groups = flock.map((duck, i) =>
		group({}, [group({}, [sketchDrawing(draw, palette.ink), wings[i]]), target(duck)]),
	)
	/** Poses the body for a flight `u` of the way out (0 on the water, 1 gone), forward along +x,
	 * its wings beating on real time `t`. */
	const fly = (
		body: THREE.Object3D,
		pair: readonly [THREE.Object3D, THREE.Object3D],
		u: number,
		sign: number,
		t: number,
	) => {
		const lift = u * u
		const beat = Math.sin(t * Math.PI * 2 * 5)
		body.position.set(sign * lift * 9, Math.pow(u, 1.4) * 5.5 + beat * 0.015, 0)
		body.rotation.set(0, 0, sign * Math.min(1, u * 5) * 0.35)
		body.scale.setScalar(Math.max(0.001, 1 - Math.max(0, (u - 0.7) / 0.3)))
		// A positive turn about x lifts the -z wing, a negative one the +z wing.
		const [left, right] = pair
		const stroke = 0.15 + beat * 0.85
		left.visible = true
		right.visible = true
		left.rotation.x = stroke
		right.rotation.x = -stroke
	}
	scope.frames.push(() => {
		const t = now()
		flock.forEach((duck, i) => {
			const node = groups[i]
			const body = node?.children[0]
			const pair = wings[i]
			if (!node || !body || !pair) return
			const s = (duck.phase * water.length + elapsed.value * duck.speed) % water.length
			const point = water.at(s)
			// The tangent is the outward normal turned a quarter: (-nz, nx).
			node.position.set(
				point.x - point.nx * duck.lane * point.w,
				floor,
				point.z - point.nz * duck.lane * point.w,
			)
			node.rotation.y = Math.atan2(-point.nx, -point.nz)
			// Hops and flights run on real time, so a paused map still answers the click.
			const gone = duck.tookOffAt === null ? null : t - duck.tookOffAt
			// Out on +x, away a while, then back in from behind along the mirrored path.
			const back = gone === null ? 0 : gone - FLIGHT - AWAY
			if (gone !== null && back < FLIGHT) {
				if (gone < FLIGHT) fly(body, pair, gone / FLIGHT, 1, t)
				else if (back < 0) fly(body, pair, 1, 1, t)
				else fly(body, pair, 1 - back / FLIGHT, -1, t)
				return
			}
			if (gone !== null) {
				duck.tookOffAt = null
				body.scale.setScalar(1)
				body.rotation.set(0, 0, 0)
				body.position.set(0, 0, 0)
				pair.forEach((hinge) => {
					hinge.visible = false
				})
			}
			const left = Math.max(0, duck.landsAt - t)
			const u = 1 - left / HOP
			body.position.y = left > 0 ? Math.sin(Math.PI * u) * 0.12 : 0
			body.rotation.z = left > 0 ? Math.sin(Math.PI * 2 * u) * 0.25 : 0
		})
	})
	return groups
}

/** Chance that a pass brings the blimp: most visits to the map never see it. */
const BLIMP_CHANCE = 0.3

/** Now and then a Maple blimp drifts across the sky over the far edge of the map. Each pass
 * rolls its own chance; between passes the sky stays empty for a while. */
export function blimp(
	scope: Scope,
	{ bounds, palette, running }: { bounds: Bounds; palette: InkPalette; running: Running },
): THREE.Group {
	const elapsed = clock(scope, running)
	const draw = (sketch: Sketch) => {
		const stock = prototypes()
		drawBlimp(sketch, stock, palette)
		stock.dispose()
	}
	const craft = group({ scale: 2.2 }, [sketchDrawing(draw, palette.ink)])
	craft.visible = false
	const { minX, maxX, minZ } = bounds
	const span = maxX - minX + 24
	const crossing = span / 0.4
	const cycle = crossing + 45
	// A fresh roll per mount, so a reload can bring it.
	const seed = Math.random() * 1000
	scope.frames.push(() => {
		const pass = Math.floor(elapsed.value / cycle)
		const u = (elapsed.value - pass * cycle) / crossing
		craft.visible = u < 1 && hash(pass, seed) < BLIMP_CHANCE
		if (!craft.visible) return
		craft.position.set(minX - 12 + u * span, 3.4 + Math.sin(elapsed.value * 0.5) * 0.12, minZ - 2.5)
		craft.rotation.set(0, 0, Math.sin(elapsed.value * 0.35) * 0.04)
	})
	return craft
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

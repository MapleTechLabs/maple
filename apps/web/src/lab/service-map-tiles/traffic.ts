import { Array as Arr, Option } from "effect"
import * as THREE from "three"
import type { TilePalette } from "./palette"
import { fuse, part, type Vec3 } from "./solid"

// The supply chains: every link carries its caller's produce to its callee, by cart on a road
// and by train on a railway. Each kind is two instanced meshes, the vehicle and its load: the
// load is painted with what the source tile's biome makes, the vehicle with the link's health.

export interface Route {
	readonly kind: "cart" | "train"
	readonly points: ReadonlyArray<Vec3>
	/** How many carts or trains are on the route at once. */
	readonly count: number
	/** World units per second. */
	readonly speed: number
	/** The vehicle's paint: the default on a healthy link, the health colour on a failing one. */
	readonly color: string
	/** The colour of what it carries. */
	readonly load: string
	/** A dimmed link's traffic stands still. */
	readonly running: boolean
}

export interface Traffic {
	readonly root: THREE.Group
	readonly frame: (delta: number) => void
	readonly dispose: () => void
}

interface Leg {
	readonly from: THREE.Vector3
	readonly to: THREE.Vector3
	readonly start: number
	readonly length: number
}

/** One instance and how far behind the vehicle's nose it rides (a wagon trails its engine). */
interface Body {
	readonly mesh: THREE.InstancedMesh
	readonly index: number
	readonly behind: number
}

interface Mover {
	readonly legs: ReadonlyArray<Leg>
	readonly length: number
	readonly speed: number
	readonly running: boolean
	readonly bodies: ReadonlyArray<Body>
	progress: number
}

const legsOf = (points: ReadonlyArray<Vec3>): ReadonlyArray<Leg> => {
	const state = { travelled: 0 }
	return Arr.map(Arr.zip(points, Arr.drop(points, 1)), ([a, b]) => {
		const from = new THREE.Vector3(...a)
		const to = new THREE.Vector3(...b)
		const leg = { from, to, start: state.travelled, length: from.distanceTo(to) }
		state.travelled += leg.length
		return leg
	})
}

// Bodies are white where the instance colour should show, and carry their own dark parts.

const cartGeometry = (palette: TilePalette): THREE.BufferGeometry =>
	fuse([
		part(new THREE.BoxGeometry(0.26, 0.04, 0.16), palette.dome, { position: [0, 0.07, 0] }),
		part(new THREE.BoxGeometry(0.05, 0.07, 0.19), palette.steel, { position: [0.07, 0.035, 0] }),
		part(new THREE.BoxGeometry(0.05, 0.07, 0.19), palette.steel, { position: [-0.07, 0.035, 0] }),
	])

const cartLoad = (): THREE.BufferGeometry => new THREE.BoxGeometry(0.17, 0.1, 0.12).translate(0, 0.14, 0)

/** A steam engine pointing along +x: boiler, cab and funnel on a dark frame. */
const engineGeometry = (palette: TilePalette): THREE.BufferGeometry =>
	fuse([
		part(new THREE.BoxGeometry(0.62, 0.07, 0.2), palette.steel, { position: [0, 0.035, 0] }),
		part(new THREE.CylinderGeometry(0.085, 0.085, 0.36, 8).rotateZ(Math.PI / 2), palette.dome, {
			position: [0.1, 0.16, 0],
		}),
		part(new THREE.BoxGeometry(0.2, 0.24, 0.2), palette.dome, { position: [-0.19, 0.19, 0] }),
		part(new THREE.BoxGeometry(0.24, 0.03, 0.24), palette.steel, { position: [-0.19, 0.325, 0] }),
		part(new THREE.CylinderGeometry(0.04, 0.03, 0.14, 6), palette.steel, { position: [0.21, 0.3, 0] }),
	])

/** An open wagon heaped with its load. */
const wagonGeometry = (palette: TilePalette): THREE.BufferGeometry =>
	fuse([
		part(new THREE.BoxGeometry(0.5, 0.07, 0.2), palette.steel, { position: [0, 0.035, 0] }),
		part(new THREE.BoxGeometry(0.44, 0.16, 0.18), palette.dome, { position: [0, 0.15, 0] }),
	])

/** How far behind its engine a wagon rides. */
const COUPLING = 0.66

export const makeTraffic = (routes: ReadonlyArray<Route>, palette: TilePalette): Traffic => {
	const root = new THREE.Group()
	const count = (kind: Route["kind"]) =>
		Arr.reduce(routes, 0, (sum, route) => sum + (route.kind === kind ? route.count : 0))
	const fleet = (geometry: THREE.BufferGeometry, vertexColors: boolean, size: number) => {
		const mesh = new THREE.InstancedMesh(
			geometry,
			new THREE.MeshLambertMaterial({ vertexColors, flatShading: true }),
			Math.max(1, size),
		)
		mesh.count = size
		mesh.castShadow = true
		// Instances move every frame, so the bounds of the first pose would cull them.
		mesh.frustumCulled = false
		root.add(mesh)
		return mesh
	}
	const meshes = {
		cart: fleet(cartGeometry(palette), true, count("cart")),
		cartLoad: fleet(cartLoad(), false, count("cart")),
		engine: fleet(engineGeometry(palette), true, count("train")),
		wagon: fleet(wagonGeometry(palette), true, count("train")),
	}
	const next = { cart: 0, train: 0 }
	const movers = Arr.flatMap(routes, (route): Array<Mover> => {
		const legs = legsOf(route.points)
		const length = Arr.reduce(legs, 0, (sum, leg) => sum + leg.length)
		if (length === 0) return []
		const [vehicle, load] =
			route.kind === "cart" ? [meshes.cart, meshes.cartLoad] : [meshes.engine, meshes.wagon]
		return Arr.makeBy(route.count, (index) => {
			const slot = next[route.kind]++
			vehicle.setColorAt(slot, new THREE.Color(route.color))
			load.setColorAt(slot, new THREE.Color(route.load))
			return {
				legs,
				length,
				speed: route.speed,
				running: route.running,
				bodies: [
					{ mesh: vehicle, index: slot, behind: 0 },
					{ mesh: load, index: slot, behind: route.kind === "cart" ? 0 : COUPLING },
				],
				// Spread along the route, then nudged so two routes never march in step.
				progress: (index + ((slot * 0.37) % 1)) / route.count,
			}
		})
	})
	const pose = new THREE.Object3D()
	const settle = (mover: Mover) => {
		const nose = (mover.progress % 1) * mover.length
		Arr.forEach(mover.bodies, (body) => {
			const travelled = nose - body.behind
			const leg = Option.orElse(
				Arr.findLast(mover.legs, (candidate) => candidate.start <= Math.max(0, travelled)),
				() => Arr.head(mover.legs),
			)
			if (Option.isNone(leg)) return
			const { from, to, start, length } = leg.value
			pose.position.lerpVectors(from, to, length === 0 ? 0 : (Math.max(0, travelled) - start) / length)
			pose.rotation.set(0, -Math.atan2(to.z - from.z, to.x - from.x), 0)
			// A wagon still inside the station is not out on the line yet.
			pose.scale.setScalar(travelled < 0 ? 0.001 : 1)
			pose.updateMatrix()
			body.mesh.setMatrixAt(body.index, pose.matrix)
		})
	}
	const fleets = [meshes.cart, meshes.cartLoad, meshes.engine, meshes.wagon]
	const place = () => {
		Arr.forEach(movers, settle)
		Arr.forEach(fleets, (mesh) => {
			mesh.instanceMatrix.needsUpdate = true
		})
	}
	place()
	return {
		root,
		frame: (delta) => {
			Arr.forEach(movers, (mover) => {
				if (mover.running)
					mover.progress = (mover.progress + (delta * mover.speed) / mover.length) % 1
			})
			place()
		},
		dispose: () => {
			Arr.forEach(fleets, (mesh) => {
				mesh.geometry.dispose()
				mesh.dispose()
				Arr.forEach([mesh.material].flat(), (material) => material.dispose())
			})
		},
	}
}

import { Array as Arr, Option, Order } from "effect"
import * as THREE from "three"
import type { TilePalette } from "./palette"
import { fuse, part, type Vec3 } from "./solid"

// The supply chains: every link carries its caller's produce to its callee, by cart on a road
// and by train on a railway. Each kind is two instanced meshes, the vehicle and its load: the
// load is painted with what the source tile's biome makes, the vehicle with the link's health.
// A vehicle can be poked: it dashes ahead for a moment, and an engine lets off steam.

export interface Route {
	/** The link the route carries, so a poked vehicle can say what it is hauling. */
	readonly linkId: string
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

/** A vehicle under the pointer: which one, and the link it runs on. */
export interface Vehicle {
	readonly index: number
	readonly linkId: string
	readonly kind: Route["kind"]
}

export interface Traffic {
	readonly root: THREE.Group
	/** The vehicle nearest the eye among those the ray passes close to. */
	readonly under: (ray: THREE.Ray) => Vehicle | null
	/** Sends vehicle `index` dashing ahead for a moment; an engine also lets off steam. */
	readonly poke: (index: number) => void
	/** `moving` runs the ordinary traffic; a poked vehicle dashes even on a paused map. `true`
	 * while one is still dashing. */
	readonly frame: (delta: number, moving: boolean) => boolean
	readonly dispose: () => void
}

/** Seconds a poked vehicle dashes, and how much faster it goes. */
export const DASH = 1.6
const DASH_PACE = 3.5
/** How close to a vehicle the pointer's ray must pass to pick it. */
const REACH = 0.34
/** Puffs of steam over each engine. */
const PUFFS = 3

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
	readonly linkId: string
	readonly kind: Route["kind"]
	readonly legs: ReadonlyArray<Leg>
	readonly length: number
	readonly speed: number
	readonly running: boolean
	readonly bodies: ReadonlyArray<Body>
	/** The engine's first puff in the steam mesh; -1 for a cart. */
	readonly steam: number
	progress: number
	/** When it was last poked, in seconds; `-Infinity` if never. */
	pokedAt: number
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
	const steam = new THREE.InstancedMesh(
		new THREE.IcosahedronGeometry(0.07, 0),
		new THREE.MeshLambertMaterial({
			color: palette.dome,
			flatShading: true,
			transparent: true,
			opacity: 0.9,
		}),
		Math.max(1, count("train") * PUFFS),
	)
	steam.count = count("train") * PUFFS
	steam.frustumCulled = false
	root.add(steam)
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
				linkId: route.linkId,
				kind: route.kind,
				legs,
				length,
				speed: route.speed,
				running: route.running,
				steam: route.kind === "train" ? slot * PUFFS : -1,
				pokedAt: -Infinity,
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
	const now = () => performance.now() / 1000
	const clock = { puffed: 0 }
	/** Poses `pose` on the route `travelled` units along it; `false` when the mover has no legs. */
	const stand = (mover: Mover, travelled: number): boolean => {
		const along = Math.max(0, travelled)
		const leg = Option.orElse(
			Arr.findLast(mover.legs, (candidate) => candidate.start <= along),
			() => Arr.head(mover.legs),
		)
		if (Option.isNone(leg)) return false
		const { from, to, start, length } = leg.value
		pose.position.lerpVectors(from, to, length === 0 ? 0 : (along - start) / length)
		pose.rotation.set(0, -Math.atan2(to.z - from.z, to.x - from.x), 0)
		return true
	}
	const settle = (mover: Mover, t: number) => {
		const nose = (mover.progress % 1) * mover.length
		Arr.forEach(mover.bodies, (body) => {
			// A wagon wraps on its own: it finishes the lap its engine has just ended, so the load
			// is seen reaching the callee.
			const travelled = (((nose - body.behind) % mover.length) + mover.length) % mover.length
			if (!stand(mover, travelled)) return
			pose.scale.setScalar(1)
			pose.updateMatrix()
			body.mesh.setMatrixAt(body.index, pose.matrix)
		})
		if (mover.steam < 0 || !stand(mover, nose)) return
		// Puffs leave the funnel, rise and fall behind; a poked engine blows them big.
		const heading = -pose.rotation.y
		const funnel = pose.position
			.clone()
			.add(new THREE.Vector3(Math.cos(heading) * 0.21, 0.38, Math.sin(heading) * 0.21))
		const blast = t - mover.pokedAt < DASH ? 2.4 : 1
		Arr.forEach(Arr.range(0, PUFFS - 1), (puff) => {
			const u = (clock.puffed * 0.8 + puff / PUFFS + mover.steam * 0.13) % 1
			pose.position.set(
				funnel.x - Math.cos(heading) * u * 0.4,
				funnel.y + u * 0.55 * blast,
				funnel.z - Math.sin(heading) * u * 0.4,
			)
			pose.rotation.set(0, 0, 0)
			pose.scale.setScalar(Math.max(0.001, Math.sin(Math.PI * u) * (0.5 + u * 0.7) * blast))
			pose.updateMatrix()
			steam.setMatrixAt(mover.steam + puff, pose.matrix)
		})
		pose.scale.setScalar(1)
	}
	const fleets = [meshes.cart, meshes.cartLoad, meshes.engine, meshes.wagon]
	const place = () => {
		const t = now()
		Arr.forEach(movers, (mover) => settle(mover, t))
		Arr.forEach([...fleets, steam], (mesh) => {
			mesh.instanceMatrix.needsUpdate = true
		})
	}
	place()
	return {
		root,
		under: (ray) => {
			const near = Arr.flatMap(movers, (mover, index) => {
				if (!stand(mover, (mover.progress % 1) * mover.length)) return []
				const at = pose.position.clone().setY(pose.position.y + 0.12)
				return ray.distanceToPoint(at) < REACH
					? [{ index, far: ray.origin.distanceTo(at), mover }]
					: []
			})
			const first = Arr.head(
				Arr.sort(
					near,
					Order.mapInput(Order.Number, (hit: { readonly far: number }) => hit.far),
				),
			)
			return Option.getOrNull(
				Option.map(first, ({ index, mover }) => ({ index, linkId: mover.linkId, kind: mover.kind })),
			)
		},
		poke: (index) => {
			const mover = movers[index]
			if (mover !== undefined) mover.pokedAt = now()
		},
		frame: (delta, moving) => {
			const t = now()
			const step = Math.min(delta, 0.05)
			const dashing = Arr.map(movers, (mover) => {
				const dash = t - mover.pokedAt < DASH
				const pace = dash ? DASH_PACE : moving && mover.running ? 1 : 0
				mover.progress = (mover.progress + (step * mover.speed * pace) / mover.length) % 1
				return dash
			})
			const busy = Arr.some(dashing, Boolean)
			if (moving || busy) clock.puffed += step
			place()
			return busy
		},
		dispose: () => {
			Arr.forEach([...fleets, steam], (mesh) => {
				mesh.geometry.dispose()
				mesh.dispose()
				Arr.forEach([mesh.material].flat(), (material) => material.dispose())
			})
		},
	}
}

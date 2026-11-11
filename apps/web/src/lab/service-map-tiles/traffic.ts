import { Array as Arr, Option, Order, Record as Rec } from "effect"
import * as THREE from "three"
import type { TilePalette } from "./palette"
import type { Block } from "./rails"
import {
	COUPLING,
	isLoaded,
	type Line,
	makeSignalBox,
	makeTrain,
	type Signal,
	signalsOf,
	type Train,
} from "./signalling"
import { fuse, part, type Vec3 } from "./solid"

// The supply chains: every link carries its caller's produce to its callee and comes back empty.
// A cart drives out on the right of its road, turns in the far square and drives back on the
// other side. A train runs to the far station, stops, and backs home, waiting at signals for
// track another train is on (`signalling.ts`). Nothing vanishes: the load is all that comes and
// goes. The load is painted with what the caller's biome makes, the vehicle with the link's
// health. A vehicle can be poked: it dashes on for a moment, and an engine lets off steam.

export interface Route {
	/** The link the route carries, so a poked vehicle can say what it is hauling. */
	readonly linkId: string
	readonly kind: "cart" | "train"
	/** A road's middle from square to square, or a railway from station to station. */
	readonly points: ReadonlyArray<Vec3>
	/** Carts on the road at once, or wagons behind the engine. */
	readonly count: number
	/** World units per second. */
	readonly speed: number
	/** The vehicle's paint: the default on a healthy link, the health colour on a failing one. */
	readonly color: string
	/** The colour of what it carries. */
	readonly load: string
	/** A dimmed link's carts stand still, and its train finishes its trip and stays at home. */
	readonly running: boolean
	/** A railway's stretches of track that other lines use too. */
	readonly blocks?: ReadonlyArray<Block>
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
	/** Which links' traffic runs, without starting anything over. */
	readonly setRunning: (isRunning: (linkId: string) => boolean) => void
	readonly dispose: () => void
}

/** Seconds a poked vehicle dashes, and how much faster it goes. */
export const DASH = 1.6
const DASH_PACE = 3.5
/** How close to a vehicle the pointer's ray must pass to pick it. */
const REACH = 0.34
/** Puffs of steam over each engine. */
const PUFFS = 3
/** How far to the right of its road's middle a cart keeps. */
const LANE = 0.085
/** How far from the middle of the track a signal's post stands. */
const SIGNAL_ASIDE = 0.32

interface Leg {
	readonly from: THREE.Vector3
	readonly to: THREE.Vector3
	readonly start: number
	readonly length: number
}

const legsOf = (points: ReadonlyArray<THREE.Vector3>): ReadonlyArray<Leg> => {
	const state = { travelled: 0 }
	return Arr.map(Arr.zip(points, Arr.drop(points, 1)), ([from, to]) => {
		const leg = { from, to, start: state.travelled, length: from.distanceTo(to) }
		state.travelled += leg.length
		return leg
	})
}

const lengthOf = (legs: ReadonlyArray<Leg>): number => Arr.reduce(legs, 0, (sum, leg) => sum + leg.length)

/** A cart's round: out along the right of the road from `from` to `to`, about in the far square,
 * back along the other side and about again. Closed, so a cart that finishes it starts over. */
const cartRound = (
	from: THREE.Vector3,
	to: THREE.Vector3,
): { readonly round: ReadonlyArray<THREE.Vector3>; readonly loaded: number } => {
	const ahead = to.clone().sub(from).setY(0).normalize()
	const right = new THREE.Vector3(-ahead.z, 0, ahead.x)
	const about = (centre: THREE.Vector3, sign: number) =>
		Arr.map([-60, -30, 0, 30, 60], (degrees) => {
			const angle = (degrees * Math.PI) / 180
			return centre
				.clone()
				.addScaledVector(ahead, sign * LANE * Math.cos(angle))
				.addScaledVector(right, -sign * LANE * Math.sin(angle))
		})
	const out = [from.clone().addScaledVector(right, LANE), to.clone().addScaledVector(right, LANE)]
	const back = [to.clone().addScaledVector(right, -LANE), from.clone().addScaledVector(right, -LANE)]
	const round = [...out, ...about(to, 1), ...back, ...about(from, -1), out[0] ?? from]
	// The load comes off halfway round the far square.
	return { round, loaded: from.distanceTo(to) + (LANE * Math.PI) / 2 }
}

/** One instance: which mesh and slot, how far behind the vehicle's nose it rides, and whether
 * it is the load (hidden on the way home). */
interface Body {
	readonly mesh: THREE.InstancedMesh
	readonly index: number
	readonly behind: number
	readonly isLoad: boolean
}

interface Mover {
	readonly linkId: string
	readonly kind: Route["kind"]
	readonly legs: ReadonlyArray<Leg>
	/** Where the vehicle's nose is along its legs, and whether it is carrying. */
	readonly whereabouts: () => { readonly along: number; readonly loaded: boolean }
	readonly bodies: ReadonlyArray<Body>
	/** The engine's first puff in the steam mesh; -1 for a cart. */
	readonly steam: number
	running: boolean
	/** When it was last poked, in seconds; `-Infinity` if never. */
	pokedAt: number
}

/** A cart goes round its road at a steady pace. */
interface Cart extends Mover {
	readonly trip: number
	readonly speed: number
	progress: number
}

/** A train is driven by the signal box. */
interface Engine extends Mover {
	readonly train: Train
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

/** An open wagon: a frame and low plank sides. */
const wagonGeometry = (palette: TilePalette): THREE.BufferGeometry =>
	fuse([
		part(new THREE.BoxGeometry(0.5, 0.07, 0.2), palette.steel, { position: [0, 0.035, 0] }),
		part(new THREE.BoxGeometry(0.46, 0.07, 0.02), palette.plank, { position: [0, 0.105, 0.09] }),
		part(new THREE.BoxGeometry(0.46, 0.07, 0.02), palette.plank, { position: [0, 0.105, -0.09] }),
	])

const wagonLoad = (): THREE.BufferGeometry => new THREE.BoxGeometry(0.42, 0.13, 0.15).translate(0, 0.14, 0)

export const makeTraffic = (routes: ReadonlyArray<Route>, palette: TilePalette): Traffic => {
	const root = new THREE.Group()
	const total = (kind: Route["kind"], per: (route: Route) => number) =>
		Arr.reduce(routes, 0, (sum, route) => sum + (route.kind === kind ? per(route) : 0))
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
	const carts = total("cart", (route) => route.count)
	const trains = total("train", () => 1)
	const wagons = total("train", (route) => route.count)
	const meshes = {
		cart: fleet(cartGeometry(palette), true, carts),
		cartLoad: fleet(cartLoad(), false, carts),
		engine: fleet(engineGeometry(palette), true, trains),
		wagon: fleet(wagonGeometry(palette), true, wagons),
		wagonLoad: fleet(wagonLoad(), false, wagons),
	}
	const steam = new THREE.InstancedMesh(
		new THREE.IcosahedronGeometry(0.07, 0),
		new THREE.MeshLambertMaterial({
			color: palette.dome,
			flatShading: true,
			transparent: true,
			opacity: 0.9,
		}),
		Math.max(1, trains * PUFFS),
	)
	steam.count = trains * PUFFS
	steam.frustumCulled = false
	root.add(steam)
	const next = { cart: 0, engine: 0, wagon: 0 }
	const white = new THREE.Color("white")
	const cartsOn = (route: Route): Array<Cart> => {
		const [first, last] = [route.points[0], route.points[route.points.length - 1]]
		if (first === undefined || last === undefined) return []
		const { round, loaded } = cartRound(new THREE.Vector3(...first), new THREE.Vector3(...last))
		const legs = legsOf(round)
		const trip = lengthOf(legs)
		if (trip === 0) return []
		return Arr.makeBy(route.count, (index) => {
			const slot = next.cart++
			meshes.cart.setColorAt(slot, new THREE.Color(route.color))
			meshes.cartLoad.setColorAt(slot, new THREE.Color(route.load))
			const cart: Cart = {
				linkId: route.linkId,
				kind: route.kind,
				legs,
				trip,
				whereabouts: () => ({
					along: (cart.progress % 1) * trip,
					loaded: (cart.progress % 1) * trip < loaded,
				}),
				speed: route.speed,
				running: route.running,
				steam: -1,
				pokedAt: -Infinity,
				bodies: [
					{ mesh: meshes.cart, index: slot, behind: 0, isLoad: false },
					{ mesh: meshes.cartLoad, index: slot, behind: 0, isLoad: true },
				],
				// Spread round the road, then nudged so two roads never march in step.
				progress: (index + ((slot * 0.37) % 1)) / route.count,
			}
			return cart
		})
	}
	const engineOn = (route: Route): Array<Engine> => {
		const legs = legsOf(Arr.map(route.points, (point) => new THREE.Vector3(...point)))
		const line: Line = {
			length: lengthOf(legs),
			wagons: route.count,
			speed: route.speed,
			blocks: route.blocks ?? [],
		}
		// Trains leave their stations one after another, not all on the first tick.
		const train = makeTrain(line, (next.engine * 1.3) % 4)
		if (train === null) return []
		const slot = next.engine++
		meshes.engine.setColorAt(slot, new THREE.Color(route.color))
		// The train may be shorter than asked: it sheds wagons to stand clear at its stations.
		const drawn = Arr.flatMap(
			Arr.makeBy(train.line.wagons, (index) => index + 1),
			(wagon): Array<Body> => {
				const at = next.wagon++
				meshes.wagon.setColorAt(at, white)
				meshes.wagonLoad.setColorAt(at, new THREE.Color(route.load))
				return [
					{ mesh: meshes.wagon, index: at, behind: wagon * COUPLING, isLoad: false },
					{ mesh: meshes.wagonLoad, index: at, behind: wagon * COUPLING, isLoad: true },
				]
			},
		)
		return [
			{
				linkId: route.linkId,
				kind: route.kind,
				legs,
				train,
				whereabouts: () => ({ along: train.along, loaded: isLoaded(train) }),
				running: route.running,
				steam: slot * PUFFS,
				pokedAt: -Infinity,
				bodies: [{ mesh: meshes.engine, index: slot, behind: 0, isLoad: false }, ...drawn],
			},
		]
	}
	const roadGoing = Arr.flatMap(
		Arr.filter(routes, (route) => route.kind === "cart"),
		cartsOn,
	)
	const engines = Arr.flatMap(
		Arr.filter(routes, (route) => route.kind === "train"),
		engineOn,
	)
	const movers: ReadonlyArray<Mover> = [...roadGoing, ...engines]
	// Only what was built is drawn: a road too short for carts, or a line with no train, would
	// otherwise leave a spare body standing at the middle of the board.
	meshes.cart.count = next.cart
	meshes.cartLoad.count = next.cart
	meshes.engine.count = next.engine
	meshes.wagon.count = next.wagon
	meshes.wagonLoad.count = next.wagon
	steam.count = next.engine * PUFFS
	const box = makeSignalBox(Arr.map(engines, (engine) => engine.train))
	const pose = new THREE.Object3D()
	const now = () => performance.now() / 1000
	const clock = { puffed: 0 }
	/** Poses `pose` on the mover's line `along` units from its start; `false` when it has no legs. */
	const stand = (mover: Pick<Mover, "legs">, along: number): boolean => {
		const leg = Option.orElse(
			Arr.findLast(mover.legs, (candidate) => candidate.start <= along),
			() => Arr.head(mover.legs),
		)
		if (Option.isNone(leg)) return false
		const { from, to, start, length } = leg.value
		pose.position.lerpVectors(from, to, length === 0 ? 0 : Math.max(0, along - start) / length)
		pose.rotation.set(0, -Math.atan2(to.z - from.z, to.x - from.x), 0)
		return true
	}
	const settle = (mover: Mover, t: number) => {
		const { along, loaded } = mover.whereabouts()
		Arr.forEach(mover.bodies, (body) => {
			if (!stand(mover, along - body.behind)) return
			pose.scale.setScalar(body.isLoad && !loaded ? 0.001 : 1)
			pose.updateMatrix()
			body.mesh.setMatrixAt(body.index, pose.matrix)
		})
		if (mover.steam < 0 || !stand(mover, along)) return
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
	// One post per signal, and a lamp on it that goes red while the track it guards is taken.
	const signals = Arr.flatMap(engines, (engine) =>
		Arr.map(signalsOf(engine.train.line), (signal): Signal & { readonly at: THREE.Vector3 } => {
			stand(engine, signal.along)
			const heading = -pose.rotation.y
			// To the right of a train coming up to it.
			const aside = SIGNAL_ASIDE * signal.side
			return {
				...signal,
				at: pose.position
					.clone()
					.add(new THREE.Vector3(-Math.sin(heading) * aside, 0, Math.cos(heading) * aside)),
			}
		}),
	)
	const posts = new THREE.InstancedMesh(
		fuse([
			part(new THREE.BoxGeometry(0.03, 0.42, 0.03), palette.steel, { position: [0, 0.16, 0] }),
			part(new THREE.BoxGeometry(0.1, 0.16, 0.05), palette.steel, { position: [0, 0.4, 0] }),
		]),
		new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
		Math.max(1, signals.length),
	)
	// The lamp is unlit, so it glows the same by day and by night.
	const lamps = new THREE.InstancedMesh(
		new THREE.SphereGeometry(0.045, 8, 6),
		new THREE.MeshBasicMaterial(),
		Math.max(1, signals.length),
	)
	posts.count = signals.length
	lamps.count = signals.length
	posts.castShadow = true
	Arr.forEach(signals, (signal, index) => {
		pose.position.copy(signal.at)
		pose.rotation.set(0, 0, 0)
		pose.scale.setScalar(1)
		pose.updateMatrix()
		posts.setMatrixAt(index, pose.matrix)
		pose.position.setY(signal.at.y + 0.4)
		pose.updateMatrix()
		lamps.setMatrixAt(index, pose.matrix)
	})
	Arr.forEach([posts, lamps], (mesh) => {
		mesh.frustumCulled = false
		root.add(mesh)
	})
	const aspects = { proceed: new THREE.Color(palette.proceed), halt: new THREE.Color(palette.halt) }
	const light = () => {
		Arr.forEach(signals, (signal, index) =>
			lamps.setColorAt(
				index,
				Arr.some(signal.guards, (section) => box.isOccupied(section))
					? aspects.halt
					: aspects.proceed,
			),
		)
		if (lamps.instanceColor !== null) lamps.instanceColor.needsUpdate = true
	}
	const fleets = [...Rec.values(meshes), steam, posts, lamps]
	const place = () => {
		const t = now()
		light()
		Arr.forEach(movers, (mover) => settle(mover, t))
		Arr.forEach(fleets, (mesh) => {
			mesh.instanceMatrix.needsUpdate = true
		})
	}
	place()
	return {
		root,
		under: (ray) => {
			const near = Arr.flatMap(movers, (mover, index) => {
				const { along } = mover.whereabouts()
				// An engine or any of its wagons will do.
				return Arr.flatMap(Arr.dedupe(Arr.map(mover.bodies, (body) => body.behind)), (behind) => {
					if (!stand(mover, along - behind)) return []
					const at = pose.position.clone().setY(pose.position.y + 0.12)
					return ray.distanceToPoint(at) < REACH
						? [{ index, far: ray.origin.distanceTo(at), mover }]
						: []
				})
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
			const isDashing = (mover: Mover) => t - mover.pokedAt < DASH
			Arr.forEach(roadGoing, (cart) => {
				const pace = isDashing(cart) ? DASH_PACE : moving && cart.running ? 1 : 0
				cart.progress = (cart.progress + (step * cart.speed * pace) / cart.trip) % 1
			})
			box.step(
				step,
				(index) => {
					const engine = engines[index]
					return engine === undefined ? 0 : isDashing(engine) ? DASH_PACE : moving ? 1 : 0
				},
				// A dimmed link's train is let finish its trip, then kept at home.
				(index) => engines[index]?.running === true,
			)
			const busy = Arr.some(movers, isDashing)
			if (moving || busy) clock.puffed += step
			place()
			return busy
		},
		setRunning: (isRunning) =>
			Arr.forEach(movers, (mover) => {
				mover.running = isRunning(mover.linkId)
			}),
		dispose: () => {
			Arr.forEach(fleets, (mesh) => {
				mesh.geometry.dispose()
				mesh.dispose()
				Arr.forEach([mesh.material].flat(), (material) => material.dispose())
			})
		},
	}
}

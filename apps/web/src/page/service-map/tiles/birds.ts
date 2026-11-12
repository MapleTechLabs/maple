import { Array as Arr, Option } from "effect"
import * as THREE from "three"
import type { Point } from "./hex"
import type { Vec3 } from "./solid"

// Birds over the board. Three small flights circle it on slow arcs; a click on one sends its
// flight climbing away fast for a while. `flush` scatters a handful from a spot on the ground,
// for a church bell or a tile coming down.

/** Seconds a startled flight stays fast and high, and a flushed bird stays in sight. */
export const STARTLED = 3.5
const FLUSH = 2.4
/** Birds in the pool `flush` draws from. */
const FLUSHED = 8

const INK = 0x4a4f55
const SIZE = 1.7

/** One bird pointing along +x: a body and two wings hinged at the shoulders. */
const makeBird = (body: THREE.BufferGeometry, wing: THREE.BufferGeometry, material: THREE.Material) => {
	const root = new THREE.Group()
	const wings = Arr.map([1, -1], (side) => {
		const hinge = new THREE.Group()
		const blade = new THREE.Mesh(wing, material)
		blade.scale.z = side
		hinge.add(blade)
		return hinge
	})
	root.add(new THREE.Mesh(body, material), ...wings)
	// Bigger than life, or a flight would be three specks from where the camera sits.
	root.scale.setScalar(SIZE)
	return {
		root,
		/** `beat` is -1 to 1: wings fully down to fully up. */
		flap: (beat: number) =>
			Arr.forEach(wings, (hinge, index) => {
				hinge.rotation.x = (index === 0 ? -1 : 1) * beat * 0.7
			}),
	}
}

type Bird = ReturnType<typeof makeBird>

interface Flight {
	readonly birds: ReadonlyArray<Bird>
	readonly target: THREE.Mesh
	/** How far out it circles (a share of the board's radius), how high, and how fast. */
	readonly orbit: number
	readonly height: number
	readonly pace: number
	turn: number
	/** When it last took fright, in seconds; `-Infinity` if never. */
	startledAt: number
	/** How far it has climbed above its usual height. */
	lift: number
}

interface Flushed {
	readonly bird: Bird
	readonly heading: number
	from: Vec3
	/** When it left the ground; `null` while it waits in the pool. */
	leftAt: number | null
}

export interface Sky {
	readonly root: THREE.Group
	/** The flight under the ray, if any. */
	readonly under: (raycaster: THREE.Raycaster) => number | null
	readonly startle: (index: number) => void
	/** Sends a handful of birds up and away from `at`. */
	readonly flush: (at: Vec3) => void
	/** Moves the birds round `centre`; `gliding` advances the slow circling, frights and flushes
	 * run on real time. `true` while one is still playing out. */
	readonly frame: (delta: number, gliding: boolean, centre: Point, radius: number) => boolean
	readonly dispose: () => void
}

/** Where the wingmates fly, in the leader's frame: behind and out to each side. */
const STATIONS: ReadonlyArray<readonly [number, number]> = [
	[0, 0],
	[-0.6, 0.5],
	[-0.6, -0.5],
]

export const makeSky = (): Sky => {
	const root = new THREE.Group()
	const body = new THREE.ConeGeometry(0.045, 0.24, 5).rotateZ(-Math.PI / 2)
	const wing = new THREE.BufferGeometry()
	wing.setAttribute(
		"position",
		new THREE.Float32BufferAttribute([0.06, 0, 0, -0.08, 0, 0, -0.03, 0, 0.24], 3),
	)
	const material = new THREE.MeshBasicMaterial({ color: INK, side: THREE.DoubleSide })
	const unseen = new THREE.MeshBasicMaterial({ visible: false })
	// A flight is a few specks on screen, so one roomy ball round it takes the clicks.
	const ball = new THREE.SphereGeometry(1, 8, 6)
	const flights = Arr.map(
		[
			{ orbit: 0.5, height: 3.6, pace: 0.11, turn: 0.4 },
			{ orbit: 0.78, height: 4.4, pace: -0.08, turn: 2.6 },
			{ orbit: 0.3, height: 5, pace: 0.14, turn: 4.4 },
		],
		(spec): Flight => {
			const birds = Arr.map(STATIONS, () => makeBird(body, wing, material))
			const target = new THREE.Mesh(ball, unseen)
			root.add(target, ...Arr.map(birds, (bird) => bird.root))
			return { ...spec, birds, target, startledAt: -Infinity, lift: 0 }
		},
	)
	const pool = Arr.makeBy(FLUSHED, (index): Flushed => {
		const bird = makeBird(body, wing, material)
		bird.root.visible = false
		root.add(bird.root)
		return { bird, heading: (index / FLUSHED) * Math.PI * 2 + index * 0.7, from: [0, 0, 0], leftAt: null }
	})
	const now = () => performance.now() / 1000
	return {
		root,
		under: (raycaster) =>
			Option.getOrNull(
				Arr.findFirstIndex(
					flights,
					(flight) => raycaster.intersectObject(flight.target, false).length > 0,
				),
			),
		startle: (index) => {
			const flight = flights[index]
			if (flight !== undefined) flight.startledAt = now()
		},
		flush: (at) => {
			const t = now()
			Arr.forEach(pool, (flushed) => {
				flushed.from = at
				flushed.leftAt = t
			})
		},
		frame: (delta, gliding, centre, radius) => {
			const t = now()
			const frights = Arr.map(flights, (flight) => {
				const startled = t - flight.startledAt < STARTLED
				const pace = flight.pace * (startled ? 5 : gliding ? 1 : 0)
				flight.turn += pace * Math.min(delta, 0.05)
				// The climb eases in and out, so a fright never snaps the flight upward.
				flight.lift += ((startled ? 2.6 : 0) - flight.lift) * Math.min(1, delta * 2.5)
				const out = Math.max(4, radius * flight.orbit)
				const x = centre[0] + Math.cos(flight.turn) * out
				const z = centre[1] + Math.sin(flight.turn) * out
				const y = flight.height + flight.lift + Math.sin(flight.turn * 3) * 0.15
				// Local +x follows the circle, forwards for a positive pace and backwards for a negative one.
				const yaw =
					Math.atan2(-Math.cos(flight.turn), -Math.sin(flight.turn)) +
					(flight.pace < 0 ? Math.PI : 0)
				const [cos, sin] = [Math.cos(yaw), Math.sin(yaw)]
				flight.target.position.set(x, y, z)
				Arr.forEach(flight.birds, (bird, index) => {
					const [back, side] = STATIONS[index] ?? [0, 0]
					bird.root.position.set(x + back * cos + side * sin, y, z - back * sin + side * cos)
					bird.root.rotation.y = yaw
					// A startled flight beats hard; a gliding one flaps a little, each bird out of step.
					bird.flap(Math.sin(t * (startled ? 22 : 7) + index * 1.7) * (startled ? 1 : 0.55))
				})
				return startled || Math.abs(flight.lift) > 0.02
			})
			const flushes = Arr.map(pool, (flushed) => {
				const { bird, leftAt } = flushed
				if (leftAt === null) return false
				const u = (t - leftAt) / FLUSH
				if (u >= 1) {
					flushed.leftAt = null
					bird.root.visible = false
					return false
				}
				const [x, y, z] = flushed.from
				const far = u * (5 + (flushed.heading % 1) * 2.5)
				bird.root.visible = true
				bird.root.position.set(
					x + Math.cos(flushed.heading) * far,
					y + Math.pow(u, 0.7) * 4.5,
					z + Math.sin(flushed.heading) * far,
				)
				bird.root.rotation.y = -flushed.heading
				bird.root.scale.setScalar(SIZE * Math.max(0.001, 1 - Math.max(0, (u - 0.75) / 0.25)))
				bird.flap(Math.sin(t * 24 + flushed.heading))
				return true
			})
			return Arr.some(frights, Boolean) || Arr.some(flushes, Boolean)
		},
		dispose: () => {
			body.dispose()
			wing.dispose()
			ball.dispose()
			material.dispose()
			unseen.dispose()
		},
	}
}

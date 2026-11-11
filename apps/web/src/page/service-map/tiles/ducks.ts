import { Array as Arr, Option } from "effect"
import * as THREE from "three"
import { DUCK_LOOP } from "./lake"
import type { TilePalette } from "./palette"
import { fuse, part } from "./solid"

// The mallards of the lake, as on the factory map: they paddle a steady loop, a click makes one
// hop and quack, and a few quick clicks send it flying off for a while.

/** Seconds a poked duck spends hopping. */
export const HOP = 0.45
/** Seconds a startled duck takes to fly off, and later to glide back in. */
export const FLIGHT = 2.6
/** Pokes in quick succession that scare a duck off the lake. */
export const STARTLE = 5
/** Seconds a duck stays away before it comes back. */
export const AWAY = 25
/** Pokes further apart than this start the count over. */
const PATIENCE = 1.5

export interface DuckMood {
	/** When the current hop lands, in seconds. */
	readonly landsAt: number
	/** Quick pokes so far, and when the last one came. */
	readonly strikes: number
	readonly struckAt: number
	/** When the duck took off; `null` while it is on the water. */
	readonly tookOffAt: number | null
}

export const calmDuck: DuckMood = { landsAt: 0, strikes: 0, struckAt: -Infinity, tookOffAt: null }

/** What a poke did: the scene keeps drawing for `seconds` and quacks in `alarm` or not. */
export interface Poke {
	readonly seconds: number
	readonly alarm: boolean
}

/** A poke at `now`: a hop, or a take-off on the `STARTLE`th quick one. A duck that is away
 * cannot be poked. */
export const pokeDuck = (
	duck: DuckMood,
	now: number,
): { readonly duck: DuckMood; readonly poke: Option.Option<Poke> } => {
	if (duck.tookOffAt !== null) return { duck, poke: Option.none() }
	const strikes = now - duck.struckAt < PATIENCE ? duck.strikes + 1 : 1
	if (strikes < STARTLE)
		return {
			duck: { ...duck, strikes, struckAt: now, landsAt: now + HOP },
			poke: Option.some({ seconds: HOP, alarm: false }),
		}
	return {
		duck: { landsAt: 0, strikes: 0, struckAt: now, tookOffAt: now },
		poke: Option.some({ seconds: FLIGHT, alarm: true }),
	}
}

/** A startled duck is back on the water once it has flown out, stayed away and glided in. */
export const isBack = (duck: DuckMood, now: number): boolean =>
	duck.tookOffAt !== null && now - duck.tookOffAt >= FLIGHT * 2 + AWAY

/** A mallard pointing along +x, sitting on y = 0. */
const duckGeometry = (palette: TilePalette): THREE.BufferGeometry =>
	fuse([
		part(new THREE.IcosahedronGeometry(0.1, 1), palette.duck, {
			position: [0, 0.055, 0],
			scale: [1.5, 0.75, 1],
		}),
		part(new THREE.ConeGeometry(0.05, 0.12, 5).rotateZ(Math.PI / 2 + 0.5), palette.duck, {
			position: [-0.16, 0.1, 0],
		}),
		part(new THREE.IcosahedronGeometry(0.055, 1), palette.duckHead, { position: [0.13, 0.15, 0] }),
		part(new THREE.ConeGeometry(0.024, 0.08, 4).rotateZ(-Math.PI / 2), palette.bill, {
			position: [0.2, 0.14, 0],
		}),
	])

interface Duck {
	readonly phase: number
	readonly lane: number
	readonly node: THREE.Group
	readonly body: THREE.Group
	readonly wings: readonly [THREE.Mesh, THREE.Mesh]
	readonly target: THREE.Mesh
	mood: DuckMood
}

export interface Flock {
	readonly root: THREE.Group
	/** The duck on the water under the ray, if any. Only the hit boxes are tested. */
	readonly under: (raycaster: THREE.Raycaster) => number | null
	readonly poke: (index: number) => Option.Option<Poke>
	/** Moves the flock; `paddling` advances the loop, hops and flights run on real time. `true`
	 * while a duck is mid-hop or in the air, so a paused map keeps drawing until it settles. */
	readonly frame: (delta: number, paddling: boolean) => boolean
	readonly dispose: () => void
}

export const makeFlock = (palette: TilePalette, material: THREE.Material): Flock => {
	const root = new THREE.Group()
	// A little bigger than life, so a duck can be found and clicked from the whole-map view.
	root.scale.setScalar(1.4)
	const geometry = duckGeometry(palette)
	const wing = new THREE.BoxGeometry(0.11, 0.014, 0.17)
	const wingMaterial = new THREE.MeshLambertMaterial({ color: palette.duck, flatShading: true })
	const unseen = new THREE.MeshBasicMaterial({ visible: false })
	// The duck is tiny on screen, so a roomier invisible box takes its clicks.
	const box = new THREE.BoxGeometry(0.5, 0.4, 0.4)
	const flock = Arr.map([0.12, 0.2, 0.62], (phase, index): Duck => {
		const mesh = new THREE.Mesh(geometry, material)
		mesh.castShadow = true
		const side = (sign: number) => {
			const blade = new THREE.Mesh(wing, wingMaterial)
			blade.position.set(-0.01, 0.1, sign * 0.14)
			blade.visible = false
			return blade
		}
		const wings = [side(-1), side(1)] as const
		const body = new THREE.Group()
		body.add(mesh, ...wings)
		const target = new THREE.Mesh(box, unseen)
		target.position.y = 0.12
		const node = new THREE.Group()
		node.add(body, target)
		root.add(node)
		return { phase, lane: 1 + (index - 1) * 0.22, node, body, wings, target, mood: calmDuck }
	})
	const clock = { paddled: 0 }
	const now = () => performance.now() / 1000
	/** Poses the body for a flight `u` of the way out (0 on the water, 1 gone), forward along +x. */
	const fly = (duck: Duck, u: number, sign: number, t: number) => {
		const beat = Math.sin(t * Math.PI * 2 * 5)
		duck.body.position.set(sign * u * u * 9, Math.pow(u, 1.4) * 5.5 + beat * 0.015, 0)
		duck.body.rotation.set(0, 0, sign * Math.min(1, u * 5) * 0.35)
		duck.body.scale.setScalar(Math.max(0.001, 1 - Math.max(0, (u - 0.7) / 0.3)))
		const stroke = 0.15 + beat * 0.85
		const [left, right] = duck.wings
		left.visible = true
		right.visible = true
		left.rotation.x = stroke
		right.rotation.x = -stroke
	}
	const settle = (duck: Duck) => {
		duck.body.scale.setScalar(1)
		duck.body.rotation.set(0, 0, 0)
		duck.body.position.set(0, 0, 0)
		Arr.forEach(duck.wings, (blade) => {
			blade.visible = false
		})
	}
	return {
		root,
		under: (raycaster) => {
			// A ray does not skip hidden objects: with no lake there is no duck to click, and one
			// that has flown off leaves its spot on the water to whatever is under it.
			if (!root.visible) return null
			const hit = Arr.findFirstIndex(
				flock,
				(duck) =>
					duck.mood.tookOffAt === null && raycaster.intersectObject(duck.target, false).length > 0,
			)
			return Option.getOrNull(hit)
		},
		poke: (index) => {
			const duck = flock[index]
			if (duck === undefined) return Option.none()
			const result = pokeDuck(duck.mood, now())
			duck.mood = result.duck
			return result.poke
		},
		frame: (delta, paddling) => {
			if (paddling) clock.paddled += Math.min(delta, 0.05)
			const t = now()
			return Arr.reduce(flock, false, (busy, duck) => {
				const angle = (duck.phase + clock.paddled * 0.035) * Math.PI * 2
				duck.node.position.set(
					Math.cos(angle) * DUCK_LOOP * duck.lane,
					0,
					Math.sin(angle) * DUCK_LOOP * duck.lane,
				)
				// Local +x follows the loop: the tangent of a turn about the lake's middle.
				duck.node.rotation.y = Math.atan2(-Math.cos(angle), -Math.sin(angle))
				const { tookOffAt, landsAt } = duck.mood
				if (tookOffAt !== null) {
					if (isBack(duck.mood, t)) {
						duck.mood = calmDuck
						settle(duck)
						return busy
					}
					const gone = t - tookOffAt
					// Out ahead, away a while, then back in from behind along the mirrored path.
					const back = gone - FLIGHT - AWAY
					if (gone < FLIGHT) fly(duck, gone / FLIGHT, 1, t)
					else if (back < 0) fly(duck, 1, 1, t)
					else fly(duck, 1 - back / FLIGHT, -1, t)
					return busy || gone < FLIGHT || back >= 0
				}
				const left = Math.max(0, landsAt - t)
				const u = 1 - left / HOP
				duck.body.position.y = left > 0 ? Math.sin(Math.PI * u) * 0.12 : 0
				duck.body.rotation.z = left > 0 ? Math.sin(Math.PI * 2 * u) * 0.25 : 0
				return busy || left > 0
			})
		},
		dispose: () => {
			geometry.dispose()
			wing.dispose()
			box.dispose()
			wingMaterial.dispose()
			unseen.dispose()
		},
	}
}

import { Array as Arr } from "effect"
import * as THREE from "three"
import type { Point } from "./hex"
import type { Vec3 } from "./solid"

// Things that play out once and are gone: the rings a click leaves on the water, and the beam a
// poked lighthouse sweeps round.

const RIPPLE = 1.1
const BEAM = 3.2

interface Playing {
	readonly node: THREE.Object3D
	readonly since: number
	readonly length: number
	/** Poses the node `u` of the way through, 0 to 1. */
	readonly pose: (u: number) => void
	readonly free: () => void
}

export interface Flourishes {
	readonly root: THREE.Group
	/** Rings spreading on the water from `at`. */
	readonly ripple: (at: Point, color: string) => void
	/** A lamp's beam turning about `at`. */
	readonly beam: (at: Vec3, color: string) => void
	/** Advances what is playing; `true` while anything still is. */
	readonly frame: () => boolean
	readonly dispose: () => void
}

export const makeFlourishes = (): Flourishes => {
	const root = new THREE.Group()
	const playing: Array<Playing> = []
	const now = () => performance.now() / 1000
	const play = (entry: Playing) => {
		root.add(entry.node)
		playing.push(entry)
	}
	return {
		root,
		ripple: ([x, z], color) =>
			Arr.forEach([0, 0.22], (delay) => {
				const geometry = new THREE.RingGeometry(0.86, 1, 28).rotateX(-Math.PI / 2)
				const material = new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false })
				const ring = new THREE.Mesh(geometry, material)
				ring.position.set(x, 0.045, z)
				ring.renderOrder = 8
				ring.visible = false
				play({
					node: ring,
					since: now() + delay,
					length: RIPPLE,
					pose: (u) => {
						ring.visible = u >= 0
						ring.scale.setScalar(0.12 + Math.max(0, u) * 0.85)
						material.opacity = 0.75 * (1 - Math.max(0, u))
					},
					free: () => {
						geometry.dispose()
						material.dispose()
					},
				})
			}),
		beam: ([x, y, z], color) => {
			// A flat wedge lying on its side, its point on the lamp.
			const geometry = new THREE.BufferGeometry()
			geometry.setAttribute(
				"position",
				new THREE.Float32BufferAttribute(
					[0, 0, 0, 5.5, 0.25, -0.9, 5.5, 0.25, 0.9, 0, 0, 0, 5.5, -0.9, 0, 5.5, 0.6, 0],
					3,
				),
			)
			const material = new THREE.MeshBasicMaterial({
				color,
				transparent: true,
				depthWrite: false,
				side: THREE.DoubleSide,
				blending: THREE.AdditiveBlending,
			})
			const wedge = new THREE.Mesh(geometry, material)
			wedge.position.set(x, y, z)
			wedge.renderOrder = 8
			play({
				node: wedge,
				since: now(),
				length: BEAM,
				pose: (u) => {
					wedge.rotation.y = u * Math.PI * 3
					// Full for most of the sweep, then it goes out.
					material.opacity = 0.34 * Math.min(1, u * 8, (1 - u) * 4)
				},
				free: () => {
					geometry.dispose()
					material.dispose()
				},
			})
		},
		frame: () => {
			const t = now()
			const done = Arr.filter(playing, (entry) => t - entry.since >= entry.length)
			Arr.forEach(done, (entry) => {
				root.remove(entry.node)
				entry.free()
				playing.splice(playing.indexOf(entry), 1)
			})
			Arr.forEach(playing, (entry) => entry.pose((t - entry.since) / entry.length))
			return playing.length > 0
		},
		dispose: () => {
			Arr.forEach(playing, (entry) => entry.free())
			playing.length = 0
		},
	}
}

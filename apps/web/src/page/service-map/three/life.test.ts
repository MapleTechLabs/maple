import { mapPalette } from "../../../components/service-map/three/appearance"
import * as THREE from "three"
import { Array as Arr } from "effect"
import { describe, expect, it } from "vitest"
import { type Child, makeScope, type Scope } from "./kit"
import { butterflies, fallingLeaves } from "./life"
import { breeze } from "./props-kit"

const world = {
	sources: [{ x: 0, z: 0, top: 1.2, radius: 0.35 }],
	districts: [],
	floor: -0.14,
}

/** Builds one moving thing and returns a way to run frames and read every instance's matrix. */
const staged = (build: (scope: Scope) => Child) => {
	const scope = makeScope()
	const meshes = Arr.filter([build(scope)].flat(), (child) => child instanceof THREE.InstancedMesh)
	const step = (seconds: number) =>
		Arr.forEach(
			Arr.makeBy(Math.round(seconds / 0.05), () => 0.05),
			(delta) => Arr.forEach(scope.frames, (frame) => frame(delta)),
		)
	const matrices = () => Arr.flatMap(meshes, (mesh) => Array.from(mesh.instanceMatrix.array))
	return { step, matrices }
}

describe("falling leaves in the scene", () => {
	it("hold exactly still while traffic is paused, and move again once it plays", () => {
		const state = { playing: true }
		const scene = staged((scope) =>
			fallingLeaves(scope, { world, palette: mapPalette(false), running: () => state.playing }),
		)
		scene.step(3)
		state.playing = false
		const paused = scene.matrices()
		scene.step(5)
		expect(scene.matrices()).toEqual(paused)
		state.playing = true
		scene.step(1)
		expect(scene.matrices()).not.toEqual(paused)
	})
})

describe("butterflies in the scene", () => {
	const flock = (running: () => boolean) =>
		staged((scope) =>
			butterflies(scope, {
				anchors: [
					[0, 0, 0],
					[2, 0, -1],
				],
				floor: -0.14,
				palette: mapPalette(false),
				running,
			}),
		)

	it("hold exactly still while traffic is paused, and fly again once it plays", () => {
		const state = { playing: true }
		const scene = flock(() => state.playing)
		scene.step(3)
		state.playing = false
		const paused = scene.matrices()
		scene.step(5)
		expect(scene.matrices()).toEqual(paused)
		state.playing = true
		scene.step(1)
		expect(scene.matrices()).not.toEqual(paused)
	})

	it("stay within a short flight of the glade they belong to", () => {
		const scene = flock(() => true)
		scene.step(40)
		// Each instance matrix, wings and bodies alike, carries its position in elements 12 to 14.
		const nearest = Arr.map(Arr.chunksOf(scene.matrices(), 16), (m) => {
			const [x, z] = [m[12] ?? 0, m[14] ?? 0]
			return Math.min(Math.hypot(x, z), Math.hypot(x - 2, z + 1))
		})
		expect(Math.max(...nearest)).toBeLessThan(1.4)
	})
})

describe("the breeze", () => {
	/** Something swaying on `wind`, reporting the wind time of its current pose. */
	const sway = (wind: { seconds: number }, running: () => boolean) => {
		const scope = makeScope()
		const pose = { seconds: -1 }
		breeze(scope, { running, wind: () => wind.seconds }, (seconds) => {
			pose.seconds = seconds
		})
		return { pose, frame: () => Arr.forEach(scope.frames, (frame) => frame(0.016)) }
	}

	it("poses a thing on the wind as it is built, so a rebuilt machine keeps its swing", () => {
		expect(sway({ seconds: 7.5 }, () => true).pose.seconds).toBe(7.5)
		expect(sway({ seconds: 7.5 }, () => false).pose.seconds).toBe(7.5)
	})

	it("keeps one thing swaying while its dimmed neighbour holds still", () => {
		const wind = { seconds: 3 }
		const lively = sway(wind, () => true)
		const dimmed = sway(wind, () => false)
		wind.seconds = 4
		dimmed.frame()
		lively.frame()
		expect(lively.pose.seconds).toBe(4)
		expect(dimmed.pose.seconds).toBe(3)
	})
})

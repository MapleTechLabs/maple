import { mapPalette } from "../../../components/service-map/three/appearance"
import * as THREE from "three"
import { Array as Arr } from "effect"
import { describe, expect, it } from "vitest"
import { makeScope } from "./kit"
import { fallingLeaves } from "./life"

const world = {
	sources: [{ x: 0, z: 0, top: 1.2, radius: 0.35 }],
	districts: [],
	floor: -0.14,
}

/** Builds the falling leaves and returns a way to run frames and read every leaf's matrix. */
const leaves = (running: () => boolean) => {
	const scope = makeScope()
	const meshes = Arr.filter(
		[fallingLeaves(scope, { world, palette: mapPalette(false), running })].flat(),
		(child) => child instanceof THREE.InstancedMesh,
	)
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
		const scene = leaves(() => state.playing)
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

import * as THREE from "three"
import { describe, expect, it } from "vitest"
import { anchorShift, type FrameMemory, type FrameNext, frameStep } from "./camera"

const WIDE = { width: 1184, height: 700 }
const NARROW = { width: 769, height: 700 }

const next = (overrides: Partial<FrameNext> = {}): FrameNext => ({
	view: "atlas",
	fitKey: "a,b",
	size: WIDE,
	selectedId: null,
	reset: false,
	...overrides,
})

const fitted = (overrides: Partial<FrameMemory> = {}): FrameMemory => ({
	view: "atlas",
	fitKey: "a,b",
	size: WIDE,
	selectedId: null,
	userMoved: false,
	...overrides,
})

describe("frameStep", () => {
	it("fits the first frame, a view switch and Reset, whatever the user did", () => {
		expect(frameStep(null, next()).step).toBe("fit")
		expect(frameStep(fitted({ userMoved: true }), next({ view: "cascade" })).step).toBe("fit")
		expect(frameStep(fitted({ userMoved: true }), next({ reset: true })).step).toBe("fit")
	})

	it("refits a resize or a new node set while the user has not taken the view", () => {
		expect(frameStep(fitted(), next({ size: NARROW })).step).toBe("fit")
		expect(frameStep(fitted(), next({ fitKey: "a,b,c" })).step).toBe("fit")
	})

	it("after a pan, a resize keeps the corner and a new node set changes nothing", () => {
		const panned = fitted({ userMoved: true })
		expect(frameStep(panned, next({ size: NARROW })).step).toBe("shift")
		expect(frameStep(panned, next({ fitKey: "a,b,c" })).step).toBe("none")
	})

	it("selecting from a label or the keyboard (no canvas press) never refits as its panel opens", () => {
		const selected = frameStep(fitted(), next({ selectedId: "a", size: NARROW }))
		expect(selected.step).toBe("shift")
		const cleared = frameStep(selected.memory, next({ selectedId: null, size: WIDE }))
		expect(cleared.step).toBe("shift")
	})
})

describe("anchorShift", () => {
	/** The scene's camera, framed to `size` as `fitFrustum` does. */
	const cameraAt = (size: { width: number; height: number }, zoom: number) => {
		const camera = new THREE.OrthographicCamera(
			-size.width / 2,
			size.width / 2,
			size.height / 2,
			-size.height / 2,
			0.1,
			1000,
		)
		camera.position.set(30, 20, 30)
		camera.lookAt(0, 0, 0)
		camera.zoom = zoom
		camera.updateProjectionMatrix()
		camera.updateMatrixWorld()
		return camera
	}
	const topLeft = (camera: THREE.OrthographicCamera) => new THREE.Vector3(-1, 1, 0).unproject(camera)

	it("keeps the view's top-left corner on the same world point when the canvas narrows", () => {
		const camera = cameraAt(WIDE, 2.5)
		const before = topLeft(camera)
		const shift = anchorShift(camera, WIDE, NARROW)
		camera.left = -NARROW.width / 2
		camera.right = NARROW.width / 2
		camera.position.add(shift)
		camera.updateProjectionMatrix()
		camera.updateMatrixWorld()
		const after = topLeft(camera)
		expect(after.distanceTo(before)).toBeLessThan(1e-6)
		expect(camera.zoom).toBe(2.5)
	})
})

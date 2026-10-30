import { mapPalette } from "../../../components/service-map/three/appearance"
import { DRAG_TOLERANCE } from "../../../components/service-map/three/scene-input"
import type { SpatialView } from "../../../components/service-map/three/spatial-layout"
import type { Topology3D } from "../../../components/service-map/three/types"
import * as THREE from "three"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"
import { type CameraCommand, cameraRig, type Size } from "./camera"
import { HOP } from "./critters"
import { type Child, disposeTree, group, makeScope, type Scope } from "./kit"
import { quacker } from "./quack"
import { type Layout, layoutOf, sceneryKey, sceneryOf, worldOf } from "./world"

// The 3D service map: an orthographic, flat renderer (dpr 1 to 2, antialias, alpha), its demand
// or always frame loop, the camera rig and machine picking. The lazy scene chunk's entry; the view owns all DOM.

export interface SceneInput {
	readonly topology: Topology3D
	readonly selectedId: string | null
	readonly view: SpatialView
	readonly flowing: boolean
	readonly dark: boolean
	readonly command: CameraCommand
}

export interface SceneHandle {
	readonly update: (input: SceneInput) => void
	readonly stop: () => void
}

interface Built {
	readonly input: SceneInput
	readonly layout: Layout
	readonly sceneryKey: string
	readonly scenery: { readonly scope: Scope; readonly root: THREE.Group }
	readonly world: { readonly scope: Scope; readonly root: THREE.Group }
}

const disposeScope = (scope: Scope, root: THREE.Object3D) => {
	disposeTree(root)
	scope.textures.forEach((texture) => texture.dispose())
}

const asGroup = (child: Child): THREE.Group => (child instanceof THREE.Group ? child : group({}, [child]))

/** R3F's default orthographic camera, framed to the canvas size as `updateCamera` does. */
const fitFrustum = (camera: THREE.OrthographicCamera, { width, height }: Size) => {
	camera.left = width / -2
	camera.right = width / 2
	camera.top = height / 2
	camera.bottom = height / -2
	camera.updateProjectionMatrix()
}

const makeOrbit = (camera: THREE.OrthographicCamera, canvas: HTMLCanvasElement) => {
	const orbit = new OrbitControls(camera, canvas)
	// The projection is part of the drawing: pan and zoom, never orbit.
	orbit.enableRotate = false
	orbit.enableDamping = true
	orbit.dampingFactor = 0.12
	orbit.screenSpacePanning = true
	orbit.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }
	orbit.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN }
	orbit.minZoom = 0.05
	orbit.maxZoom = 100
	return orbit
}

const aim = (camera: THREE.Camera, event: MouseEvent, size: Size): THREE.Raycaster => {
	const raycaster = new THREE.Raycaster()
	raycaster.setFromCamera(
		new THREE.Vector2((event.offsetX / size.width) * 2 - 1, -(event.offsetY / size.height) * 2 + 1),
		camera,
	)
	return raycaster
}

/** Raycasts the machines (R3F's event objects), nearest first; ids from `userData.pickId`. */
const pick = (
	camera: THREE.Camera,
	world: THREE.Object3D,
	event: MouseEvent,
	size: Size,
): ReadonlyArray<string> => {
	const raycaster = aim(camera, event, size)
	return world.children
		.filter((node) => typeof node.userData.pickId === "string")
		.flatMap((machine) =>
			raycaster
				.intersectObject(machine, true)
				.map((hit) => ({ id: String(machine.userData.pickId), hit })),
		)
		.toSorted((a, b) => a.hit.distance - b.hit.distance)
		.map(({ id }) => id)
}

/** The `userData.quack` of the duck hit box under the pointer, if any. Only the boxes are
 * tested: the ink outlines would pick with three's 1-unit line threshold. */
const pickDuck = (
	camera: THREE.Camera,
	scenery: THREE.Object3D,
	event: MouseEvent,
	size: Size,
): (() => void) | null => {
	const ducks: Array<THREE.Object3D> = []
	scenery.traverse((node) => {
		if (typeof node.userData.quack === "function") ducks.push(node)
	})
	const raycaster = aim(camera, event, size)
	const hit = ducks.find((duck) => raycaster.intersectObject(duck, false).length > 0)
	return hit === undefined ? null : hit.userData.quack
}

/** Builds (or keeps) the scenery and rebuilds the world for `input`. */
const build = (
	scene: THREE.Scene,
	input: SceneInput,
	previous: Built | null,
	flowing: () => boolean,
): Built => {
	const layout =
		previous !== null && previous.input.topology === input.topology && previous.input.view === input.view
			? previous.layout
			: layoutOf(input.topology, input.view)
	const worldInput = {
		topology: input.topology,
		layout,
		view: input.view,
		selectedId: input.selectedId,
		palette: mapPalette(input.dark),
		flowing,
	}
	const key = sceneryKey(worldInput)
	const keep = previous !== null && previous.sceneryKey === key
	if (previous !== null) {
		scene.remove(previous.world.root)
		disposeScope(previous.world.scope, previous.world.root)
		if (!keep) {
			scene.remove(previous.scenery.root)
			disposeScope(previous.scenery.scope, previous.scenery.root)
		}
	}
	const sceneryScope = keep && previous !== null ? previous.scenery.scope : makeScope()
	const scenery =
		keep && previous !== null
			? previous.scenery
			: { scope: sceneryScope, root: asGroup(sceneryOf(sceneryScope, worldInput)) }
	const worldScope = makeScope()
	const world = { scope: worldScope, root: worldOf(worldScope, worldInput) }
	if (!keep) scene.add(scenery.root)
	scene.add(world.root)
	return { input, layout, sceneryKey: key, scenery, world }
}

const measure = (element: Element): Size => {
	const { width, height } = element.getBoundingClientRect()
	return { width, height }
}

/**
 * Starts the scene on `canvas` (inside R3F's two wrapper divs, under `[data-scene-root]`, which
 * holds the labels). `onSelect` gets a machine click, or `null` for a miss.
 */
export function startScene(
	canvas: HTMLCanvasElement,
	initial: SceneInput,
	onSelect: (id: string | null) => void,
): SceneHandle {
	const container = canvas.parentElement ?? canvas
	const target = container.parentElement ?? container
	const labelsRoot = canvas.closest("[data-scene-root]") ?? target
	const renderer = new THREE.WebGLRenderer({
		canvas,
		powerPreference: "high-performance",
		antialias: true,
		alpha: true,
	})
	THREE.ColorManagement.enabled = true
	renderer.outputColorSpace = THREE.SRGBColorSpace
	renderer.toneMapping = THREE.NoToneMapping
	const camera = new THREE.OrthographicCamera(0, 0, 0, 0, 0.1, 1000)
	camera.position.z = 5
	camera.lookAt(0, 0, 0)
	const scene = new THREE.Scene()
	const live = { input: initial }
	const flowing = () => live.input.flowing
	const state = {
		size: measure(container),
		pending: 0,
		/** Draw every frame until this time (ms), whatever the demand count. */
		awakeUntil: 0,
		raf: 0,
		last: performance.now(),
		pressed: { x: 0, y: 0, offsetX: 0, offsetY: 0, hits: new Array<string>() },
		built: build(scene, initial, null, flowing),
	}
	const invalidate = () => {
		state.pending = Math.min(60, state.pending + 1)
	}
	const resize = () => {
		state.size = measure(container)
		renderer.setPixelRatio(Math.min(Math.max(1, window.devicePixelRatio), 2))
		renderer.setSize(state.size.width, state.size.height, true)
		fitFrustum(camera, state.size)
		invalidate()
	}
	resize()
	const orbit = makeOrbit(camera, canvas)
	orbit.addEventListener("change", invalidate)
	const rig = cameraRig(
		camera,
		orbit,
		labelsRoot,
		() => ({ ...live.input, layout: state.built.layout }),
		() => state.size,
		invalidate,
	)
	const loop = (now: number) => {
		state.raf = requestAnimationFrame(loop)
		if (!flowing() && state.pending === 0 && now > state.awakeUntil) return
		if (!flowing()) state.pending = Math.max(0, state.pending - 1)
		const delta = (now - state.last) / 1000
		state.last = now
		rig()
		state.built.scenery.scope.frames.forEach((frame) => frame(delta))
		state.built.world.scope.frames.forEach((frame) => frame(delta))
		renderer.render(scene, camera)
	}
	state.raf = requestAnimationFrame(loop)
	invalidate()
	const observer = new ResizeObserver(resize)
	observer.observe(container)
	const quacks = quacker()
	// R3F's click semantics: a miss within 2 px (and the canvas's own 5 px check) clears the
	// selection; a machine click must start on that machine and travel at most DRAG_TOLERANCE.
	const onPointerDown = (event: PointerEvent) => {
		state.pressed = {
			x: event.clientX,
			y: event.clientY,
			offsetX: event.offsetX,
			offsetY: event.offsetY,
			hits: [...pick(camera, state.built.world.root, event, state.size)],
		}
	}
	const onClick = (event: MouseEvent) => {
		const hits = pick(camera, state.built.world.root, event, state.size)
		const delta = Math.hypot(event.offsetX - state.pressed.offsetX, event.offsetY - state.pressed.offsetY)
		const first = hits[0]
		if (first === undefined) {
			const moved = Math.hypot(event.clientX - state.pressed.x, event.clientY - state.pressed.y)
			const duck =
				moved <= DRAG_TOLERANCE ? pickDuck(camera, state.built.scenery.root, event, state.size) : null
			if (duck !== null) {
				duck()
				quacks.quack()
				// Keep drawing for the whole hop on a paused map, at any refresh rate.
				state.awakeUntil = performance.now() + HOP * 1000 + 50
				return
			}
			if (delta <= 2 && moved <= DRAG_TOLERANCE) onSelect(null)
			return
		}
		if (!state.pressed.hits.includes(first) || delta > DRAG_TOLERANCE) return
		onSelect(live.input.selectedId === first ? null : first)
	}
	target.addEventListener("pointerdown", onPointerDown)
	target.addEventListener("click", onClick)
	return {
		update: (input) => {
			const previous = live.input
			live.input = input
			const changed =
				previous.topology !== input.topology ||
				previous.view !== input.view ||
				previous.selectedId !== input.selectedId ||
				previous.dark !== input.dark
			if (changed) state.built = build(scene, input, state.built, flowing)
			// A camera command alone changes no scene prop, so the demand loop draws no frame for it;
			// the zoom lands on the next frame (always while traffic flows).
			if (changed || input.flowing !== previous.flowing) invalidate()
		},
		stop: () => {
			cancelAnimationFrame(state.raf)
			observer.disconnect()
			target.removeEventListener("pointerdown", onPointerDown)
			target.removeEventListener("click", onClick)
			orbit.removeEventListener("change", invalidate)
			orbit.dispose()
			quacks.close()
			disposeScope(state.built.world.scope, state.built.world.root)
			disposeScope(state.built.scenery.scope, state.built.scenery.root)
			renderer.dispose()
			renderer.forceContextLoss()
		},
	}
}

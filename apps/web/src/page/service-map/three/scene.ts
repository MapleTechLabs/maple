import { type MachineKind, mapPalette } from "../../../components/service-map/three/appearance"
import type { SpatialView } from "../../../components/service-map/three/spatial-layout"
import type { Topology3D } from "../../../components/service-map/three/types"
import * as THREE from "three"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"
import { type CameraCommand, cameraRig, type Size } from "./camera"
import { type DuckClick, duckClicks } from "./critters"
import { type Child, disposeScope, group, makeScope, type Scope, type Vec3 } from "./kit"
import { quacker } from "./quack"
import { selectTool, type Tool, type ToolContext, type ToolPointer } from "./tools"
import { type Layout, layoutOf, makeWorld, sceneryKey, sceneryOf, type World } from "./world"
import { Array as Arr, Option, Order } from "effect"

// The 3D service map: an orthographic, flat renderer (dpr 1 to 2, antialias, alpha), its demand
// or always frame loop, the camera rig and machine picking. The lazy scene chunk's entry; the view owns all DOM.

export interface SceneInput {
	readonly topology: Topology3D
	readonly selectedId: string | null
	readonly view: SpatialView
	readonly flowing: boolean
	readonly dark: boolean
	readonly command: CameraCommand
	/** Customized building types by node id. */
	readonly buildings?: ReadonlyMap<string, MachineKind>
	/** A precomputed (customized) layout; derived from topology and view when absent. */
	readonly layout?: Layout
}

export interface SceneHandle {
	readonly update: (input: SceneInput) => void
	readonly stop: () => void
	/** Swaps the pointer tool; the select tool is active from the start. */
	readonly setTool: (tool: Tool) => void
	/** Moves a built machine without a rebuild; `null` restores its layout position. */
	readonly previewMachine: (id: string, position: Vec3 | null) => void
}

interface Built {
	readonly input: SceneInput
	readonly layout: Layout
	readonly sceneryKey: string
	readonly scenery: { readonly scope: Scope; readonly root: THREE.Group }
}

/** A 60 Hz display draws every other frame. Under half the motion's 50 ms step cap, so a skipped
 * frame never costs cargo any distance at any refresh rate. */
const AMBIENT_FRAME_MS = 24

const isGroup = (child: Child): child is THREE.Group => child instanceof THREE.Group
const asGroup = (child: Child): THREE.Group => (isGroup(child) ? child : group({}, [child]))

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

const aim = (camera: THREE.Camera, event: ToolPointer, size: Size): THREE.Raycaster => {
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
	machines: THREE.Object3D,
	event: ToolPointer,
	size: Size,
): ReadonlyArray<string> => {
	const raycaster = aim(camera, event, size)
	return Arr.map(
		Arr.sort(
			Arr.flatMap(
				Arr.filter(machines.children, (node) => typeof node.userData.pickId === "string"),
				(machine: THREE.Object3D) =>
					Arr.map(raycaster.intersectObject(machine, true), (hit) => ({
						id: String(machine.userData.pickId),
						hit,
					})),
			),
			Order.mapInput(Order.Number, (entry: { readonly hit: THREE.Intersection }) => entry.hit.distance),
		),
		({ id }) => id,
	)
}

/** The `duckClicks` entry of the duck hit box under the pointer, if any. Only the boxes are
 * tested: the ink outlines would pick with three's 1-unit line threshold. */
const pickDuck = (
	camera: THREE.Camera,
	scenery: THREE.Object3D,
	event: ToolPointer,
	size: Size,
): (() => DuckClick) | null => {
	const ducks: Array<THREE.Object3D> = []
	scenery.traverse((node) => {
		if (duckClicks.has(node)) ducks.push(node)
	})
	const raycaster = aim(camera, event, size)
	return Option.match(
		Arr.findFirst(ducks, (duck) => raycaster.intersectObject(duck, false).length > 0),
		{ onNone: () => null, onSome: (hit) => duckClicks.get(hit) ?? null },
	)
}

/** A ground plane at y = 0, for placement tools. */
const GROUND = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)

/** Keeps or rebuilds the scenery under `holder`, then reconciles the world for `input`. */
const build = (
	holder: THREE.Group,
	world: World,
	input: SceneInput,
	previous: Built | null,
	flowing: () => boolean,
): Built => {
	const layout =
		input.layout ??
		(previous !== null &&
		previous.input.layout === undefined &&
		previous.input.topology === input.topology &&
		previous.input.view === input.view
			? previous.layout
			: layoutOf(input.topology, input.view))
	const worldInput = {
		topology: input.topology,
		layout,
		view: input.view,
		selectedId: input.selectedId,
		palette: mapPalette(input.dark),
		flowing,
		buildings: input.buildings,
	}
	const key = sceneryKey(worldInput)
	const keep = previous !== null && previous.sceneryKey === key
	if (previous !== null && !keep) {
		holder.remove(previous.scenery.root)
		disposeScope(previous.scenery.scope, previous.scenery.root)
	}
	const sceneryScope = keep && previous !== null ? previous.scenery.scope : makeScope()
	const scenery =
		keep && previous !== null
			? previous.scenery
			: { scope: sceneryScope, root: asGroup(sceneryOf(sceneryScope, worldInput)) }
	if (!keep) holder.add(scenery.root)
	world.sync(worldInput)
	return { input, layout, sceneryKey: key, scenery }
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
	// Scenery draws before the world; fixed holders keep that order across rebuilds.
	const sceneryHolder = new THREE.Group()
	const world = makeWorld()
	scene.add(sceneryHolder, world.root)
	const live = { input: initial }
	const flowing = () => live.input.flowing
	const state = {
		size: measure(container),
		pending: 0,
		/** Draw every frame until this time (ms), whatever the demand count. */
		awakeUntil: 0,
		raf: 0,
		last: performance.now(),
		tool: selectTool(),
		built: build(sceneryHolder, world, initial, null, flowing),
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
		const idle = state.pending === 0 && now > state.awakeUntil
		if (!flowing() && idle) return
		// Ambient traffic alone runs at 30 to 40 fps; camera moves and clicks draw every frame.
		if (idle && now - state.last < AMBIENT_FRAME_MS) return
		state.pending = Math.max(0, state.pending - 1)
		const delta = (now - state.last) / 1000
		state.last = now
		rig()
		Arr.forEach(state.built.scenery.scope.frames, (frame) => frame(delta))
		world.frame(delta)
		renderer.render(scene, camera)
	}
	state.raf = requestAnimationFrame(loop)
	invalidate()
	const observer = new ResizeObserver(resize)
	observer.observe(container)
	const quacks = quacker()
	const previewMachine = (id: string, position: Vec3 | null) => {
		world.previewMachine(id, position)
		invalidate()
	}
	const context: ToolContext = {
		camera,
		size: () => state.size,
		pickMachines: (event) => pick(camera, world.machines, event, state.size),
		pickDuck: (event) => pickDuck(camera, state.built.scenery.root, event, state.size),
		pickGround: (event) => aim(camera, event, state.size).ray.intersectPlane(GROUND, new THREE.Vector3()),
		selectedId: () => live.input.selectedId,
		select: onSelect,
		quack: (count) => quacks.quack(count),
		wake: (ms) => {
			state.awakeUntil = performance.now() + ms
		},
		invalidate,
		previewMachine,
		holdPan: (held) => {
			orbit.enablePan = !held
		},
	}
	const onPointerDown = (event: PointerEvent) => state.tool.pointerDown?.(event, context)
	const onPointerMove = (event: PointerEvent) => state.tool.pointerMove?.(event, context)
	const onPointerUp = (event: PointerEvent) => state.tool.pointerUp?.(event, context)
	const onClick = (event: MouseEvent) => state.tool.click?.(event, context)
	target.addEventListener("pointerdown", onPointerDown)
	target.addEventListener("pointermove", onPointerMove)
	window.addEventListener("pointerup", onPointerUp)
	window.addEventListener("pointercancel", onPointerUp)
	target.addEventListener("click", onClick)
	return {
		update: (input) => {
			const previous = live.input
			live.input = input
			const changed =
				previous.topology !== input.topology ||
				previous.view !== input.view ||
				previous.selectedId !== input.selectedId ||
				previous.dark !== input.dark ||
				previous.buildings !== input.buildings ||
				previous.layout !== input.layout
			if (changed) state.built = build(sceneryHolder, world, input, state.built, flowing)
			// A camera command changes no scene prop, but the zoom still needs frames to land.
			if (
				changed ||
				input.flowing !== previous.flowing ||
				input.command.serial !== previous.command.serial
			)
				invalidate()
		},
		setTool: (tool) => {
			if (tool === state.tool) return
			state.tool.deactivate?.(context)
			orbit.enablePan = true
			state.tool = tool
			canvas.style.cursor = tool.cursor
			invalidate()
		},
		previewMachine,
		stop: () => {
			cancelAnimationFrame(state.raf)
			observer.disconnect()
			target.removeEventListener("pointerdown", onPointerDown)
			target.removeEventListener("pointermove", onPointerMove)
			window.removeEventListener("pointerup", onPointerUp)
			window.removeEventListener("pointercancel", onPointerUp)
			target.removeEventListener("click", onClick)
			orbit.removeEventListener("change", invalidate)
			orbit.dispose()
			quacks.close()
			world.dispose()
			disposeScope(state.built.scenery.scope, state.built.scenery.root)
			renderer.dispose()
			renderer.forceContextLoss()
		},
	}
}

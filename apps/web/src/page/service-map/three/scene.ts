import type { WorldCell, WorldEntity } from "@maple/domain/http"
import { mapPalette } from "../../../components/service-map/three/appearance"
import type { District, SpatialView } from "../../../components/service-map/three/spatial-layout"
import type { Topology3D } from "../../../components/service-map/three/types"
import * as THREE from "three"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"
import { type CameraCommand, cameraRig, type Size } from "./camera"
import { type DuckClick, duckClicks } from "./critters"
import { type Child, disposeScope, group, makeScope, type Scope, type Vec3 } from "./kit"
import { quacker } from "./quack"
import { selectTool, type Tool, type ToolContext, type ToolPointer } from "./tools"
import { moveTool, type Placement } from "./move-tool"
import { canPlace } from "../factory/occupancy"
import { CELL_SIZE, sceneToCell } from "../factory/grid"
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
	/** The team's placed buildings (optimistic while a save is in flight). */
	readonly entities: ReadonlyArray<WorldEntity>
	/** Customize mode: buildings drag on the grid instead of selecting on click. */
	readonly editing: boolean
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
		previous !== null &&
		previous.input.topology === input.topology &&
		previous.input.view === input.view &&
		previous.input.entities === input.entities
			? previous.layout
			: layoutOf(input.topology, input.view, input.entities)
	const worldInput = {
		topology: input.topology,
		layout,
		view: input.view,
		selectedId: input.selectedId,
		palette: mapPalette(input.dark),
		flowing,
		buildings: layout.buildings,
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

/** Cells of grid beyond the outermost district, so a building can be dragged off the island. */
const GRID_MARGIN = 24

/** Customize mode's floor grid: one line per cell over the districts and a margin, faint ink,
 * just above the meadow. Lines fall on cell edges, since a cell's centre is `cell * CELL_SIZE`. */
const editGrid = (ink: string, districts: ReadonlyArray<District>) => {
	const toCell = (value: number) => Math.round(value / CELL_SIZE)
	const minX = Math.min(0, ...Arr.map(districts, (d) => toCell(d.position[0] - d.width / 2)))
	const maxX = Math.max(0, ...Arr.map(districts, (d) => toCell(d.position[0] + d.width / 2)))
	const minZ = Math.min(0, ...Arr.map(districts, (d) => toCell(d.position[2] - d.depth / 2)))
	const maxZ = Math.max(0, ...Arr.map(districts, (d) => toCell(d.position[2] + d.depth / 2)))
	const cells = Math.max(maxX - minX, maxZ - minZ) + GRID_MARGIN * 2
	const grid = new THREE.GridHelper(cells * CELL_SIZE, cells, ink, ink)
	// An even count puts lines through the centre, so shift the centre half a cell onto an edge.
	const half = cells % 2 === 0 ? CELL_SIZE / 2 : 0
	grid.position.set(
		Math.round((minX + maxX) / 2) * CELL_SIZE + half,
		0.02,
		Math.round((minZ + maxZ) / 2) * CELL_SIZE + half,
	)
	Arr.forEach([grid.material].flat(), (material) => {
		material.transparent = true
		material.opacity = 0.12
		material.depthWrite = false
	})
	return grid
}

const gridKeyOf = (dark: boolean, districts: ReadonlyArray<District>) =>
	`${dark}:${Arr.join(
		Arr.map(districts, (d) => `${d.position[0]},${d.position[2]},${d.width},${d.depth}`),
		";",
	)}`

const measure = (element: Element): Size => {
	const { width, height } = element.getBoundingClientRect()
	return { width, height }
}

/**
 * Starts the scene on `canvas` (inside R3F's two wrapper divs, under `[data-scene-root]`, which
 * holds the labels). `onSelect` gets a machine click, or `null` for a miss.
 */
export interface SceneEvents {
	/** A machine click, or `null` for a miss. */
	readonly onSelect: (id: string | null) => void
	/** Customize mode dropped a building on a new, free cell. */
	readonly onMove: (id: string, cell: WorldCell) => void
}

export function startScene(
	canvas: HTMLCanvasElement,
	initial: SceneInput,
	{ onSelect, onMove }: SceneEvents,
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
		() => ({ ...live.input, layout: state.built.layout, previews: world.previews() }),
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
	const previewed = new Set<string>()
	const previewMachine = (id: string, position: Vec3 | null) => {
		if (position === null) previewed.delete(id)
		else previewed.add(id)
		world.previewMachine(id, position)
		invalidate()
	}
	const placement = (): Placement => {
		const { layout, occupancy } = state.built.layout
		return {
			canPlace: (id, cell) => occupancy !== null && canPlace(occupancy, id, cell),
			cellOf: (id) => {
				const position = layout.positions.get(id)
				return position === undefined ? null : sceneToCell(position)
			},
			onMove,
		}
	}
	const tools = { select: state.tool, move: moveTool(placement) }
	const floor = {
		grid: editGrid(mapPalette(initial.dark).ink, state.built.layout.layout.districts),
		key: gridKeyOf(initial.dark, state.built.layout.layout.districts),
	}
	const disposeGrid = () => {
		scene.remove(floor.grid)
		floor.grid.geometry.dispose()
		Arr.forEach([floor.grid.material].flat(), (material) => material.dispose())
	}
	const toolFor = (input: SceneInput) =>
		input.editing && input.view === "atlas" ? tools.move : tools.select
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
	const onPointerCancel = () => state.tool.pointerCancel?.(context)
	const onClick = (event: MouseEvent) => state.tool.click?.(event, context)
	target.addEventListener("pointerdown", onPointerDown)
	target.addEventListener("pointermove", onPointerMove)
	window.addEventListener("pointerup", onPointerUp)
	window.addEventListener("pointercancel", onPointerCancel)
	target.addEventListener("click", onClick)
	const handle: SceneHandle = {
		update: (input) => {
			const previous = live.input
			live.input = input
			const changed =
				previous.topology !== input.topology ||
				previous.view !== input.view ||
				previous.selectedId !== input.selectedId ||
				previous.dark !== input.dark ||
				previous.entities !== input.entities
			if (changed) state.built = build(sceneryHolder, world, input, state.built, flowing)
			// A placed building rebuilds at its cell: the drag's preview has done its job.
			if (previous.entities !== input.entities)
				Arr.forEach([...previewed], (id) => previewMachine(id, null))
			handle.setTool(toolFor(input))
			const districts = state.built.layout.layout.districts
			const gridKey = gridKeyOf(input.dark, districts)
			if (gridKey !== floor.key) {
				disposeGrid()
				floor.grid = editGrid(mapPalette(input.dark).ink, districts)
				floor.key = gridKey
				scene.add(floor.grid)
			}
			floor.grid.visible = input.editing && input.view === "atlas"
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
			window.removeEventListener("pointercancel", onPointerCancel)
			target.removeEventListener("click", onClick)
			orbit.removeEventListener("change", invalidate)
			orbit.dispose()
			quacks.close()
			world.dispose()
			disposeScope(state.built.scenery.scope, state.built.scenery.root)
			disposeGrid()
			renderer.dispose()
			renderer.forceContextLoss()
		},
	}
	scene.add(floor.grid)
	floor.grid.visible = initial.editing && initial.view === "atlas"
	handle.setTool(toolFor(initial))
	return handle
}

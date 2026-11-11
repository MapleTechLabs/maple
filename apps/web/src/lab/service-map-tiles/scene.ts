import { encodeJson } from "@maple/views/data/request-key"
import { Array as Arr, Option, Order, Record as Rec } from "effect"
import * as THREE from "three"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"
import { health, HEALTH_COLOR } from "../../page/service-map/three/spatial-layout"
import { quacker } from "../../page/service-map/three/quack"
import { biomeOf } from "./biome"
import type { Link } from "./board"
import { makeSky } from "./birds"
import { daylightAt } from "./daylight"
import { AWAY, FLIGHT, makeFlock } from "./ducks"
import { makeFlourishes } from "./flourish"
import {
	type Cell,
	cellKey,
	cellToPoint,
	corners,
	HEX_SIZE,
	hexDistance,
	NEIGHBOUR_DISTANCE,
	type Point,
	pointToCell,
	sameCell,
} from "./hex"
import { buildLake } from "./lake"
import { type TilePalette, tilePalette } from "./palette"
import { band, creases, fuse, type Vec3 } from "./solid"
import { makeSounds } from "./sounds"
import { buildTile, landmarkAt, type Tile, TILE_DEPTH, tileOutline } from "./tile"
import { railNetwork } from "./rails"
import { buildPoints, buildRoad, buildStation, buildTrack, RAIL_TOP } from "./tracks"
import { makeTraffic, type Route, type Traffic } from "./traffic"
import {
	arrowOf,
	derive,
	isTyping,
	keyedTarget,
	type SceneEvents,
	type SceneHandle,
	type SceneInput,
} from "./world"
import { buildWild, type Feature, featureOf } from "./wild"

// The landscape scene: one hex tile of land per service, a road where two tiles touch and a
// railway along the tile borders where they do not. The lazy scene chunk's entry; the view owns
// all DOM, and the scene only moves the `[data-tile-label]` elements under `[data-tiles-root]`.

const LABEL_ATTRIBUTE = "data-tile-label"
/** How many lamps and lighthouse beams the map has to hand out. */
const LAMPS = 28
const BEACONS = 2
const BEACON_POWER = 60
const DRAG_TOLERANCE = 5
/** Ambient traffic draws at about 40 fps; camera moves and a held tile draw every frame. */
const AMBIENT_FRAME_MS = 24
/** How high a held tile floats over the board. */
const HELD_LIFT = 1.7
const INRADIUS = NEIGHBOUR_DISTANCE / 2

interface Size {
	readonly width: number
	readonly height: number
}

// A guard keeps the default generics; a bare `instanceof` narrows to `Mesh<any, any>`.
const isDrawn = (object: THREE.Object3D): object is THREE.Mesh | THREE.Line =>
	object instanceof THREE.Mesh || object instanceof THREE.Line

/** Frees the geometry under `root` and empties it. Materials are shared and outlive it. */
const freeAll = (root: THREE.Object3D): void => {
	root.traverse((object) => {
		if (isDrawn(object)) object.geometry.dispose()
	})
	root.clear()
}

type Materials = {
	readonly land: THREE.MeshLambertMaterial
	readonly landDim: THREE.MeshLambertMaterial
	readonly ink: THREE.LineBasicMaterial
	readonly inkDim: THREE.LineBasicMaterial
	readonly flat: THREE.MeshBasicMaterial
	readonly slot: THREE.MeshBasicMaterial
	readonly slotEdge: THREE.LineBasicMaterial
	readonly slotHover: THREE.MeshBasicMaterial
	readonly faint: THREE.MeshBasicMaterial
	/** Every window pane on the map: dark by day, lit at night. */
	readonly glass: THREE.MeshBasicMaterial
}

const makeMaterials = (): Materials => ({
	glass: new THREE.MeshBasicMaterial(),
	land: new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
	landDim: new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
	ink: new THREE.LineBasicMaterial({ transparent: true, opacity: 0.72 }),
	inkDim: new THREE.LineBasicMaterial({ transparent: true, opacity: 0.25 }),
	flat: new THREE.MeshBasicMaterial({
		vertexColors: true,
		transparent: true,
		opacity: 0.92,
		depthWrite: false,
	}),
	slot: new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.55, depthWrite: false }),
	slotEdge: new THREE.LineBasicMaterial({ transparent: true, opacity: 0.8 }),
	slotHover: new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.55, depthWrite: false }),
	faint: new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.7, depthWrite: false }),
})

const paint = (materials: Materials, palette: TilePalette): void => {
	materials.landDim.color.set(palette.dim)
	materials.ink.color.set(palette.ink)
	materials.inkDim.color.set(palette.ink)
	materials.slot.color.set(palette.slot)
	materials.slotEdge.color.set(palette.slotEdge)
	materials.slotHover.color.set(palette.slotHover)
	materials.faint.color.set(palette.slotEdge)
}

interface TileView {
	readonly key: string
	readonly tile: Tile
	readonly group: THREE.Group
	readonly mesh: THREE.Mesh
	readonly lines: THREE.LineSegments
	readonly sails: THREE.Mesh | null
	readonly ring: { key: string; mesh: THREE.Mesh | null }
}

/** Which tile a mesh under the pointer belongs to. */
const tileIds = new WeakMap<THREE.Object3D, string>()

const makeTile = (tile: Tile, id: string, key: string, materials: Materials): TileView => {
	const mesh = new THREE.Mesh(tile.geometry, materials.land)
	mesh.castShadow = true
	mesh.receiveShadow = true
	tileIds.set(mesh, id)
	const lines = new THREE.LineSegments(tile.ink, materials.ink)
	const group = new THREE.Group()
	group.add(mesh, lines)
	if (tile.glass !== null) group.add(new THREE.Mesh(tile.glass, materials.glass))
	if (tile.sails === null)
		return { key, tile, group, mesh, lines, sails: null, ring: { key: "", mesh: null } }
	const mount = new THREE.Group()
	mount.position.set(...tile.sails.hub)
	mount.rotation.y = tile.sails.turn
	const sails = new THREE.Mesh(tile.sails.geometry, materials.land)
	sails.castShadow = true
	mount.add(sails)
	group.add(mount)
	return { key, tile, group, mesh, lines, sails, ring: { key: "", mesh: null } }
}

const hexPlate = (): THREE.BufferGeometry =>
	new THREE.CylinderGeometry(HEX_SIZE * 0.95, HEX_SIZE * 0.95, 0.05, 6)

const measure = (element: Element): Size => {
	const { width, height } = element.getBoundingClientRect()
	return { width: Math.max(1, width), height: Math.max(1, height) }
}

/** A flat strip from `from` to `to`, `width` wide: a held tile's would-be roads and railways. */
const strip = (from: Point, to: Point, y: number, width: number, material: THREE.Material): THREE.Mesh => {
	const length = Math.hypot(to[0] - from[0], to[1] - from[1])
	const mesh = new THREE.Mesh(new THREE.BoxGeometry(length, 0.05, width), material)
	mesh.position.set((from[0] + to[0]) / 2, y, (from[1] + to[1]) / 2)
	mesh.rotation.y = -Math.atan2(to[1] - from[1], to[0] - from[0])
	return mesh
}

/** The ink round the land: the top and bottom edge of every tile side with no tile beyond it. */
const coastOf = (cells: ReadonlyArray<Cell>): THREE.BufferGeometry => {
	const down = new Set(Arr.map(cells, cellKey))
	const points = Arr.flatMap(cells, (cell) => {
		const [x, z] = cellToPoint(cell)
		const ring = corners(cell)
		return Arr.flatMap(ring, (from, index) => {
			const to = ring[(index + 1) % ring.length]
			if (to === undefined) return []
			const middle: Point = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2]
			const beyond = pointToCell([x + (middle[0] - x) * 2, z + (middle[1] - z) * 2])
			if (down.has(cellKey(beyond))) return []
			const foot = (point: Point): Point => [x + (point[0] - x) * 0.97, z + (point[1] - z) * 0.97]
			const [a, b] = [foot(from), foot(to)]
			return [
				...[from[0], 0, from[1], to[0], 0, to[1]],
				...[a[0], -TILE_DEPTH, a[1], b[0], -TILE_DEPTH, b[1]],
				...[from[0], 0, from[1], a[0], -TILE_DEPTH, a[1]],
				...[to[0], 0, to[1], b[0], -TILE_DEPTH, b[1]],
			]
		})
	})
	const geometry = new THREE.BufferGeometry()
	geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3))
	return geometry
}

/** Starts the scene on `canvas`; it sizes to the canvas's parent and listens on that element. */
export function startScene(canvas: HTMLCanvasElement, initial: SceneInput, events: SceneEvents): SceneHandle {
	const container = canvas.parentElement ?? canvas
	const labelsRoot = canvas.closest("[data-tiles-root]") ?? container
	const renderer = new THREE.WebGLRenderer({
		canvas,
		antialias: true,
		alpha: true,
		powerPreference: "high-performance",
	})
	renderer.outputColorSpace = THREE.SRGBColorSpace
	renderer.toneMapping = THREE.NoToneMapping
	renderer.shadowMap.enabled = true
	renderer.shadowMap.type = THREE.PCFShadowMap
	const camera = new THREE.PerspectiveCamera(30, 1, 1, 2000)
	const scene = new THREE.Scene()
	const sky = new THREE.HemisphereLight()
	const sun = new THREE.DirectionalLight()
	sun.castShadow = true
	sun.shadow.mapSize.set(2048, 2048)
	scene.add(sky, sun, sun.target)
	const layers = {
		tiles: new THREE.Group(),
		lakes: new THREE.Group(),
		wilds: new THREE.Group(),
		traffic: new THREE.Group(),
		network: new THREE.Group(),
		slots: new THREE.Group(),
		prospect: new THREE.Group(),
	}
	scene.add(
		layers.tiles,
		layers.lakes,
		layers.wilds,
		layers.network,
		layers.traffic,
		layers.slots,
		layers.prospect,
	)
	const materials = makeMaterials()
	const hover = new THREE.Mesh(hexPlate(), materials.slotHover)
	hover.visible = false
	hover.renderOrder = 6
	scene.add(hover)
	const tiles = new Map<string, TileView>()
	const flock = makeFlock(tilePalette(initial.dark), materials.land)
	const birds = makeSky()
	const flourishes = makeFlourishes()
	// The outline of the tile under the pointer: it says the tile can be clicked.
	const outline = new THREE.Mesh(
		band(tileOutline, 0.045, 0.9, 0.985, tilePalette(initial.dark).snow),
		materials.slot,
	)
	outline.visible = false
	outline.renderOrder = 4
	scene.add(flock.root, birds.root, flourishes.root, outline)
	const quacks = quacker()
	const sounds = makeSounds(() => state.derived.input.muted)
	/** The open country's built tiles by key, and what each one's mesh is. */
	const wildTiles = new Map<
		string,
		{
			readonly mesh: THREE.Mesh
			readonly lines: THREE.LineSegments
			readonly glass: THREE.Mesh | null
			readonly cell: string
		}
	>()
	const wildFeatures = new WeakMap<THREE.Object3D, Feature>()
	/** Timers that wake a paused map for something due later; cleared with the scene. */
	const wakes = new Set<number>()
	/** Windmills spun by a click, and until when (seconds). */
	const spun = new Map<string, number>()
	const state = {
		derived: derive(initial, null),
		size: measure(container),
		pending: 0,
		raf: 0,
		last: performance.now(),
		lightKey: "",
		/** The hour the light is drawn for, and the hour it is turning towards. */
		shownHour: initial.clock.hour,
		targetHour: initial.clock.hour,
		networkKey: "",
		trafficKey: "",
		lakesKey: "",
		wildsKey: "",
		slotsKey: "",
		traffic: null as Traffic | null,
		/** Where the held tile is heading: a target cell, or the bare point under the pointer. */
		hoverCell: null as Cell | null,
		heldPoint: null as Point | null,
		userMoved: false,
		fitKey: "",
		lastCommand: initial.command.serial,
		pressed: { x: 0, y: 0 },
	}
	const invalidate = () => {
		state.pending = Math.min(60, state.pending + 2)
	}
	const orbit = new OrbitControls(camera, canvas)
	orbit.enableDamping = true
	orbit.dampingFactor = 0.12
	orbit.screenSpacePanning = false
	orbit.zoomToCursor = true
	orbit.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE }
	orbit.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE }
	orbit.minPolarAngle = 0.3
	orbit.maxPolarAngle = 1.25
	orbit.addEventListener("change", invalidate)
	// A click also starts and ends a gesture: only one that moved the camera takes the view.
	const gesture = { active: false }
	orbit.addEventListener("start", () => {
		gesture.active = true
	})
	orbit.addEventListener("end", () => {
		gesture.active = false
	})
	orbit.addEventListener("change", () => {
		if (gesture.active) state.userMoved = true
	})

	const pointOf = (id: string): Point | null => {
		const cell = state.derived.cells.get(id)
		return cell === undefined ? null : cellToPoint(cell)
	}

	// A fixed number of lamps, handed to the tiles that need them: adding or removing a light
	// makes three rebuild every shader, so the count never changes while the map is up.
	const parked = new THREE.Group()
	scene.add(parked)
	const lamps = Arr.makeBy(LAMPS, () => {
		const light = new THREE.PointLight(tilePalette(initial.dark).lamp, 0, 4, 1.6)
		parked.add(light)
		return { light, power: 0 }
	})
	const beacons = Arr.makeBy(BEACONS, () => {
		const light = new THREE.SpotLight(tilePalette(initial.dark).lamp, 0, 16, 0.3, 0.7, 1.1)
		parked.add(light, light.target)
		return { light, isLit: false, turn: 0 }
	})
	/** Hands the lamps to the tiles on the board, the biggest villages first, and the beams to
	 * the lighthouses. A lamp hangs in its tile's own group, so it moves with a tile in hand. */
	const hangLamps = () => {
		const wanting = Arr.sort(
			Arr.flatMap([...tiles.values()], (view) =>
				view.tile.lamp === null ? [] : [{ view, lamp: view.tile.lamp }],
			),
			Order.flip(
				Order.mapInput(
					Order.Number,
					(entry: { readonly lamp: { readonly power: number } }) => entry.lamp.power,
				),
			),
		)
		Arr.forEach(lamps, (lamp, index) => {
			const wanted = wanting[index]
			if (wanted === undefined) {
				parked.add(lamp.light)
				lamp.power = 0
				return
			}
			wanted.view.group.add(lamp.light)
			lamp.light.position.set(...wanted.lamp.at)
			lamp.light.distance = wanted.lamp.reach
			lamp.power = wanted.lamp.power
		})
		const towers = Arr.flatMap([...tiles.values()], (view) =>
			view.tile.beacon === null ? [] : [{ view, at: view.tile.beacon }],
		)
		Arr.forEach(beacons, (beacon, index) => {
			const tower = towers[index]
			beacon.isLit = tower !== undefined
			if (tower === undefined) {
				parked.add(beacon.light, beacon.light.target)
				return
			}
			tower.view.group.add(beacon.light, beacon.light.target)
			beacon.light.position.set(...tower.at)
		})
	}
	/** Turns each lighthouse's beam: its target circles the tower, a little below the lantern. */
	const turnBeacons = (delta: number): boolean => {
		const lit = Arr.filter(beacons, (beacon) => beacon.isLit && beacon.light.intensity > 0)
		Arr.forEach(lit, (beacon) => {
			beacon.turn += delta * 0.7
			const { x, y, z } = beacon.light.position
			beacon.light.target.position.set(
				x + Math.cos(beacon.turn) * 6,
				y - 1.5,
				z + Math.sin(beacon.turn) * 6,
			)
		})
		return lit.length > 0
	}
	const glassTones = { day: new THREE.Color(), lit: new THREE.Color() }
	/** Lights the map for the hour now showing: the sun or the moon, the sky's fill, the windows. */
	const applyLight = () => {
		const { palette, radius, centre, input } = state.derived
		const light = daylightAt({ ...input.clock, hour: state.shownHour })
		sky.color.setRGB(...light.sky, THREE.SRGBColorSpace)
		sky.groundColor.setRGB(...light.bounce, THREE.SRGBColorSpace)
		sky.intensity = light.skyPower
		sun.color.setRGB(...light.sun, THREE.SRGBColorSpace)
		sun.intensity = light.sunPower
		sun.target.position.set(centre[0], 0, centre[1])
		const [x, y, z] = light.direction
		const far = radius * 1.6
		sun.position.set(centre[0] + x * far, y * far, centre[1] + z * far)
		// The lamps come on as the sun goes down. They are real lights: they fall off with
		// distance and light whatever stands near them.
		Arr.forEach(lamps, (lamp) => {
			lamp.light.intensity = lamp.power * light.lamps
		})
		Arr.forEach(beacons, (beacon) => {
			beacon.light.intensity = beacon.isLit ? BEACON_POWER * light.lamps : 0
		})
		materials.glass.color.lerpColors(
			glassTones.day.set(palette.glass),
			glassTones.lit.set(palette.lamp),
			light.lamps,
		)
	}

	/** The shadow's reach follows the board; the light itself follows the clock. */
	const syncLight = () => {
		const { radius, centre, input } = state.derived
		const key = `${centre[0].toFixed(2)}:${centre[1].toFixed(2)}:${radius}`
		if (key !== state.lightKey) {
			state.lightKey = key
			const shadow = sun.shadow.camera
			shadow.left = -radius * 1.1
			shadow.right = radius * 1.1
			shadow.top = radius * 1.1
			shadow.bottom = -radius * 1.1
			shadow.near = radius * 0.2
			shadow.far = radius * 3.4
			shadow.updateProjectionMatrix()
		}
		state.targetHour = input.clock.hour
		applyLight()
	}

	/** Turns the shown hour towards the wanted one, the short way round the clock, so stepping
	 * from one time of day to another sweeps the sun across instead of jumping. */
	const turnClock = (delta: number): boolean => {
		const apart = ((((state.targetHour - state.shownHour) % 24) + 36) % 24) - 12
		if (Math.abs(apart) < 1e-3) return false
		// A minute's tick lands at once; a jump of hours takes about a second.
		const step = Math.min(Math.abs(apart), delta * Math.max(8, Math.abs(apart) * 3))
		state.shownHour = (((state.shownHour + Math.sign(apart) * step) % 24) + 24) % 24
		applyLight()
		return true
	}

	const ringOf = (view: TileView, id: string) => {
		const { input, nodes, palette } = state.derived
		const node = nodes.get(id)
		const level = node === undefined ? "healthy" : health(node.errorRate)
		const selected = input.selectedId === id
		const color = selected ? palette.selected : level === "healthy" ? null : HEALTH_COLOR[level]
		const key = `${color}:${selected}`
		if (key === view.ring.key) return
		view.ring.key = key
		if (view.ring.mesh !== null) {
			view.group.remove(view.ring.mesh)
			view.ring.mesh.geometry.dispose()
			view.ring.mesh = null
		}
		if (color === null) return
		const mesh = new THREE.Mesh(
			band(tileOutline, 0.03, selected ? 0.88 : 0.94, 0.985, color),
			materials.flat,
		)
		mesh.renderOrder = 4
		view.ring.mesh = mesh
		view.group.add(mesh)
	}

	const syncTiles = () => {
		const { input, nodes, sizes, cells, related, palette, network, targets, biomes } = state.derived
		const wanted = new Set([...cells.keys(), ...(input.heldId === null ? [] : [input.heldId])])
		Arr.forEach([...tiles], ([id, view]) => {
			if (wanted.has(id) && nodes.has(id)) return
			layers.tiles.remove(view.group)
			freeAll(view.group)
			tiles.delete(id)
		})
		Arr.forEach([...wanted], (id) => {
			const node = nodes.get(id)
			if (node === undefined) return
			const size = sizes.get(id) ?? 0.5
			const corridors = network.corridors.get(id) ?? []
			const biome = biomeOf(biomes, node.namespace)
			const key = `${node.kind}:${biome.id}:${size.toFixed(3)}:${palette.night}:${Arr.join(
				Arr.map(corridors, (angle) => angle.toFixed(2)),
				",",
			)}`
			const held = input.heldId === id
			const existing = tiles.get(id)
			// A tile is rebuilt in place when its roads change: its houses step out of their way.
			const view =
				existing !== undefined && existing.key === key
					? existing
					: makeTile(
							buildTile({ id, kind: node.kind, size, biome, palette, corridors }),
							id,
							key,
							materials,
						)
			if (view !== existing) {
				const start =
					existing?.group.position.toArray() ??
					Option.getOrUndefined(
						Option.map(
							Option.orElse(Option.fromNullishOr(pointOf(id)), () =>
								Option.map(Arr.head(targets?.free ?? []), cellToPoint),
							),
							([x, z]): Vec3 => [x, held ? HELD_LIFT : 0, z],
						),
					)
				if (existing !== undefined) {
					layers.tiles.remove(existing.group)
					freeAll(existing.group)
				}
				if (start !== undefined) view.group.position.set(...start)
				tiles.set(id, view)
				layers.tiles.add(view.group)
			}
			const dimmed = !held && (node.dimmed === true || (related !== null && !related.has(id)))
			view.mesh.material = dimmed ? materials.landDim : materials.land
			view.lines.material = dimmed ? materials.inkDim : materials.ink
			if (view.sails !== null) view.sails.material = view.mesh.material
			const home = pointOf(id)
			if (!held && home !== null) view.group.position.set(home[0], 0, home[1])
			ringOf(view, id)
		})
		hangLamps()
		applyLight()
	}

	/** The lakes, rebuilt when the land moves; the ducks follow the first one. */
	const syncLakes = () => {
		const { lakes, palette } = state.derived
		const first = lakes[0]
		flock.root.visible = first !== undefined
		if (first !== undefined) {
			const [x, z] = cellToPoint(first)
			flock.root.position.set(x, 0.02, z)
		}
		const key = encodeJson([lakes, palette.night])
		if (key === state.lakesKey) return
		state.lakesKey = key
		freeAll(layers.lakes)
		Arr.forEach(lakes, (cell) => {
			const lake = buildLake(cellKey(cell), palette)
			const mesh = new THREE.Mesh(lake.geometry, materials.land)
			mesh.receiveShadow = true
			const [x, z] = cellToPoint(cell)
			mesh.position.set(x, 0, z)
			const lines = new THREE.LineSegments(lake.ink, materials.ink)
			lines.position.copy(mesh.position)
			layers.lakes.add(mesh, lines)
		})
	}

	/** The open country: each cell takes the biome of the service nearest to it. Built tiles are
	 * kept by key, so putting a tile down rebuilds only the cells whose country changed. */
	const syncWilds = () => {
		const { wilds, palette, cells, nodes, biomes, input } = state.derived
		const down = Arr.filter([...cells], ([id]) => id !== input.heldId)
		const specs = Arr.map(wilds, ({ cell, ring }) => {
			const nearest = Arr.head(
				Arr.sort(
					down,
					Order.combine(
						Order.mapInput(Order.Number, ([, at]: readonly [string, Cell]) =>
							hexDistance(at, cell),
						),
						Order.mapInput(Order.String, ([id]: readonly [string, Cell]) => id),
					),
				),
			)
			const namespace = Option.getOrElse(
				Option.map(nearest, ([id]) => nodes.get(id)?.namespace ?? ""),
				() => "",
			)
			const biome = biomeOf(biomes, namespace)
			const feature = featureOf(cellKey(cell), ring, biome)
			return { cell, biome, feature, key: `${cellKey(cell)}:${biome.id}:${feature}:${palette.night}` }
		})
		const key = Arr.join(
			Arr.map(specs, (spec) => spec.key),
			"|",
		)
		// While a tile is in hand, the country on the cells it may go to steps aside for the
		// pale plates that mark them.
		const offered = new Set(Arr.map(state.derived.targets?.free ?? [], cellKey))
		const showOffers = () =>
			wildTiles.forEach((view) => {
				view.mesh.visible = !offered.has(view.cell)
				view.lines.visible = view.mesh.visible
				if (view.glass !== null) view.glass.visible = view.mesh.visible
			})
		if (key === state.wildsKey) return showOffers()
		state.wildsKey = key
		const wanted = new Set(Arr.map(specs, (spec) => spec.key))
		Arr.forEach([...wildTiles], ([built, view]) => {
			if (wanted.has(built)) return
			layers.wilds.remove(view.mesh, view.lines, ...(view.glass === null ? [] : [view.glass]))
			view.mesh.geometry.dispose()
			view.lines.geometry.dispose()
			view.glass?.geometry.dispose()
			wildTiles.delete(built)
		})
		Arr.forEach(specs, (spec) => {
			if (wildTiles.has(spec.key)) return
			const tile = buildWild({
				key: cellKey(spec.cell),
				biome: spec.biome,
				feature: spec.feature,
				palette,
			})
			const mesh = new THREE.Mesh(tile.geometry, materials.land)
			mesh.castShadow = true
			mesh.receiveShadow = true
			const [x, z] = cellToPoint(spec.cell)
			mesh.position.set(x, 0, z)
			const lines = new THREE.LineSegments(tile.ink, materials.ink)
			lines.position.copy(mesh.position)
			wildFeatures.set(mesh, spec.feature)
			const glass = tile.glass === null ? null : new THREE.Mesh(tile.glass, materials.glass)
			glass?.position.copy(mesh.position)
			wildTiles.set(spec.key, { mesh, lines, glass, cell: cellKey(spec.cell) })
			layers.wilds.add(mesh, lines, ...(glass === null ? [] : [glass]))
		})
		showOffers()
	}

	const syncNetwork = () => {
		const { input, links, cells, palette, network, lakes, wilds, nodes, biomes } = state.derived
		/** What a link carries: the produce of the biome its caller lies in. */
		const loadOf = (link: Link) => biomeOf(biomes, nodes.get(link.source)?.namespace ?? "").produce.paint
		const key = encodeJson([
			lakes,
			Arr.map(wilds, (wild) => wild.cell),
			[...cells],
			Arr.map(links, (link) => [link.id, link.callsPerSecond, link.errorRate, link.dimmed]),
			input.selectedId,
			input.heldId,
			palette.night,
		])
		if (key === state.networkKey) return
		state.networkKey = key
		freeAll(layers.network)
		const routes: Array<Route> = []
		const roads = { solid: new Array<THREE.BufferGeometry>(), faded: new Array<THREE.BufferGeometry>() }
		const rails = { solid: new Array<THREE.BufferGeometry>(), faded: new Array<THREE.BufferGeometry>() }
		const isDimmed = (link: Link) =>
			link.dimmed ||
			(input.selectedId !== null &&
				link.source !== input.selectedId &&
				link.target !== input.selectedId)
		Arr.forEach(network.roads, ({ link, from, to }) => {
			const dimmed = isDimmed(link)
			const level = health(link.errorRate)
			const busy = Math.log10(1 + link.callsPerSecond)
			const road = buildRoad(from, to, palette)
			;(dimmed ? roads.faded : roads.solid).push(road.geometry)
			if (link.callsPerSecond > 0)
				routes.push({
					linkId: link.id,
					kind: "cart",
					points: road.track,
					count: Math.min(4, 1 + Math.floor(busy)),
					speed: 0.5 + 0.3 * busy,
					color: level === "healthy" ? palette.cargo : HEALTH_COLOR[level],
					load: loadOf(link),
					running: !dimmed,
				})
		})
		// The railways are one network: shared borders are one track, and routes part at points.
		const rail = railNetwork(
			Arr.map(network.rails, ({ link, points }) => ({ id: link.id, stops: points })),
		)
		const dimmedLinks = new Set(
			Arr.map(
				Arr.filter(network.rails, ({ link }) => isDimmed(link)),
				({ link }) => link.id,
			),
		)
		/** A stretch of track, a set of points or a station fades only when every route over it does. */
		const fadedOut = (users: ReadonlyArray<string>) => Arr.every(users, (id) => dimmedLinks.has(id))
		const furniture = {
			solid: new Array<THREE.BufferGeometry>(),
			faded: new Array<THREE.BufferGeometry>(),
		}
		Arr.forEach(rail.pieces, (piece) =>
			(fadedOut(piece.routes) ? rails.faded : rails.solid).push(buildTrack(piece.line, palette)),
		)
		Arr.forEach(rail.points, (points) =>
			(fadedOut(points.routes) ? furniture.faded : furniture.solid).push(
				...buildPoints(points.at, points.heading, palette),
			),
		)
		Arr.forEach(rail.stations, (station) =>
			(fadedOut(station.routes) ? furniture.faded : furniture.solid).push(
				...buildStation(station.at, station.heading, palette),
			),
		)
		Arr.forEach(network.rails, ({ link }) => {
			const path = rail.paths.get(link.id)
			if (path === undefined || link.callsPerSecond <= 0) return
			const level = health(link.errorRate)
			const busy = Math.log10(1 + link.callsPerSecond)
			routes.push({
				linkId: link.id,
				kind: "train",
				points: Arr.map(path, ([x, z]): Vec3 => [x, RAIL_TOP, z]),
				// A busier link pulls a longer train.
				count: Math.min(3, 1 + Math.floor(busy / 1.5)),
				speed: 0.7 + 0.3 * busy,
				color: level === "healthy" ? palette.engine : HEALTH_COLOR[level],
				load: loadOf(link),
				running: !isDimmed(link),
				blocks: rail.blocks.get(link.id) ?? [],
			})
		})
		Arr.forEach(
			[
				{ parts: roads.solid, land: materials.land, ink: materials.ink, inked: true },
				{ parts: roads.faded, land: materials.landDim, ink: materials.inkDim, inked: true },
				{ parts: rails.solid, land: materials.land, ink: materials.ink, inked: false },
				{ parts: rails.faded, land: materials.landDim, ink: materials.inkDim, inked: false },
				{ parts: furniture.solid, land: materials.land, ink: materials.ink, inked: true },
				{ parts: furniture.faded, land: materials.landDim, ink: materials.inkDim, inked: true },
			],
			({ parts, land, ink, inked }) => {
				if (parts.length === 0) return
				const geometry = fuse(parts)
				const mesh = new THREE.Mesh(geometry, land)
				mesh.receiveShadow = true
				layers.network.add(mesh)
				// Sleepers would turn a railway's ink into a black band: only roads are outlined.
				if (inked) layers.network.add(new THREE.LineSegments(creases(geometry), ink))
			},
		)
		const down = Arr.map(
			Arr.filter([...cells], ([id]) => id !== input.heldId),
			([, cell]) => cell,
		)
		layers.network.add(
			new THREE.LineSegments(
				coastOf([...down, ...lakes, ...Arr.map(wilds, (wild) => wild.cell)]),
				materials.ink,
			),
		)
		// A selection only changes which links run: the carts and trains keep their places.
		// Anything that moves a road or a railway starts the traffic over.
		const trafficKey = encodeJson(Arr.map(routes, ({ running: _, ...route }) => route))
		if (trafficKey === state.trafficKey && state.traffic !== null) {
			const running = new Map(Arr.map(routes, (route) => [route.linkId, route.running] as const))
			state.traffic.setRunning((linkId) => running.get(linkId) === true)
			return
		}
		state.trafficKey = trafficKey
		state.traffic?.dispose()
		layers.traffic.clear()
		const traffic = makeTraffic(routes, palette)
		state.traffic = traffic
		layers.traffic.add(traffic.root)
	}

	const syncSlots = () => {
		const { targets, palette, input } = state.derived
		const key = encodeJson([input.heldId, targets?.free ?? [], palette.night])
		if (key === state.slotsKey) return
		state.slotsKey = key
		freeAll(layers.slots)
		if (targets === null) return
		Arr.forEach(targets.free, (cell) => {
			const [x, z] = cellToPoint(cell)
			const plate = new THREE.Mesh(hexPlate(), materials.slot)
			plate.position.set(x, 0.05, z)
			plate.renderOrder = 5
			const edge = new THREE.LineSegments(
				new THREE.EdgesGeometry(plate.geometry, 40),
				materials.slotEdge,
			)
			edge.position.copy(plate.position)
			layers.slots.add(plate, edge)
		})
	}

	/** The held tile's links from the cell under the pointer: wide strips where a road would run. */
	const syncProspect = () => {
		freeAll(layers.prospect)
		const { input, links, cells } = state.derived
		const cell = state.hoverCell
		hover.visible = cell !== null
		if (cell === null || input.heldId === null) return
		const [x, z] = cellToPoint(cell)
		hover.position.set(x, 0.07, z)
		Arr.forEach(links, (link) => {
			const other =
				link.source === input.heldId ? link.target : link.target === input.heldId ? link.source : null
			const at = other === null ? undefined : cells.get(other)
			if (at === undefined || sameCell(at, cell)) return
			const touching = hexDistance(at, cell) === 1
			const mesh = strip(
				[x, z],
				cellToPoint(at),
				touching ? 0.16 : 0.12,
				touching ? 0.36 : 0.09,
				touching ? materials.slotHover : materials.faint,
			)
			mesh.renderOrder = 7
			layers.prospect.add(mesh)
		})
	}

	const sync = () => {
		paint(materials, state.derived.palette)
		syncLight()
		syncTiles()
		syncLakes()
		syncWilds()
		syncNetwork()
		syncSlots()
		syncProspect()
		invalidate()
	}

	const fit = () => {
		const { radius, centre } = state.derived
		const vertical = THREE.MathUtils.degToRad(camera.fov) / 2
		const horizontal = Math.atan(Math.tan(vertical) * camera.aspect)
		// The board lies flat, so it needs less of the frame's height than its radius.
		const distance = Math.max(
			(radius * 0.78) / Math.sin(vertical),
			(radius * 0.96) / Math.sin(horizontal),
		)
		const polar = 0.9
		const azimuth = 0.55
		orbit.target.set(centre[0], -0.3, centre[1])
		camera.position.set(
			centre[0] + distance * Math.sin(polar) * Math.sin(azimuth),
			distance * Math.cos(polar) - 0.3,
			centre[1] + distance * Math.sin(polar) * Math.cos(azimuth),
		)
		orbit.minDistance = distance * 0.12
		orbit.maxDistance = distance * 1.8
		camera.near = distance * 0.02
		camera.far = distance * 6
		camera.updateProjectionMatrix()
		orbit.update()
	}

	const resize = () => {
		state.size = measure(container)
		const ratio = Math.min(Math.max(1, window.devicePixelRatio), 2)
		renderer.setPixelRatio(ratio)
		renderer.setSize(state.size.width, state.size.height, true)
		camera.aspect = state.size.width / state.size.height
		camera.updateProjectionMatrix()
		invalidate()
	}

	/** Fits on the first frame, on Reset, and on a bigger board or a new canvas size until the user takes the view. */
	const rig = () => {
		const { input, radius, centre } = state.derived
		const key = `${centre[0].toFixed(2)}:${centre[1].toFixed(2)}:${radius}:${state.size.width}:${state.size.height}`
		const command = input.command
		const fresh = command.serial !== state.lastCommand
		state.lastCommand = command.serial
		if (fresh && command.action === "reset") state.userMoved = false
		if (
			(state.fitKey !== key && !state.userMoved) ||
			state.fitKey === "" ||
			(fresh && command.action === "reset")
		)
			fit()
		state.fitKey = key
		if (fresh && command.action !== "reset") {
			state.userMoved = true
			const offset = camera.position.clone().sub(orbit.target)
			const length = THREE.MathUtils.clamp(
				offset.length() * (command.action === "in" ? 0.8 : 1.25),
				orbit.minDistance,
				orbit.maxDistance,
			)
			camera.position.copy(orbit.target).add(offset.setLength(length))
		}
		orbit.update()
		camera.updateMatrixWorld()
	}

	const probe = new THREE.Vector3()
	/** Each label lies on the near side of its tile; a label that would cover one already placed
	 * is hidden, the selected service and the busiest ones first. */
	const placeLabels = () => {
		const { input, nodes, related, cells } = state.derived
		const toCamera = new THREE.Vector2(
			camera.position.x - orbit.target.x,
			camera.position.z - orbit.target.z,
		).normalize()
		const priority = (id: string) =>
			(id === input.selectedId ? 1e9 : 0) +
			(related?.has(id) === true ? 1e6 : 0) +
			(nodes.get(id)?.throughput ?? 0)
		const labels = Arr.sort(
			Arr.flatMap([...labelsRoot.querySelectorAll(`[${LABEL_ATTRIBUTE}]`)], (element) =>
				element instanceof HTMLElement
					? [{ id: element.getAttribute(LABEL_ATTRIBUTE) ?? "", element }]
					: [],
			),
			Order.flip(Order.mapInput(Order.Number, (label: { readonly id: string }) => priority(label.id))),
		)
		const placed: Array<{ x: number; y: number; width: number; height: number }> = []
		Arr.forEach(labels, ({ id, element }) => {
			const cell = cells.get(id)
			if (cell === undefined || !tiles.has(id) || id === input.heldId) {
				element.style.visibility = "hidden"
				return
			}
			const [x, z] = cellToPoint(cell)
			const out = INRADIUS * 0.7
			probe.set(x + toCamera.x * out, 0.05, z + toCamera.y * out).project(camera)
			const width = element.offsetWidth
			const height = element.offsetHeight
			const left = (probe.x * 0.5 + 0.5) * state.size.width
			const top = (-probe.y * 0.5 + 0.5) * state.size.height
			const hidden =
				probe.z < -1 ||
				probe.z > 1 ||
				left < width / 2 ||
				left > state.size.width - width / 2 ||
				top < 0 ||
				top > state.size.height - height ||
				Arr.some(
					placed,
					(other) =>
						Math.abs(other.x - left) < (other.width + width) / 2 + 4 &&
						Math.abs(other.y - top) < (other.height + height) / 2 + 2,
				)
			element.style.transform = `translate3d(${left.toFixed(1)}px,${top.toFixed(1)}px,0) translateX(-50%)`
			element.style.visibility = hidden ? "hidden" : "visible"
			if (!hidden) placed.push({ x: left, y: top, width, height })
		})
	}

	/** The held tile glides to its target cell, or to the point under the pointer. */
	const carryHeld = (delta: number): boolean => {
		const { input } = state.derived
		const view = input.heldId === null ? undefined : tiles.get(input.heldId)
		if (view === undefined) return false
		const target = state.hoverCell !== null ? cellToPoint(state.hoverCell) : state.heldPoint
		const goal = new THREE.Vector3(
			target?.[0] ?? view.group.position.x,
			HELD_LIFT,
			target?.[1] ?? view.group.position.z,
		)
		const before = view.group.position.distanceTo(goal)
		view.group.position.lerp(goal, 1 - Math.exp(-delta * 16))
		return before > 0.01
	}

	const loop = (now: number) => {
		state.raf = requestAnimationFrame(loop)
		const { input } = state.derived
		const idle = state.pending === 0
		if (!input.flowing && idle && input.heldId === null) return
		if (idle && input.heldId === null && now - state.last < AMBIENT_FRAME_MS) return
		const delta = Math.min(0.05, (now - state.last) / 1000)
		state.last = now
		state.pending = Math.max(0, state.pending - 1)
		rig()
		const seconds = now / 1000
		// What a click set off plays out on a paused map too: keep drawing until it all settles.
		const playing = [
			turnClock(delta),
			carryHeld(delta),
			flock.frame(delta, input.flowing),
			birds.frame(delta, input.flowing, state.derived.centre, state.derived.radius),
			flourishes.frame(),
			state.traffic?.frame(delta, input.flowing) ?? false,
			Arr.some([...spun.values()], (until) => until > seconds),
		]
		if (Arr.some(playing, Boolean)) invalidate()
		// A beam sweeping the board is motion like any other: it stops with the traffic.
		if (input.flowing && turnBeacons(delta)) invalidate()
		tiles.forEach((view, id) => {
			const pace = (input.flowing ? 0.9 : 0) + ((spun.get(id) ?? 0) > seconds ? 8 : 0)
			if (view.sails !== null) view.sails.rotation.z += delta * pace
		})
		renderer.render(scene, camera)
		placeLabels()
	}

	const raycaster = new THREE.Raycaster()
	const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
	const aim = (event: MouseEvent) => {
		const bounds = canvas.getBoundingClientRect()
		raycaster.setFromCamera(
			new THREE.Vector2(
				((event.clientX - bounds.left) / bounds.width) * 2 - 1,
				-((event.clientY - bounds.top) / bounds.height) * 2 + 1,
			),
			camera,
		)
	}
	const pickTile = (event: MouseEvent): string | null => {
		aim(event)
		const hit = Arr.head(
			raycaster.intersectObjects(
				Arr.map([...tiles.values()], (view) => view.mesh),
				false,
			),
		)
		return Option.getOrNull(Option.flatMapNullishOr(hit, ({ object }) => tileIds.get(object)))
	}
	/** The tile under the pointer and the point of it that was hit, in the tile's own frame. */
	const hitTile = (event: MouseEvent): { readonly id: string; readonly at: Vec3 } | null => {
		aim(event)
		const hit = Arr.head(
			raycaster.intersectObjects(
				Arr.map([...tiles.values()], (view) => view.mesh),
				false,
			),
		)
		return Option.getOrNull(
			Option.flatMap(hit, ({ object, point }) => {
				const id = tileIds.get(object)
				const view = id === undefined ? undefined : tiles.get(id)
				if (id === undefined || view === undefined) return Option.none()
				const local = point.clone().sub(view.group.position)
				return Option.some({ id, at: [local.x, local.y, local.z] as const })
			}),
		)
	}
	/** Where the pointer meets a lake's water, if it does. */
	const hitWater = (event: MouseEvent): Point | null => {
		aim(event)
		const hit = Arr.head(raycaster.intersectObjects(layers.lakes.children, false))
		return Option.getOrNull(
			Option.flatMap(hit, ({ object, point }) =>
				Math.hypot(point.x - object.position.x, point.z - object.position.z) < INRADIUS * 0.72
					? Option.some([point.x, point.z] as const)
					: Option.none(),
			),
		)
	}
	/** What a landmark does when it is clicked: a windmill spins, a church rings its bell and
	 * the birds leave the tower, a lighthouse sounds its horn and sweeps its beam. */
	const flourish = (id: string, at: Vec3) => {
		const view = tiles.get(id)
		const landmark = view === undefined ? null : landmarkAt(view.tile, at)
		if (view === undefined || landmark === null) return
		const { x, z } = view.group.position
		const top: Vec3 = [x + landmark.top[0], landmark.top[1], z + landmark.top[2]]
		if (landmark.kind === "queue") spun.set(id, performance.now() / 1000 + 4)
		if (landmark.kind === "service") {
			sounds.bell()
			birds.flush(top)
		}
		if (landmark.kind === "edge") {
			sounds.horn()
			flourishes.beam(top, state.derived.palette.lamp)
		}
	}
	const pickGround = (event: MouseEvent): Point | null => {
		aim(event)
		const point = raycaster.ray.intersectPlane(ground, new THREE.Vector3())
		return point === null ? null : [point.x, point.z]
	}
	const targetAt = (point: Point | null): Cell | null => {
		const { targets, cells, input } = state.derived
		if (point === null || targets === null || input.heldId === null) return null
		const cell = pointToCell(point)
		const home = cells.get(input.heldId)
		const valid =
			(home !== undefined && sameCell(home, cell)) ||
			Arr.some(targets.free, (free) => sameCell(free, cell)) ||
			Arr.some(targets.swaps, (swap) => sameCell(swap, cell))
		return valid ? cell : null
	}
	const setHover = (cell: Cell | null) => {
		const changed =
			(state.hoverCell === null ? "" : cellKey(state.hoverCell)) !==
			(cell === null ? "" : cellKey(cell))
		state.hoverCell = cell
		if (!changed) return
		syncProspect()
		events.onHover(cell)
	}
	const onPointerDown = (event: PointerEvent) => {
		state.pressed = { x: event.clientX, y: event.clientY }
	}
	const onPointerMove = (event: PointerEvent) => {
		const { input } = state.derived
		if (input.heldId === null) {
			aim(event)
			const id = pickTile(event)
			const lively =
				flock.under(raycaster) !== null ||
				birds.under(raycaster) !== null ||
				(!input.building && state.traffic?.under(raycaster.ray) != null) ||
				hitWater(event) !== null
			canvas.style.cursor = lively || id !== null ? "pointer" : ""
			const home = id === null ? null : pointOf(id)
			const shown = home !== null && !lively
			if (shown !== outline.visible || (home !== null && outline.position.x !== home[0])) invalidate()
			outline.visible = shown
			if (home !== null) outline.position.set(home[0], 0, home[1])
			return
		}
		outline.visible = false
		const point = pickGround(event)
		state.heldPoint = point
		setHover(targetAt(point))
		canvas.style.cursor = state.hoverCell === null ? "grabbing" : "copy"
		invalidate()
	}
	const onClick = (event: MouseEvent) => {
		if (Math.hypot(event.clientX - state.pressed.x, event.clientY - state.pressed.y) > DRAG_TOLERANCE)
			return
		const { input } = state.derived
		if (input.heldId !== null) {
			const cell = targetAt(pickGround(event))
			if (cell !== null) events.onPlace(input.heldId, cell)
			return
		}
		aim(event)
		const duck = flock.under(raycaster)
		if (duck !== null) {
			// Two "wak"s for a poke, three when the duck takes fright; one that is away stays silent.
			Option.map(flock.poke(duck), (poke) => {
				if (!input.muted) quacks.quack(poke.alarm ? 3 : 2)
				// A paused map stops drawing once the duck is out of sight: wake it for the glide back.
				if (poke.alarm) wakes.add(window.setTimeout(invalidate, (FLIGHT + AWAY) * 1000))
			})
			invalidate()
			return
		}
		const flight = birds.under(raycaster)
		if (flight !== null) {
			birds.startle(flight)
			sounds.chirp(4)
			invalidate()
			return
		}
		// While rearranging, a click on a tile lifts it, whatever is driving across it.
		const vehicle = input.building ? null : (state.traffic?.under(raycaster.ray) ?? null)
		if (vehicle !== null) {
			state.traffic?.poke(vehicle.index)
			if (vehicle.kind === "train") sounds.whistle()
			else sounds.ding()
			events.onPokeLink(vehicle.linkId)
			invalidate()
			return
		}
		const hit = hitTile(event)
		if (input.building) {
			if (hit !== null) events.onPickUp(hit.id)
			return
		}
		const water = hit === null ? hitWater(event) : null
		if (water !== null) {
			flourishes.ripple(water, state.derived.palette.snow)
			sounds.splash()
			invalidate()
			return
		}
		// A click into a wood sends the birds up out of it.
		const wood =
			hit === null
				? Arr.head(
						raycaster.intersectObjects(
							// A ray does not skip hidden objects.
							Arr.filter(layers.wilds.children, (child) => child.visible),
							false,
						),
					)
				: Option.none()
		Option.map(wood, ({ object, point }) => {
			if (wildFeatures.get(object) !== "forest") return
			birds.flush([point.x, 0.6, point.z])
			sounds.chirp(3)
			invalidate()
		})
		if (hit !== null) flourish(hit.id, hit.at)
		events.onSelect(hit === null || hit.id === input.selectedId ? null : hit.id)
	}
	const onPointerLeave = () => {
		outline.visible = false
		invalidate()
	}
	/** A way across the screen as a way across the board, however the camera is turned. */
	const acrossBoard = ([right, down]: Point): Point => {
		const ahead = camera.getWorldDirection(new THREE.Vector3())
		const side = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion)
		return [right * side.x - down * ahead.x, right * side.z - down * ahead.z]
	}
	// A tile in hand can be placed without a pointer: arrows choose where, Enter puts it down.
	const onKeyDown = (event: KeyboardEvent) => {
		const { input } = state.derived
		if (input.heldId === null) return
		if (event.key === "Escape") return events.onCancel()
		if (isTyping(event)) return
		const arrow = arrowOf(event.key)
		if (arrow !== null) {
			event.preventDefault()
			setHover(keyedTarget(state.derived, state.hoverCell, acrossBoard(arrow)))
			return invalidate()
		}
		if (event.key === "Enter" && state.hoverCell !== null) {
			event.preventDefault()
			events.onPlace(input.heldId, state.hoverCell)
		}
	}
	const onContextMenu = (event: MouseEvent) => event.preventDefault()
	// A wheel over a name plate or a panel still zooms: the controls only hear the canvas.
	const onWheel = (event: Event) => {
		if (event.target === canvas || !(event instanceof WheelEvent)) return
		event.preventDefault()
		canvas.dispatchEvent(new WheelEvent("wheel", event))
	}
	canvas.addEventListener("pointerdown", onPointerDown)
	canvas.addEventListener("pointermove", onPointerMove)
	canvas.addEventListener("click", onClick)
	canvas.addEventListener("pointerleave", onPointerLeave)
	canvas.addEventListener("contextmenu", onContextMenu)
	window.addEventListener("keydown", onKeyDown)
	labelsRoot.addEventListener("wheel", onWheel, { passive: false })
	const observer = new ResizeObserver(resize)
	observer.observe(container)
	resize()
	sync()
	state.raf = requestAnimationFrame(loop)

	return {
		update: (input) => {
			const previous = state.derived
			state.derived = derive(input, previous)
			// A tile coming down sends the birds up from where it lands.
			const landed =
				previous.input.heldId === null ? undefined : state.derived.cells.get(previous.input.heldId)
			const before =
				previous.input.heldId === null ? undefined : previous.cells.get(previous.input.heldId)
			if (landed !== undefined && (before === undefined || !sameCell(before, landed))) {
				const [x, z] = cellToPoint(landed)
				birds.flush([x, 0.5, z])
			}
			if (input.heldId !== null) outline.visible = false
			if (previous.input.heldId !== input.heldId || previous.input.cells !== input.cells) {
				state.hoverCell = null
				state.heldPoint = null
				hover.visible = false
			}
			sync()
		},
		stop: () => {
			cancelAnimationFrame(state.raf)
			wakes.forEach((timer) => window.clearTimeout(timer))
			observer.disconnect()
			canvas.removeEventListener("pointerdown", onPointerDown)
			canvas.removeEventListener("pointermove", onPointerMove)
			canvas.removeEventListener("click", onClick)
			canvas.removeEventListener("pointerleave", onPointerLeave)
			canvas.removeEventListener("contextmenu", onContextMenu)
			window.removeEventListener("keydown", onKeyDown)
			labelsRoot.removeEventListener("wheel", onWheel)
			orbit.dispose()
			state.traffic?.dispose()
			layers.traffic.clear()
			flock.dispose()
			birds.dispose()
			flourishes.dispose()
			quacks.close()
			sounds.close()
			outline.geometry.dispose()
			freeAll(scene)
			hover.geometry.dispose()
			Arr.forEach(Rec.values(materials), (material) => material.dispose())
			renderer.dispose()
			renderer.forceContextLoss()
		},
	}
}

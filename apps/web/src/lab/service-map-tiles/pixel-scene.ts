import { encodeJson } from "@maple/views/data/request-key"
import { Array as Arr, Option, Order, Record as Rec } from "effect"
import * as THREE from "three"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"
import { quacker } from "../../page/service-map/three/quack"
import { health, HEALTH_COLOR } from "../../page/service-map/three/spatial-layout"
import { SPRITES } from "./art/sprites.generated"
import { biomeOf } from "./biome"
import type { Link } from "./board"
import { daylightAt } from "./daylight"
import {
	type Cell,
	cellKey,
	cellToPoint,
	corners,
	HEX_SIZE,
	hexDistance,
	ORIGIN,
	type Point,
	pointToCell,
	sameCell,
} from "./hex"
import { type Bill, type Billboards, GROUND, makeBillboards } from "./pixel-billboards"
import { type Frame, type Land, makePainter, northFirst, type Painter } from "./pixel-ground"
import { DUCK_LOOP, lakeArt, PX, serviceArt, type TileArt, wildArt } from "./pixel-layout"
import { railNetwork } from "./rails"
import {
	isLoaded,
	type Line,
	makeSignalBox,
	makeTrain,
	type SignalBox,
	signalsOf,
	type Train,
	wagonsOf,
} from "./signalling"
import { band, fuse, part, type Vec3 } from "./solid"
import { makeSounds } from "./sounds"
import { featureOf } from "./wild"
import {
	arrowOf,
	derive,
	isOnControl,
	isTyping,
	keyedTarget,
	type SceneEvents,
	type SceneHandle,
	type SceneInput,
} from "./world"

// The pixel-art map in 3D. The ground is painted flat from the sprite sheet and laid over raised
// hex tiles; houses, trees, trains and ducks are sprites standing on it that turn to face the
// camera. The same sun, moon and lamps as the painted look light them, and they cast shadows.

const LABEL_ATTRIBUTE = "data-tile-label"
const DRAG_TOLERANCE = 5
/** Traffic is drawn at about 30 frames a second. */
const FRAME_MS = 32
const SOIL = "#7a5b3c"
const SOIL_SHADE = "#4f3925"
/** How far the tiles' earth goes down, in world units. */
const DEPTH = 1.05
/** How far apart a pixel train's wagons ride, in world units: a wagon sprite's length. */
const COUPLING = 1.3
/** Seconds a startled bird hurries for. */
const BIRD_FRIGHT = 2.5
/** How high the birds fly, and a tile in hand is held, in world units. */
const BIRD_HEIGHT = 4
const HELD_LIFT = 1.7
// A fixed number of lights: adding or removing one makes three rebuild every shader.
const LAMPS = 24
const BEACONS = 2
const BEACON_POWER = 60
const OUTLINE = corners(ORIGIN)
const UP = new THREE.Vector3(0, 1, 0)

interface Size {
	readonly width: number
	readonly height: number
}

/** A sprite that stands still, and the service whose tile it stands on. */
interface Standing extends Bill {
	readonly owner: string | null
}

interface Cart {
	readonly linkId: string
	readonly from: Point
	readonly to: Point
	readonly speed: number
	readonly isAiling: string | null
	running: boolean
	progress: number
}

interface Engine {
	readonly linkId: string
	readonly path: ReadonlyArray<Point>
	readonly train: Train
	readonly isAiling: string | null
	running: boolean
}

/** Something that can be clicked: where its foot is and how tall it stands, in world units. */
interface Hot {
	readonly at: Vec3
	readonly tall: number
	readonly linkId: string
	readonly kind: "cart" | "train"
}

/** A cart or an engine on a failing link: where to hang its health colour. */
interface Ailing {
	readonly at: Vec3
	readonly color: string
}

/** Everything of the scene that needs the sprite sheet, made once it has loaded. */
interface Ready {
	readonly sheet: THREE.Texture
	readonly painter: Painter
	readonly statics: Billboards
	readonly moving: Billboards
}

const measure = (element: Element): Size => {
	const { width, height } = element.getBoundingClientRect()
	return { width: Math.max(1, width), height: Math.max(1, height) }
}

/** Art pixels to the world, `height` world units up; and the ground of the world to art pixels. */
const toWorld = ([x, y]: Point, height = 0): Vec3 => [x / PX, height, y / PX]
const toArt = ([x, z]: Point): Point => [x * PX, z * PX]

/** Where `along` world units down a polyline is, and which way the line runs there. */
const pointAlong = (
	path: ReadonlyArray<Point>,
	along: number,
): { readonly at: Point; readonly way: Point } => {
	const state = { left: Math.max(0, along) }
	for (let index = 0; index < path.length - 1; index++) {
		const [a, b] = [path[index], path[index + 1]]
		if (a === undefined || b === undefined) break
		const length = Math.hypot(b[0] - a[0], b[1] - a[1])
		if (state.left <= length || index === path.length - 2) {
			const t = length === 0 ? 0 : Math.min(1, state.left / length)
			return {
				at: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
				way: [b[0] - a[0], b[1] - a[1]],
			}
		}
		state.left -= length
	}
	return { at: path[0] ?? [0, 0], way: [1, 0] }
}

const lengthOf = (path: ReadonlyArray<Point>): number =>
	Arr.reduce(
		Arr.zip(path, Arr.drop(path, 1)),
		0,
		(sum, [a, b]) => sum + Math.hypot(b[0] - a[0], b[1] - a[1]),
	)

/** A triangle from `a`, wound so that it faces the way `out` points. */
const facing = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, out: THREE.Vector3) => {
	const normal = b.clone().sub(a).cross(c.clone().sub(a))
	return normal.dot(out) >= 0 ? [a, b, c] : [a, c, b]
}

/** The tiles as blocks: their tops, which take the painting, and the earth down their open sides.
 * `centres` are in world units; `isOpen` says whether a tile's side `index` has nothing beyond it. */
const blocksOf = (
	centres: ReadonlyArray<Point>,
	frame: Frame,
	isOpen: (centre: Point, index: number) => boolean,
): { readonly tops: THREE.BufferGeometry; readonly sides: THREE.BufferGeometry } => {
	const tops = { position: new Array<number>(), uv: new Array<number>(), normal: new Array<number>() }
	const sides = { position: new Array<number>(), color: new Array<number>(), normal: new Array<number>() }
	const [soil, shade] = [new THREE.Color(SOIL), new THREE.Color(SOIL_SHADE)]
	Arr.forEach(centres, (centre) => {
		const ring = Arr.map(OUTLINE, ([x, z]): Point => [centre[0] + x, centre[1] + z])
		Arr.forEach(ring, (from, index) => {
			const to = ring[(index + 1) % ring.length] ?? from
			const corner = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
			Arr.forEach(
				facing(
					corner(centre[0], 0, centre[1]),
					corner(from[0], 0, from[1]),
					corner(to[0], 0, to[1]),
					UP,
				),
				(point) => {
					tops.position.push(point.x, 0, point.z)
					tops.normal.push(0, 1, 0)
					tops.uv.push(
						(point.x * PX - frame.origin[0]) / frame.size[0],
						1 - (point.z * PX - frame.origin[1]) / frame.size[1],
					)
				},
			)
			if (!isOpen(centre, index)) return
			const out = corner(
				(from[0] + to[0]) / 2 - centre[0],
				0,
				(from[1] + to[1]) / 2 - centre[1],
			).normalize()
			const [a, b] = [corner(from[0], 0, from[1]), corner(to[0], 0, to[1])]
			const [low, lower] = [corner(from[0], -DEPTH, from[1]), corner(to[0], -DEPTH, to[1])]
			Arr.forEach([...facing(a, b, low, out), ...facing(b, lower, low, out)], (point) => {
				sides.position.push(point.x, point.y, point.z)
				sides.normal.push(out.x, 0, out.z)
				const tone = point.y === 0 ? soil : shade
				sides.color.push(tone.r, tone.g, tone.b)
			})
		})
	})
	const geometry = (attributes: Readonly<Record<string, readonly [ReadonlyArray<number>, number]>>) => {
		const built = new THREE.BufferGeometry()
		Arr.forEach(Rec.toEntries(attributes), ([name, [values, size]]) =>
			built.setAttribute(name, new THREE.Float32BufferAttribute([...values], size)),
		)
		return built
	}
	return {
		tops: geometry({ position: [tops.position, 3], normal: [tops.normal, 3], uv: [tops.uv, 2] }),
		sides: geometry({
			position: [sides.position, 3],
			normal: [sides.normal, 3],
			color: [sides.color, 3],
		}),
	}
}

/** A city's wall as stone blocks round the town, with a gap where a road or a railway leaves. */
const wallOf = (at: Point, radius: number, ways: ReadonlyArray<number>): Array<THREE.BufferGeometry> => {
	const gates = Arr.sort(ways, Order.Number)
	const gate = Math.asin(Math.min(1, 26 / PX / radius))
	const arcs: ReadonlyArray<readonly [number, number]> =
		gates.length === 0
			? [[0, Math.PI * 2]]
			: Arr.map(gates, (way, index) => {
					const next = gates[(index + 1) % gates.length] ?? way
					return [
						way + gate,
						(index === gates.length - 1 ? next + Math.PI * 2 : next) - gate,
					] as const
				})
	return Arr.flatMap(arcs, ([from, to]) => {
		if (to <= from) return []
		const stones = Math.max(1, Math.round(((to - from) * radius) / 0.34))
		const step = (to - from) / stones
		return Arr.map(Arr.range(0, stones - 1), (index) => {
			const angle = from + (index + 0.5) * step
			// Every other stone stands taller and lighter: battlements.
			const isTall = index % 2 === 0
			const height = isTall ? 0.62 : 0.46
			return part(
				new THREE.BoxGeometry(step * radius + 0.02, height, 0.24),
				isTall ? "#ded5c5" : "#b9ad9a",
				{
					position: [
						at[0] + Math.cos(angle) * radius,
						height / 2,
						at[1] + Math.sin(angle) * radius,
					],
					turn: -(angle + Math.PI / 2),
				},
			)
		})
	})
}

/** Starts the pixel-art scene on `canvas`; it sizes to the canvas's parent. */
export function startPixelScene(
	canvas: HTMLCanvasElement,
	initial: SceneInput,
	events: SceneEvents,
): SceneHandle {
	const container = canvas.parentElement ?? canvas
	const labelsRoot = canvas.closest("[data-tiles-root]") ?? container
	const renderer = new THREE.WebGLRenderer({
		canvas,
		antialias: true,
		alpha: true,
		// The ground marks the stencil, so the sprites' shadows fall on it and nowhere else.
		stencil: true,
		powerPreference: "high-performance",
	})
	renderer.outputColorSpace = THREE.SRGBColorSpace
	renderer.toneMapping = THREE.NoToneMapping
	const camera = new THREE.PerspectiveCamera(30, 1, 1, 2000)
	const scene = new THREE.Scene()
	const sky = new THREE.HemisphereLight()
	const sun = new THREE.DirectionalLight()
	scene.add(sky, sun, sun.target)

	// The ground: one painting over every tile's top, and plain earth down the sides.
	const paper = document.createElement("canvas")
	const painting = new THREE.CanvasTexture(paper)
	painting.colorSpace = THREE.SRGBColorSpace
	painting.magFilter = THREE.NearestFilter
	painting.anisotropy = renderer.capabilities.getMaxAnisotropy()
	const materials = {
		top: new THREE.MeshLambertMaterial({
			map: painting,
			stencilWrite: true,
			stencilRef: GROUND,
			stencilZPass: THREE.ReplaceStencilOp,
		}),
		earth: new THREE.MeshLambertMaterial({ vertexColors: true }),
		stone: new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
		// Unlit, so they read at any hour: rings, slots, and the veil over unrelated tiles.
		ring: new THREE.MeshBasicMaterial({
			vertexColors: true,
			transparent: true,
			opacity: 0.92,
			depthWrite: false,
		}),
		veil: new THREE.MeshBasicMaterial({
			vertexColors: true,
			transparent: true,
			opacity: 0.5,
			depthWrite: false,
		}),
		slot: new THREE.MeshBasicMaterial({
			vertexColors: true,
			transparent: true,
			opacity: 0.85,
			depthWrite: false,
		}),
		ripple: new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }),
		// A held tile's would-be connections: a road to a neighbour, a railway to anything further.
		road: new THREE.MeshBasicMaterial({
			transparent: true,
			opacity: 0.85,
			depthWrite: false,
		}),
		rail: new THREE.MeshBasicMaterial({
			transparent: true,
			opacity: 0.7,
			depthWrite: false,
		}),
	}
	const land = {
		tops: new THREE.Mesh(new THREE.BufferGeometry(), materials.top),
		sides: new THREE.Mesh(new THREE.BufferGeometry(), materials.earth),
		walls: new THREE.Mesh(new THREE.BufferGeometry(), materials.stone),
		rings: new THREE.Mesh(new THREE.BufferGeometry(), materials.ring),
		veils: new THREE.Mesh(new THREE.BufferGeometry(), materials.veil),
		slots: new THREE.Mesh(new THREE.BufferGeometry(), materials.slot),
	}
	land.rings.renderOrder = 4
	land.veils.renderOrder = 3
	land.slots.renderOrder = 2
	const pointed = new THREE.Mesh(band(OUTLINE, 0.04, 0.9, 0.985, "#ffffff"), materials.ring)
	pointed.visible = false
	pointed.renderOrder = 5
	const chosen = new THREE.Mesh(band(OUTLINE, 0.05, 0, 0.95, "#f5a524"), materials.veil)
	chosen.visible = false
	chosen.renderOrder = 6
	const prospect = new THREE.Group()
	// The tile in hand: its own small painting on a block of earth.
	const heldPaper = document.createElement("canvas")
	const heldPainting = new THREE.CanvasTexture(heldPaper)
	heldPainting.colorSpace = THREE.SRGBColorSpace
	heldPainting.magFilter = THREE.NearestFilter
	const held = {
		group: new THREE.Group(),
		top: new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshLambertMaterial({ map: heldPainting })),
		sides: new THREE.Mesh(new THREE.BufferGeometry(), materials.earth),
		art: null as TileArt | null,
		id: null as string | null,
	}
	held.group.add(held.top, held.sides)
	held.group.visible = false
	// Rings spreading on a lake, and the health colours hung over failing traffic.
	const ripples = Arr.makeBy(4, () => {
		const mesh = new THREE.Mesh(
			new THREE.RingGeometry(0.86, 1, 40).rotateX(-Math.PI / 2),
			materials.ripple.clone(),
		)
		mesh.visible = false
		mesh.renderOrder = 5
		return mesh
	})
	const flags = Arr.makeBy(16, () => {
		const flag = new THREE.Sprite(new THREE.SpriteMaterial({ depthTest: false }))
		flag.scale.setScalar(0.24)
		flag.visible = false
		flag.renderOrder = 8
		return flag
	})
	scene.add(...Rec.values(land), pointed, chosen, prospect, held.group, ...ripples, ...flags)

	// A fixed number of lamps, handed to the villages that need them, and beams for lighthouses.
	const lamps = Arr.makeBy(LAMPS, () => {
		const light = new THREE.PointLight("#ffc56e", 0, 4, 1.4)
		scene.add(light)
		return { light, power: 0 }
	})
	const beacons = Arr.makeBy(BEACONS, () => {
		const light = new THREE.SpotLight("#ffe296", 0, 16, 0.3, 0.7, 1.1)
		scene.add(light, light.target)
		return { light, isLit: false, turn: 0 }
	})

	const quacks = quacker()
	const sounds = makeSounds(() => state.derived.input.muted)
	const state = {
		derived: derive(initial, null),
		ready: null as Ready | null,
		stopped: false,
		size: measure(container),
		pending: 0,
		raf: 0,
		last: performance.now(),
		seconds: 0,
		shownHour: initial.clock.hour,
		userMoved: false,
		fitKey: "",
		lastCommand: initial.command.serial,
		boardKey: "",
		trafficKey: "",
		marksKey: "",
		slotsKey: "",
		prospectKey: "",
		lands: new Array<Land>(),
		landCells: new Set<string>(),
		statics: new Array<Standing>(),
		carts: new Array<Cart>(),
		engines: new Array<Engine>(),
		box: null as SignalBox | null,
		roads: new Array<readonly [Point, Point]>(),
		rails: new Array<ReadonlyArray<Point>>(),
		buffers: new Array<Point>(),
		hot: new Array<Hot>(),
		/** A held tile's would-be connections, drawn from the cell it is over. */
		strips: new Array<THREE.Mesh<THREE.BoxGeometry>>(),
		hoverCell: null as Cell | null,
		hoverTile: null as Cell | null,
		/** Where on the ground the pointer is, in world units: a tile in hand follows it. */
		heldPoint: null as Point | null,
		/** Where the pointer is on the canvas, in CSS pixels; `null` once it has left. */
		pointerAt: null as Point | null,
		/** The place for the held tile was chosen with the arrow keys, not by the pointer. */
		isKeyed: false,
		/** The camera moved since the last frame: what the pointer is over may have changed. */
		cameraMoved: false,
		pressed: { x: 0, y: 0 },
		/** When each duck last hopped, in seconds. */
		hops: [-9, -9, -9],
		/** Three birds cross the board: how far across each is, and when it last took fright. */
		birds: Arr.map([0, 0.31, 0.62], (turn) => ({ turn, startledAt: -9 })),
		/** Rings spreading on a lake: where, and when they started. */
		rings: new Array<{ readonly at: Point; readonly since: number }>(),
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
	orbit.maxPolarAngle = 1.2
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
		state.cameraMoved = true
		if (gesture.active) state.userMoved = true
	})

	const atlas = new Image()
	atlas.addEventListener("load", () => {
		// The sheet can arrive after the scene was stopped: there is nothing left to draw on.
		if (state.stopped) return
		const sheet = new THREE.Texture(atlas)
		sheet.colorSpace = THREE.SRGBColorSpace
		sheet.magFilter = THREE.NearestFilter
		sheet.minFilter = THREE.LinearFilter
		sheet.generateMipmaps = false
		sheet.needsUpdate = true
		const size = { width: atlas.naturalWidth, height: atlas.naturalHeight }
		const ready: Ready = {
			sheet,
			painter: makePainter(atlas),
			statics: makeBillboards(sheet, size, 2048),
			moving: makeBillboards(sheet, size, 256),
		}
		scene.add(ready.statics.mesh, ready.statics.shade, ready.moving.mesh, ready.moving.shade)
		state.ready = ready
		// The held tile's block never changes shape: its painting is always the same size.
		const blocks = blocksOf([[0, 0]], ready.painter.tile(heldPaper, lakeArt("held")), () => true)
		held.top.geometry = blocks.tops
		held.sides.geometry = blocks.sides
		state.boardKey = ""
		sync()
	})
	atlas.src = new URL("./art/atlas.png", import.meta.url).href

	const centre = (cell: Cell): Point => {
		const [x, z] = cellToPoint(cell)
		return [x * PX, z * PX]
	}
	/** A flat hexagon over `cell`, `inner` to `outer` of the tile's size. */
	const plate = (cell: Cell, y: number, inner: number, outer: number, color: string) => {
		const [x, z] = cellToPoint(cell)
		return band(OUTLINE, y, inner, outer, color).translate(x, 0, z)
	}
	const replace = (mesh: THREE.Mesh, geometry: THREE.BufferGeometry) => {
		mesh.geometry.dispose()
		mesh.geometry = geometry
	}

	/** Everything that stands still: land, sprites, walls, lamps. Rebuilt when the board changes. */
	const syncBoard = (ready: Ready) => {
		const { input, cells, nodes, sizes, biomes, lakes, wilds, network, targets } = state.derived
		const down = Arr.filter([...cells], ([id]) => id !== input.heldId)
		const offered = new Set(Arr.map(targets?.free ?? [], cellKey))
		const key = encodeJson([
			down,
			lakes,
			Arr.map(wilds, (wild) => wild.cell),
			[...offered],
			state.roads,
			state.rails,
		])
		if (key === state.boardKey) return
		state.boardKey = key
		state.marksKey = ""
		const services = Arr.flatMap(down, ([id, cell]): Array<Land> => {
			const node = nodes.get(id)
			if (node === undefined) return []
			const art = serviceArt({
				id,
				kind: node.kind,
				size: sizes.get(id) ?? 0.5,
				biome: biomeOf(biomes, node.namespace),
				corridors: network.corridors.get(id) ?? [],
			})
			return [{ key: cellKey(cell), at: centre(cell), art, id }]
		})
		const waters = Arr.map(lakes, (cell): Land => ({
			key: cellKey(cell),
			at: centre(cell),
			art: lakeArt(cellKey(cell)),
			id: null,
		}))
		const country = Arr.flatMap(wilds, ({ cell, ring }): Array<Land> => {
			if (offered.has(cellKey(cell))) return []
			// Open country takes the biome of the service nearest to it.
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
			const biome = biomeOf(
				biomes,
				Option.getOrElse(
					Option.map(nearest, ([id]) => nodes.get(id)?.namespace ?? ""),
					() => "",
				),
			)
			return [
				{
					key: cellKey(cell),
					at: centre(cell),
					art: wildArt(cellKey(cell), biome, featureOf(cellKey(cell), ring, biome)),
					id: null,
				},
			]
		})
		state.lands = northFirst([...services, ...waters, ...country])
		state.landCells = new Set(Arr.map(state.lands, (each) => each.key))
		state.statics = Arr.flatMap(state.lands, (each) =>
			Arr.map(each.art.items, (item): Standing => ({
				sprite: item.sprite,
				at: toWorld([each.at[0] + item.x, each.at[1] + item.y]),
				owner: each.id,
			})),
		)
		// The painting, and the blocks it lies on.
		const frame = ready.painter.board(
			paper,
			state.lands,
			Arr.map(state.roads, ([from, to]) => [toArt(from), toArt(to)] as const),
			Arr.map(state.rails, (piece) => Arr.map(piece, toArt)),
		)
		painting.dispose()
		painting.needsUpdate = true
		const blocks = blocksOf(
			Arr.map(state.lands, (each): Point => [each.at[0] / PX, each.at[1] / PX]),
			frame,
			(middle, index) => {
				const [from, to] = [OUTLINE[index], OUTLINE[(index + 1) % OUTLINE.length]]
				if (from === undefined || to === undefined) return false
				const beyond = pointToCell([middle[0] + from[0] + to[0], middle[1] + from[1] + to[1]])
				return !state.landCells.has(cellKey(beyond))
			},
		)
		replace(land.tops, blocks.tops)
		replace(land.sides, blocks.sides)
		replace(
			land.walls,
			fuse(
				Arr.flatMap(state.lands, (each) =>
					each.art.wall === 0
						? []
						: wallOf(
								[each.at[0] / PX, each.at[1] / PX],
								each.art.wall / PX,
								each.id === null ? [] : (network.corridors.get(each.id) ?? []),
							),
				),
			),
		)
		// The lamps go to the biggest villages; the beams to the lighthouses.
		const wanting = Arr.sort(
			Arr.flatMap(state.lands, (each) =>
				each.art.lamp === null
					? []
					: [
							{
								at: [each.at[0] + each.art.lamp.x, each.at[1] + each.art.lamp.y] as const,
								reach: each.art.lamp.radius / PX,
							},
						],
			),
			Order.flip(Order.mapInput(Order.Number, (lamp: { readonly reach: number }) => lamp.reach)),
		)
		Arr.forEach(lamps, (lamp, index) => {
			const wanted = wanting[index]
			lamp.power = wanted === undefined ? 0 : 5 + wanted.reach * 3
			if (wanted === undefined) return
			lamp.light.position.set(...toWorld(wanted.at, 1.5))
			lamp.light.distance = wanted.reach * 1.7
		})
		const towers = Arr.flatMap(state.lands, (each) =>
			each.art.landmark?.kind === "lighthouse"
				? [
						toWorld(
							[each.at[0] + each.art.landmark.x, each.at[1] + each.art.landmark.y],
							(SPRITES.lighthouse[3] - 14) / PX,
						),
					]
				: [],
		)
		Arr.forEach(beacons, (beacon, index) => {
			const tower = towers[index]
			beacon.isLit = tower !== undefined
			if (tower !== undefined) beacon.light.position.set(...tower)
		})
		applyLight()
	}

	/** Roads, railways, carts and trains. A selection only changes which of them run. */
	const syncTraffic = () => {
		const { input, network } = state.derived
		const isDimmed = (link: Link) =>
			link.dimmed ||
			(input.selectedId !== null &&
				link.source !== input.selectedId &&
				link.target !== input.selectedId)
		const running = new Map(
			Arr.map([...network.roads, ...network.rails], ({ link }) => [link.id, !isDimmed(link)] as const),
		)
		const key = encodeJson([
			Arr.map(network.roads, (road) => [road.link.id, road.from, road.to, road.link.callsPerSecond]),
			Arr.map(network.rails, (rail) => [rail.link.id, rail.points, rail.link.callsPerSecond]),
		])
		if (key === state.trafficKey) {
			Arr.forEach(state.carts, (cart) => {
				cart.running = running.get(cart.linkId) === true
			})
			Arr.forEach(state.engines, (engine) => {
				engine.running = running.get(engine.linkId) === true
			})
			return
		}
		state.trafficKey = key
		const ailing = (link: Link): string | null => {
			const level = health(link.errorRate)
			return level === "healthy" ? null : HEALTH_COLOR[level]
		}
		state.roads = Arr.map(network.roads, ({ from, to }) => [from, to] as const)
		state.carts = Arr.flatMap(network.roads, ({ link, from, to }): Array<Cart> => {
			if (link.callsPerSecond <= 0) return []
			const busy = Math.log10(1 + link.callsPerSecond)
			const count = Math.min(3, 1 + Math.floor(busy / 1.4))
			return Arr.makeBy(count, (index) => ({
				linkId: link.id,
				from,
				to,
				speed: 0.035 + 0.02 * busy,
				isAiling: ailing(link),
				running: running.get(link.id) === true,
				progress: (index + ((link.id.length * 0.37) % 1)) / count,
			}))
		})
		const rail = railNetwork(
			Arr.map(network.rails, ({ link, points }) => ({ id: link.id, stops: points })),
		)
		state.rails = Arr.map(rail.pieces, (piece) => piece.line)
		state.buffers = Arr.map(rail.stations, (station) => station.at)
		state.engines = Arr.flatMap(network.rails, ({ link }, index): Array<Engine> => {
			const path = rail.paths.get(link.id)
			if (path === undefined || link.callsPerSecond <= 0) return []
			const busy = Math.log10(1 + link.callsPerSecond)
			const line: Line = {
				length: lengthOf(path),
				wagons: Math.min(3, 1 + Math.floor(busy / 1.5)),
				speed: 0.7 + 0.3 * busy,
				blocks: rail.blocks.get(link.id) ?? [],
				coupling: COUPLING,
			}
			return Option.match(Option.fromNullishOr(makeTrain(line, (index * 1.3) % 4)), {
				onNone: () => [],
				onSome: (train) => [
					{
						linkId: link.id,
						path,
						train,
						isAiling: ailing(link),
						running: running.get(link.id) === true,
					},
				],
			})
		})
		state.box = makeSignalBox(Arr.map(state.engines, (engine) => engine.train))
	}

	/** Rings round failing and selected tiles, the veil over unrelated ones, and their sprites paled. */
	const syncMarks = (ready: Ready) => {
		const { input, cells, nodes, related, palette } = state.derived
		const key = encodeJson([state.boardKey.length, input.selectedId, input.heldId, palette.selected])
		if (key === state.marksKey) return
		state.marksKey = key
		const down = Arr.filter([...cells], ([id]) => id !== input.heldId)
		replace(
			land.rings,
			fuse(
				Arr.flatMap(down, ([id, cell]) => {
					const node = nodes.get(id)
					const level = node === undefined ? "healthy" : health(node.errorRate)
					const isSelected = id === input.selectedId
					if (!isSelected && level === "healthy") return []
					return [
						plate(
							cell,
							0.03,
							isSelected ? 0.88 : 0.93,
							0.975,
							isSelected ? palette.selected : HEALTH_COLOR[level],
						),
					]
				}),
			),
		)
		const isApart = (id: string | null) => related !== null && id !== null && !related.has(id)
		replace(
			land.veils,
			fuse(
				Arr.flatMap(down, ([id, cell]) => (isApart(id) ? [plate(cell, 0.02, 0, 1, "#ecece4")] : [])),
			),
		)
		ready.statics.set(
			Arr.map(state.statics, (bill) => (isApart(bill.owner) ? { ...bill, fade: 0.5 } : bill)),
		)
	}

	/** Where a held tile may go. */
	const syncSlots = () => {
		const { targets, palette } = state.derived
		const key = encodeJson([targets?.free ?? [], palette.slot])
		if (key === state.slotsKey) return
		state.slotsKey = key
		replace(
			land.slots,
			fuse(
				Arr.flatMap(targets?.free ?? [], (cell) => [
					plate(cell, 0, 0, 0.93, "#f6ecd4"),
					plate(cell, 0.01, 0.89, 0.93, palette.slotEdge),
				]),
			),
		)
	}

	/** The cell the held tile is over, and the connections it would have there. */
	const syncProspect = () => {
		const { input, links, cells, palette } = state.derived
		const key = encodeJson([input.heldId, state.hoverCell])
		if (key === state.prospectKey) return
		state.prospectKey = key
		Arr.forEach(state.strips, (strip) => {
			prospect.remove(strip)
			strip.geometry.dispose()
		})
		state.strips = []
		materials.road.color.set(palette.selected)
		materials.rail.color.set(palette.slotEdge)
		const over = state.hoverCell
		chosen.visible = over !== null && input.heldId !== null
		if (over === null || input.heldId === null) return
		const [x, z] = cellToPoint(over)
		chosen.position.set(x, 0, z)
		Arr.forEach(links, (link) => {
			const other =
				link.source === input.heldId ? link.target : link.target === input.heldId ? link.source : null
			const at = other === null ? undefined : cells.get(other)
			if (at === undefined || sameCell(at, over)) return
			const isTouching = hexDistance(at, over) === 1
			const [tx, tz] = cellToPoint(at)
			const strip = new THREE.Mesh(
				new THREE.BoxGeometry(Math.hypot(tx - x, tz - z), 0.04, isTouching ? 0.3 : 0.08),
				isTouching ? materials.road : materials.rail,
			)
			strip.position.set((x + tx) / 2, 0.09, (z + tz) / 2)
			strip.rotation.y = -Math.atan2(tz - z, tx - x)
			strip.renderOrder = 7
			prospect.add(strip)
			state.strips.push(strip)
		})
	}

	/** The tile in hand gets its own painting; what stands on it is drawn with the moving sprites. */
	const syncHeld = (ready: Ready) => {
		const { input, nodes, sizes, biomes, cells } = state.derived
		if (input.heldId === held.id) return
		held.id = input.heldId
		const node = input.heldId === null ? undefined : nodes.get(input.heldId)
		held.group.visible = node !== undefined
		held.art = null
		if (input.heldId === null || node === undefined) return
		held.art = serviceArt({
			id: input.heldId,
			kind: node.kind,
			size: sizes.get(input.heldId) ?? 0.5,
			biome: biomeOf(biomes, node.namespace),
			corridors: [],
		})
		ready.painter.tile(heldPaper, held.art)
		heldPainting.needsUpdate = true
		// It lifts from where it stood; a tile off the stack comes in over the middle of the board.
		const home = cells.get(input.heldId)
		const [x, z] = home === undefined ? state.derived.centre : cellToPoint(home)
		held.group.position.set(x, home === undefined ? HELD_LIFT : 0, z)
	}

	/** Lights the map for the hour now showing: the sun or the moon, the sky's fill, the lamps. */
	const applyLight = () => {
		const { radius, centre: middle, input } = state.derived
		const light = daylightAt({ ...input.clock, hour: state.shownHour })
		sky.color.setRGB(...light.sky, THREE.SRGBColorSpace)
		sky.groundColor.setRGB(...light.bounce, THREE.SRGBColorSpace)
		sky.intensity = light.skyPower * 0.8
		sun.color.setRGB(...light.sun, THREE.SRGBColorSpace)
		sun.intensity = light.sunPower * 0.8
		sun.target.position.set(middle[0], 0, middle[1])
		const [x, y, z] = light.direction
		const far = radius * 1.6
		sun.position.set(middle[0] + x * far, y * far, middle[1] + z * far)
		// A shadow lies away from the light, longer as the light sinks; it is drawn falling
		// towards the near side of the board, where it is seen, and paler by night.
		const flat = Math.max(1e-6, Math.hypot(x, z))
		const reach = Math.min(1.7, flat / Math.max(0.05, y))
		const way: Point = [(-x / flat) * reach, (Math.abs(z) / flat) * reach]
		Arr.forEach([state.ready?.statics, state.ready?.moving], (set) =>
			// A shadow fades out with the light that throws it, as the sun hands over to the moon.
			set?.cast(way, (0.44 - 0.2 * light.lamps) * Math.min(1, Math.max(0, (light.direct - 0.2) / 0.4))),
		)
		Arr.forEach(lamps, (lamp) => {
			lamp.light.intensity = lamp.power * light.lamps
		})
		Arr.forEach(beacons, (beacon) => {
			beacon.light.intensity = beacon.isLit ? BEACON_POWER * light.lamps : 0
		})
	}

	/** Turns the shown hour towards the wanted one, the short way round the clock. */
	const turnClock = (delta: number): boolean => {
		const apart = ((((state.derived.input.clock.hour - state.shownHour) % 24) + 36) % 24) - 12
		if (Math.abs(apart) < 1e-3) return false
		const step = Math.min(Math.abs(apart), delta * Math.max(8, Math.abs(apart) * 3))
		state.shownHour = (((state.shownHour + Math.sign(apart) * step) % 24) + 24) % 24
		applyLight()
		return true
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

	const fit = () => {
		const { radius, centre: middle } = state.derived
		const vertical = THREE.MathUtils.degToRad(camera.fov) / 2
		const horizontal = Math.atan(Math.tan(vertical) * camera.aspect)
		// The board lies flat, so it needs less of the frame's height than its radius.
		const distance = Math.max((radius * 0.8) / Math.sin(vertical), (radius * 0.98) / Math.sin(horizontal))
		const polar = 0.82
		orbit.target.set(middle[0], 0, middle[1])
		camera.position.set(middle[0], distance * Math.cos(polar), middle[1] + distance * Math.sin(polar))
		orbit.minDistance = distance * 0.1
		orbit.maxDistance = distance * 1.8
		camera.near = distance * 0.02
		camera.far = distance * 6
		camera.updateProjectionMatrix()
		orbit.update()
	}

	const resize = () => {
		state.size = measure(container)
		renderer.setPixelRatio(Math.min(Math.max(1, window.devicePixelRatio), 2))
		renderer.setSize(state.size.width, state.size.height, true)
		camera.aspect = state.size.width / state.size.height
		camera.updateProjectionMatrix()
		invalidate()
	}

	/** Fits on the first frame, on Reset, and on a bigger board or a new canvas size until the user takes the view. */
	const rig = () => {
		const { input, radius, centre: middle } = state.derived
		const key = `${middle[0].toFixed(2)}:${middle[1].toFixed(2)}:${radius}:${state.size.width}:${state.size.height}`
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

	/** Carts and trains move on; everything that moves is listed for drawing and for clicks. */
	const movers = (
		delta: number,
		across: THREE.Vector3,
	): { readonly bills: Array<Bill>; readonly ailing: Array<Ailing> } => {
		const { input } = state.derived
		const bills: Array<Bill> = []
		const ailing: Array<Ailing> = []
		// A sprite is drawn facing right: it is mirrored when it runs the other way across the screen.
		const isLeftward = (way: Point) => way[0] * across.x + way[1] * across.z < 0
		const tall = (sprite: Bill["sprite"]) => SPRITES[sprite][3] / PX
		// Traffic that has nothing to do with the selected service pales with its tiles.
		const paled = (mover: { readonly running: boolean }) => (mover.running ? 0 : 0.5)
		state.hot = []
		Arr.forEach(state.carts, (cart) => {
			if (input.flowing && cart.running) cart.progress = (cart.progress + delta * cart.speed) % 1
			const out = cart.progress < 0.5
			const t = out ? cart.progress * 2 : 2 - cart.progress * 2
			const [dx, dz] = [cart.to[0] - cart.from[0], cart.to[1] - cart.from[1]]
			const length = Math.hypot(dx, dz)
			// Clear of both squares, and on the right of the road each way.
			const along = 0.65 + t * (length - 1.3)
			const side = out ? 0.18 : -0.18
			const at: Vec3 = [
				cart.from[0] + (dx / length) * along - (dz / length) * side,
				0,
				cart.from[1] + (dz / length) * along + (dx / length) * side,
			]
			bills.push({
				sprite: "cart",
				at,
				flip: isLeftward(out ? [dx, dz] : [-dx, -dz]),
				fade: paled(cart),
			})
			state.hot.push({ at, tall: tall("cart"), linkId: cart.linkId, kind: "cart" })
			if (cart.isAiling !== null)
				ailing.push({ at: [at[0], tall("cart") + 0.2, at[2]], color: cart.isAiling })
		})
		state.box?.step(
			Math.min(delta, 0.05),
			() => (input.flowing ? 1 : 0),
			(index) => state.engines[index]?.running === true,
		)
		Arr.forEach(state.engines, (engine) => {
			const { train, path } = engine
			const place = (along: number) => {
				const found = pointAlong(path, along)
				return { at: [found.at[0], 0, found.at[1]] as const, flip: isLeftward(found.way) }
			}
			const nose = place(train.along)
			bills.push({ sprite: "loco", at: nose.at, flip: nose.flip, fade: paled(engine) })
			state.hot.push({ at: nose.at, tall: tall("loco"), linkId: engine.linkId, kind: "train" })
			if (engine.isAiling !== null)
				ailing.push({ at: [nose.at[0], tall("loco") + 0.2, nose.at[2]], color: engine.isAiling })
			Arr.forEach(wagonsOf(train), (wagon) => {
				const car = place(train.along - wagon * COUPLING)
				const sprite = isLoaded(train) ? "wagonFull" : "wagonEmpty"
				bills.push({ sprite, at: car.at, flip: car.flip, fade: paled(engine) })
				state.hot.push({ at: car.at, tall: tall(sprite), linkId: engine.linkId, kind: "train" })
			})
			Arr.forEach(signalsOf(train.line), (signal) => {
				const found = pointAlong(path, signal.along)
				const length = Math.hypot(found.way[0], found.way[1])
				const isRed = Arr.some(signal.guards, (section) => state.box?.isOccupied(section) === true)
				bills.push({
					sprite: isRed ? "signalRed" : "signalGreen",
					at: [
						found.at[0] - (found.way[1] / length) * 0.4 * signal.side,
						0,
						found.at[1] + (found.way[0] / length) * 0.4 * signal.side,
					],
				})
			})
		})
		return { bills, ailing }
	}

	const ducks = (across: THREE.Vector3): Array<Bill> => {
		const first = state.derived.lakes[0]
		if (first === undefined) return []
		const [cx, cy] = centre(first)
		return Arr.map([0.1, 0.42, 0.74], (phase, index) => {
			const turn = (phase + state.seconds * 0.02) * Math.PI * 2
			const hop = Math.max(0, 1 - (state.seconds - (state.hops[index] ?? -9)) / 0.45)
			const [wide, deep] = [DUCK_LOOP * (0.7 + index * 0.25), DUCK_LOOP * (0.55 + index * 0.2)]
			return {
				sprite: "duck",
				at: toWorld(
					[cx + Math.cos(turn) * wide, cy + Math.sin(turn) * deep],
					Math.sin(Math.PI * hop) * 0.25,
				),
				flip: -Math.sin(turn) * wide * across.x + Math.cos(turn) * deep * across.z < 0,
			}
		})
	}

	const isBirdStartled = (): boolean =>
		Arr.some(state.birds, (bird) => state.seconds - bird.startledAt < BIRD_FRIGHT)
	/** Where the birds are: a startled one beats its wings fast and climbs for a moment. */
	const birds = (): Array<Bill> =>
		Arr.map(state.birds, (bird, index) => {
			const middle = toArt(state.derived.centre)
			const span = state.derived.radius * PX * 2.6
			const u = bird.turn % 1
			const fright = Math.max(0, 1 - (state.seconds - bird.startledAt) / BIRD_FRIGHT)
			const isUp = Math.floor(state.seconds * (fright > 0 ? 12 : 5) + index) % 2 === 0
			return {
				sprite: isUp ? "birdUp" : "birdDown",
				at: toWorld(
					[
						middle[0] - span / 2 + u * span + (index % 2) * 30,
						middle[1] - span * 0.28 + index * 150 + Math.sin(u * 9 + index) * 24,
					],
					BIRD_HEIGHT + Math.sin(Math.PI * fright) * 1.75,
				),
				flip: rightward().x < 0,
			}
		})
	/** Which way is right on the screen, as a direction in the world. */
	const rightward = (): THREE.Vector3 => new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion)

	const probe = new THREE.Vector3()
	/** Where a point in the world falls on the canvas, in CSS pixels. */
	const screenOf = (x: number, y: number, z: number): Point => {
		probe.set(x, y, z).project(camera)
		return [(probe.x * 0.5 + 0.5) * state.size.width, (-probe.y * 0.5 + 0.5) * state.size.height]
	}
	/** Whether `pointer` (CSS pixels on the canvas) is on a sprite `tall` world units high standing at `foot`. */
	const isOver = (pointer: Point, foot: Vec3, tall: number): boolean => {
		const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion)
		const base = screenOf(...foot)
		const top = screenOf(foot[0] + up.x * tall, foot[1] + up.y * tall, foot[2] + up.z * tall)
		const reach = Math.max(10, Math.hypot(top[0] - base[0], top[1] - base[1]) * 0.6)
		return Math.hypot(pointer[0] - (base[0] + top[0]) / 2, pointer[1] - (base[1] + top[1]) / 2) < reach
	}

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
		const out = HEX_SIZE * Math.cos(Math.PI / 6) * 0.7
		Arr.forEach(labels, ({ id, element }) => {
			const cell = cells.get(id)
			if (cell === undefined || id === input.heldId || state.ready === null) {
				element.style.visibility = "hidden"
				return
			}
			const [x, z] = cellToPoint(cell)
			const [left, top] = screenOf(x + toCamera.x * out, 0.05, z + toCamera.y * out)
			const [width, height] = [element.offsetWidth, element.offsetHeight]
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
		if (!held.group.visible) return false
		const target = state.hoverCell !== null ? cellToPoint(state.hoverCell) : state.heldPoint
		const goal = new THREE.Vector3(
			target?.[0] ?? held.group.position.x,
			HELD_LIFT,
			target?.[1] ?? held.group.position.z,
		)
		const before = held.group.position.distanceTo(goal)
		held.group.position.lerp(goal, 1 - Math.exp(-delta * 16))
		return before > 0.01
	}

	const frame = (ready: Ready, delta: number) => {
		const { input } = state.derived
		const right = rightward()
		const moving = movers(delta, right)
		Arr.forEach(state.birds, (bird) => {
			const isStartled = state.seconds - bird.startledAt < BIRD_FRIGHT
			if (input.flowing || isStartled) bird.turn += delta * (isStartled ? 0.16 : 0.03)
		})
		const { x, y, z } = held.group.position
		ready.moving.set([
			...moving.bills,
			...Arr.map(state.buffers, ([bx, bz]): Bill => ({ sprite: "buffer", at: [bx, 0, bz] })),
			...ducks(right),
			...(input.flowing || isBirdStartled() ? birds() : []),
			...(held.group.visible
				? Arr.map(held.art?.items ?? [], (item): Bill => ({
						sprite: item.sprite,
						at: [x + item.x / PX, y, z + item.y / PX],
					}))
				: []),
		])
		Arr.forEach(flags, (flag, index) => {
			const wanted = moving.ailing[index]
			flag.visible = wanted !== undefined
			if (wanted === undefined) return
			flag.position.set(...wanted.at)
			flag.material.color.set(wanted.color)
		})
		state.rings = Arr.filter(state.rings, (ring) => state.seconds - ring.since < 1)
		Arr.forEach(ripples, (ripple, index) => {
			const ring = state.rings[index]
			ripple.visible = ring !== undefined
			if (ring === undefined) return
			const age = state.seconds - ring.since
			ripple.position.set(ring.at[0], 0.03, ring.at[1])
			ripple.scale.setScalar(0.15 + age * 0.85)
			ripple.material.opacity = 0.8 * (1 - age)
		})
	}

	const loop = (now: number) => {
		state.raf = requestAnimationFrame(loop)
		const { input } = state.derived
		const idle = state.pending === 0
		if (!input.flowing && idle && input.heldId === null) return
		if (idle && input.heldId === null && now - state.last < FRAME_MS) return
		const delta = Math.min(0.05, (now - state.last) / 1000)
		state.last = now
		state.pending = Math.max(0, state.pending - 1)
		const ready = state.ready
		if (ready === null) return
		rig()
		if (state.cameraMoved) {
			state.cameraMoved = false
			retarget()
		}
		// What a click set off plays out on a paused map too: keep drawing until it all settles.
		const playing = [
			turnClock(delta),
			carryHeld(delta),
			state.rings.length > 0,
			isBirdStartled(),
			Arr.some(state.hops, (at) => state.seconds - at < 0.5),
		]
		const isPlaying = Arr.some(playing, Boolean)
		if (isPlaying) invalidate()
		if (input.flowing || isPlaying) state.seconds += delta
		if (input.flowing && turnBeacons(delta)) invalidate()
		frame(ready, delta)
		renderer.render(scene, camera)
		placeLabels()
	}

	const raycaster = new THREE.Raycaster()
	const ground = new THREE.Plane(UP, 0)
	const pointerOf = (event: MouseEvent): Point => {
		const bounds = canvas.getBoundingClientRect()
		return [event.clientX - bounds.left, event.clientY - bounds.top]
	}
	/** The point of the ground under the pointer, in world units. */
	const groundAt = (event: MouseEvent): Point | null => groundUnder(pointerOf(event))
	const groundUnder = ([x, y]: Point): Point | null => {
		raycaster.setFromCamera(
			new THREE.Vector2((x / state.size.width) * 2 - 1, -(y / state.size.height) * 2 + 1),
			camera,
		)
		const point = raycaster.ray.intersectPlane(ground, new THREE.Vector3())
		return point === null ? null : [point.x, point.z]
	}
	const serviceAt = (point: Point | null): string | null => {
		if (point === null) return null
		const cell = pointToCell(point)
		const found = Arr.findFirst(
			[...state.derived.cells],
			([id, at]) => id !== state.derived.input.heldId && sameCell(at, cell),
		)
		return Option.getOrNull(Option.map(found, ([id]) => id))
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
	const moverAt = (pointer: Point): Hot | null =>
		Option.getOrNull(Arr.findFirst(state.hot, (hot) => isOver(pointer, hot.at, hot.tall)))
	const duckAt = (pointer: Point): number | null =>
		Option.getOrNull(
			Arr.findFirstIndex(ducks(rightward()), (duck) => isOver(pointer, duck.at, SPRITES.duck[3] / PX)),
		)
	/** The bird under the pointer, while the birds are out. */
	const birdAt = (pointer: Point): number | null =>
		state.derived.input.flowing || isBirdStartled()
			? Option.getOrNull(
					Arr.findFirstIndex(birds(), (bird) => isOver(pointer, bird.at, SPRITES.birdUp[3] / PX)),
				)
			: null
	const lakeAt = (point: Point | null): boolean => {
		if (point === null) return false
		const cell = pointToCell(point)
		const [x, z] = cellToPoint(cell)
		return (
			Arr.some(state.derived.lakes, (lake) => sameCell(lake, cell)) &&
			Math.hypot(point[0] - x, point[1] - z) < 2.5
		)
	}

	const onPointerDown = (event: PointerEvent) => {
		state.pressed = { x: event.clientX, y: event.clientY }
	}
	/** The camera can move under a still pointer (it glides on after a drag, or zooms): the place
	 * the pointer chose for the held tile is worked out again, so a click lands where it shows. */
	const retarget = () => {
		if (state.derived.input.heldId === null || state.isKeyed || state.pointerAt === null) return
		const point = groundUnder(state.pointerAt)
		state.heldPoint = point
		setHover(targetAt(point))
	}
	/** The tile whose landmark the pointer is on. A tall one stands in front of the tile behind
	 * it, so the ground under the pointer would name the wrong tile. */
	const landmarkAt = (pointer: Point): Land | null => {
		const { input } = state.derived
		const hit = Arr.filter(state.lands, (each) => {
			const tower = each.art.landmark
			return (
				each.id !== null &&
				each.id !== input.heldId &&
				tower !== null &&
				isOver(
					pointer,
					toWorld([each.at[0] + tower.x, each.at[1] + tower.y]),
					SPRITES[tower.kind][3] / PX,
				)
			)
		})
		const away = (each: Land) => camera.position.distanceTo(new THREE.Vector3(...toWorld(each.at)))
		return Option.getOrNull(Arr.head(Arr.sort(hit, Order.mapInput(Order.Number, away))))
	}
	const onPointerMove = (event: PointerEvent) => {
		const { input } = state.derived
		const point = groundAt(event)
		state.pointerAt = pointerOf(event)
		if (input.heldId !== null) {
			pointed.visible = false
			state.isKeyed = false
			state.heldPoint = point
			setHover(targetAt(point))
			canvas.style.cursor = state.hoverCell === null ? "grabbing" : "copy"
			return invalidate()
		}
		const pointer = pointerOf(event)
		const id = landmarkAt(pointer)?.id ?? serviceAt(point)
		const lively =
			(!input.building && moverAt(pointer) !== null) ||
			duckAt(pointer) !== null ||
			birdAt(pointer) !== null ||
			lakeAt(point)
		canvas.style.cursor = lively || id !== null ? "pointer" : ""
		const hover = id === null || lively ? null : (state.derived.cells.get(id) ?? null)
		if (
			(hover === null ? "" : cellKey(hover)) !==
			(state.hoverTile === null ? "" : cellKey(state.hoverTile))
		)
			invalidate()
		state.hoverTile = hover
		pointed.visible = hover !== null
		if (hover !== null) pointed.position.set(cellToPoint(hover)[0], 0, cellToPoint(hover)[1])
	}
	const onClick = (event: MouseEvent) => {
		if (Math.hypot(event.clientX - state.pressed.x, event.clientY - state.pressed.y) > DRAG_TOLERANCE)
			return
		const { input } = state.derived
		const point = groundAt(event)
		const pointer = pointerOf(event)
		if (input.heldId !== null) {
			const cell = targetAt(point)
			if (cell !== null) events.onPlace(input.heldId, cell)
			return
		}
		const duck = duckAt(pointer)
		if (duck !== null) {
			state.hops[duck] = state.seconds
			if (!input.muted) quacks.quack(2)
			return invalidate()
		}
		const bird = birdAt(pointer)
		if (bird !== null) {
			const startled = state.birds[bird]
			if (startled !== undefined) startled.startledAt = state.seconds
			sounds.chirp(3)
			return invalidate()
		}
		const mover = input.building ? null : moverAt(pointer)
		if (mover !== null) {
			if (mover.kind === "train") sounds.whistle()
			else sounds.ding()
			return events.onPokeLink(mover.linkId)
		}
		const marked = landmarkAt(pointer)
		const id = marked?.id ?? serviceAt(point)
		if (input.building) {
			if (id !== null) events.onPickUp(id)
			return
		}
		if (id === null && point !== null && lakeAt(point)) {
			state.rings.push({ at: point, since: state.seconds })
			sounds.splash()
			return invalidate()
		}
		// A church rings its bell and the birds take fright; a lighthouse sounds its horn. The
		// click still selects the service.
		const tower = marked?.art.landmark ?? null
		if (tower !== null) {
			if (tower.kind === "church") {
				sounds.bell()
				Arr.forEach(state.birds, (each) => {
					each.startledAt = state.seconds
				})
			}
			if (tower.kind === "lighthouse") sounds.horn()
			invalidate()
		}
		events.onSelect(id === null || id === input.selectedId ? null : id)
	}
	const onLeave = () => {
		state.pointerAt = null
		state.hoverTile = null
		pointed.visible = false
		invalidate()
	}
	const onContextMenu = (event: MouseEvent) => event.preventDefault()
	/** A way across the screen as a way across the board, however the camera is turned. */
	const acrossBoard = ([right, down]: Point): Point => {
		const ahead = camera.getWorldDirection(new THREE.Vector3())
		const side = rightward()
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
			// The map takes the focus, so that Enter puts the tile down and presses no button.
			canvas.focus({ preventScroll: true })
			state.isKeyed = true
			setHover(keyedTarget(state.derived, state.hoverCell, acrossBoard(arrow)))
			return invalidate()
		}
		// Enter on a button or a link presses it: the tile stays in hand.
		if (event.key === "Enter" && state.hoverCell !== null && !isOnControl(event)) {
			event.preventDefault()
			events.onPlace(input.heldId, state.hoverCell)
		}
	}
	// A wheel over a name plate or a panel still zooms: the controls only hear the canvas.
	const onWheel = (event: Event) => {
		if (event.target === canvas || !(event instanceof WheelEvent)) return
		event.preventDefault()
		canvas.dispatchEvent(new WheelEvent("wheel", event))
	}
	canvas.addEventListener("pointerdown", onPointerDown)
	canvas.addEventListener("pointermove", onPointerMove)
	canvas.addEventListener("pointerleave", onLeave)
	canvas.addEventListener("click", onClick)
	canvas.addEventListener("contextmenu", onContextMenu)
	labelsRoot.addEventListener("wheel", onWheel, { passive: false })
	window.addEventListener("keydown", onKeyDown)
	const observer = new ResizeObserver(resize)
	observer.observe(container)
	const sync = () => {
		applyLight()
		syncTraffic()
		const ready = state.ready
		if (ready !== null) {
			syncBoard(ready)
			syncMarks(ready)
			syncHeld(ready)
		}
		syncSlots()
		syncProspect()
		invalidate()
	}
	resize()
	sync()
	state.raf = requestAnimationFrame(loop)
	return {
		update: (input) => {
			const previous = state.derived
			state.derived = derive(input, previous)
			if (input.heldId !== null) pointed.visible = false
			if (previous.input.heldId !== input.heldId || previous.input.cells !== input.cells) {
				state.hoverCell = null
				state.heldPoint = null
			}
			sync()
		},
		stop: () => {
			state.stopped = true
			cancelAnimationFrame(state.raf)
			observer.disconnect()
			canvas.removeEventListener("pointerdown", onPointerDown)
			canvas.removeEventListener("pointermove", onPointerMove)
			canvas.removeEventListener("pointerleave", onLeave)
			canvas.removeEventListener("click", onClick)
			canvas.removeEventListener("contextmenu", onContextMenu)
			labelsRoot.removeEventListener("wheel", onWheel)
			window.removeEventListener("keydown", onKeyDown)
			orbit.dispose()
			state.ready?.statics.dispose()
			state.ready?.moving.dispose()
			state.ready?.sheet.dispose()
			Arr.forEach([...Rec.values(land), pointed, chosen, held.top, held.sides, ...ripples], (mesh) => {
				mesh.geometry.dispose()
			})
			Arr.forEach(ripples, (ripple) => ripple.material.dispose())
			Arr.forEach(flags, (flag) => flag.material.dispose())
			held.top.material.dispose()
			Arr.forEach(Rec.values(materials), (material) => material.dispose())
			painting.dispose()
			heldPainting.dispose()
			quacks.close()
			sounds.close()
			renderer.dispose()
			// The canvas is made anew for each style: without this every switch would leave a
			// live WebGL context behind, until the browser starts dropping them.
			renderer.forceContextLoss()
		},
	}
}

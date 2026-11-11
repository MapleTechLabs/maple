import { encodeJson } from "@maple/views/data/request-key"
import { Array as Arr, Option, Order } from "effect"
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
	hexDistance,
	type Point,
	pointToCell,
	sameCell,
} from "./hex"
import {
	DUCK_LOOP,
	type GroundName,
	INRADIUS,
	lakeArt,
	type Placed,
	PX,
	serviceArt,
	type TileArt,
	wildArt,
} from "./pixel-layout"
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
import { makeSounds } from "./sounds"
import { featureOf } from "./wild"
import {
	arrowOf,
	derive,
	isTyping,
	keyedTarget,
	type SceneEvents,
	type SceneHandle,
	type SceneInput,
} from "./world"

// The pixel-art map: the same board, roads, railways and traffic as the 3D scene, drawn in 2D
// from a sheet of hand-pixelled sprites. Everything is laid out in art pixels and the camera
// scales whole pixels, so at a whole-number zoom every art pixel is a square block on screen.

const LABEL_ATTRIBUTE = "data-tile-label"
const DRAG_TOLERANCE = 5
/** Traffic and water are drawn at about 30 frames a second. */
const FRAME_MS = 32
/** The earth that shows below the board's southern edge. */
const RIM = 18
const SOIL = "#7a5b3c"
const SOIL_SHADE = "#5f452d"
const OUTLINE = "#2b1f2e"
const GROUNDS: ReadonlyArray<GroundName> = [
	"grass",
	"dryGrass",
	"forestFloor",
	"autumn",
	"rocky",
	"flowerGrass",
	"snow",
	"dirt",
	"water",
	"deepWater",
	"sand",
	"wheatField",
]
/** How far apart a pixel train's wagons ride, in world units: a wagon sprite's length. */
const COUPLING = 1.3
/** Seconds a startled bird hurries for. */
const BIRD_FRIGHT = 2.5

const toPx = ([x, z]: Point): Point => [x * PX, z * PX]

interface Land {
	readonly key: string
	readonly at: Point
	readonly art: TileArt
	/** The service standing on it; `null` for open country and lakes. */
	readonly id: string | null
}

interface Sprite extends Placed {
	/** Lifts the sprite off its foot: a hopping duck. */
	readonly lift?: number
	readonly flip?: boolean
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

interface Hot {
	readonly x: number
	readonly y: number
	readonly linkId: string
	readonly kind: "cart" | "train"
}

/** Where `along` art pixels down a polyline is, and which way the line runs there. */
const pointAlong = (
	path: ReadonlyArray<Point>,
	along: number,
): { readonly at: Point; readonly dx: number; readonly dy: number } => {
	const state = { left: Math.max(0, along) }
	for (let index = 0; index < path.length - 1; index++) {
		const [a, b] = [path[index], path[index + 1]]
		if (a === undefined || b === undefined) break
		const length = Math.hypot(b[0] - a[0], b[1] - a[1])
		if (state.left <= length || index === path.length - 2) {
			const t = length === 0 ? 0 : Math.min(1, state.left / length)
			return {
				at: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
				dx: b[0] - a[0],
				dy: b[1] - a[1],
			}
		}
		state.left -= length
	}
	return { at: path[0] ?? [0, 0], dx: 1, dy: 0 }
}

const lengthOf = (path: ReadonlyArray<Point>): number =>
	Arr.reduce(
		Arr.zip(path, Arr.drop(path, 1)),
		0,
		(sum, [a, b]) => sum + Math.hypot(b[0] - a[0], b[1] - a[1]),
	)

/** Starts the pixel-art scene on `canvas`; it sizes to the canvas's parent. */
export function startPixelScene(
	canvas: HTMLCanvasElement,
	initial: SceneInput,
	events: SceneEvents,
): SceneHandle {
	const container = canvas.parentElement ?? canvas
	const labelsRoot = canvas.closest("[data-tiles-root]") ?? container
	const context = canvas.getContext("2d")
	// A fresh canvas always has a 2D context; without one there is nothing to draw on.
	if (context === null) return { update: () => undefined, stop: () => undefined }
	const ctx = context
	const dark = document.createElement("canvas")
	const atlas = new Image()
	const patterns = new Map<GroundName, CanvasPattern>()
	const quacks = quacker()
	const sounds = makeSounds(() => state.derived.input.muted)
	const state = {
		derived: derive(initial, null),
		width: 1,
		height: 1,
		ratio: 1,
		/** Device pixels per art pixel, and where art (0, 0) falls on the canvas. */
		scale: 1,
		x: 0,
		y: 0,
		raf: 0,
		last: 0,
		dirty: true,
		userMoved: false,
		fitKey: "",
		lastCommand: initial.command.serial,
		boardKey: "",
		trafficKey: "",
		lands: new Array<Land>(),
		statics: new Array<Sprite>(),
		lamps: new Array<{ readonly x: number; readonly y: number; readonly radius: number }>(),
		coast: new Path2D(),
		landCells: new Set<string>(),
		carts: new Array<Cart>(),
		engines: new Array<Engine>(),
		box: null as SignalBox | null,
		rails: new Array<ReadonlyArray<Point>>(),
		buffers: new Array<Point>(),
		hot: new Array<Hot>(),
		shownHour: initial.clock.hour,
		seconds: 0,
		hoverCell: null as Cell | null,
		hoverTile: null as Cell | null,
		pointer: null as Point | null,
		pressed: { x: 0, y: 0, panning: false },
		/** When each duck last hopped, in seconds. */
		hops: [-9, -9, -9],
		/** Three birds cross the board: how far across each is, and when it last took fright. */
		birds: Arr.map([0, 0.31, 0.62], (turn) => ({ turn, startledAt: -9 })),
		/** Rings spreading on a lake: where, and when they started. */
		rings: new Array<{ readonly at: Point; readonly since: number }>(),
	}
	const invalidate = () => {
		state.dirty = true
	}
	atlas.addEventListener("load", () => {
		Arr.forEach(GROUNDS, (name) => {
			const [sx, sy, w, h] = SPRITES[name]
			const swatch = document.createElement("canvas")
			swatch.width = w
			swatch.height = h
			swatch.getContext("2d")?.drawImage(atlas, sx, sy, w, h, 0, 0, w, h)
			const pattern = ctx.createPattern(swatch, "repeat")
			if (pattern !== null) patterns.set(name, pattern)
		})
		invalidate()
	})
	atlas.src = new URL("./art/atlas.png", import.meta.url).href

	const centre = (cell: Cell): Point => toPx(cellToPoint(cell))
	const hexPath = (at: Point, grow = 0): Path2D => {
		const path = new Path2D()
		Arr.forEach(corners({ q: 0, r: 0 }), ([x, z], index) => {
			const [px, py] = [at[0] + x * (PX + grow / 4), at[1] + z * (PX + grow / 4)]
			if (index === 0) path.moveTo(px, py)
			else path.lineTo(px, py)
		})
		path.closePath()
		return path
	}

	/** Everything that stands still: land, sprites, lamps, the coast. Rebuilt when the board changes. */
	const syncBoard = () => {
		const { input, cells, nodes, sizes, biomes, lakes, wilds, network, targets } = state.derived
		const down = Arr.filter([...cells], ([id]) => id !== input.heldId)
		const offered = new Set(Arr.map(targets?.free ?? [], cellKey))
		const key = encodeJson([down, lakes, Arr.map(wilds, (wild) => wild.cell), [...offered]])
		if (key === state.boardKey) return
		state.boardKey = key
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
		// North to south, so a tile's rim of earth is covered by the tile below it.
		state.lands = Arr.sort(
			[...services, ...waters, ...country],
			Order.mapInput(Order.Number, (land: Land) => land.at[1]),
		)
		state.landCells = new Set(Arr.map(state.lands, (land) => land.key))
		state.statics = Arr.flatMap(state.lands, (land) =>
			Arr.map(land.art.items, (item) => ({ ...item, x: land.at[0] + item.x, y: land.at[1] + item.y })),
		)
		state.lamps = Arr.flatMap(state.lands, (land) =>
			land.art.lamp === null
				? []
				: [
						{
							x: land.at[0] + land.art.lamp.x,
							y: land.at[1] + land.art.lamp.y,
							radius: land.art.lamp.radius,
						},
					],
		)
		// The coast: every side of a tile with nothing beyond it.
		const coast = new Path2D()
		Arr.forEach(state.lands, (land) => {
			const cell = pointToCell([land.at[0] / PX, land.at[1] / PX])
			const ring = corners(cell)
			Arr.forEach(ring, (from, index) => {
				const to = ring[(index + 1) % ring.length]
				if (to === undefined) return
				const [mx, mz] = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2]
				const [x, z] = cellToPoint(cell)
				const beyond = pointToCell([x + (mx - x) * 2, z + (mz - z) * 2])
				if (state.landCells.has(cellKey(beyond))) return
				coast.moveTo(from[0] * PX, from[1] * PX)
				coast.lineTo(to[0] * PX, to[1] * PX)
			})
		})
		state.coast = coast
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
		state.carts = Arr.flatMap(network.roads, ({ link, from, to }): Array<Cart> => {
			if (link.callsPerSecond <= 0) return []
			const busy = Math.log10(1 + link.callsPerSecond)
			const count = Math.min(3, 1 + Math.floor(busy / 1.4))
			return Arr.makeBy(count, (index) => ({
				linkId: link.id,
				from: toPx(from),
				to: toPx(to),
				speed: 0.035 + 0.02 * busy,
				isAiling: ailing(link),
				running: running.get(link.id) === true,
				progress: (index + ((link.id.length * 0.37) % 1)) / count,
			}))
		})
		const rail = railNetwork(
			Arr.map(network.rails, ({ link, points }) => ({ id: link.id, stops: points })),
		)
		state.rails = Arr.map(rail.pieces, (piece) => Arr.map(piece.line, toPx))
		state.buffers = Arr.map(rail.stations, (station) => toPx(station.at))
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

	const fit = () => {
		const { radius, centre: middle } = state.derived
		const wide = Math.min(state.width, state.height) / (2 * radius * PX + RIM * 2)
		// A whole number of device pixels per art pixel wherever the board is big enough for it.
		state.scale = wide >= 1 ? Math.floor(wide) : wide
		state.x = Math.round(state.width / 2 - middle[0] * PX * state.scale)
		state.y = Math.round(state.height / 2 - middle[1] * PX * state.scale)
	}

	const zoomAt = (factor: number, sx: number, sy: number) => {
		const least = Math.min(state.width, state.height) / (2 * state.derived.radius * PX) / 1.6
		const raw = Math.min(6, Math.max(least, state.scale * factor))
		const whole = Math.round(raw)
		const next = whole >= 1 && Math.abs(raw - whole) < 0.09 ? whole : raw
		state.x = Math.round(sx - ((sx - state.x) / state.scale) * next)
		state.y = Math.round(sy - ((sy - state.y) / state.scale) * next)
		state.scale = next
		state.userMoved = true
		invalidate()
	}

	const resize = () => {
		const bounds = container.getBoundingClientRect()
		state.ratio = Math.min(Math.max(1, window.devicePixelRatio), 2)
		state.width = Math.max(1, Math.round(bounds.width * state.ratio))
		state.height = Math.max(1, Math.round(bounds.height * state.ratio))
		canvas.width = state.width
		canvas.height = state.height
		canvas.style.width = `${bounds.width}px`
		canvas.style.height = `${bounds.height}px`
		dark.width = Math.ceil(state.width / 2)
		dark.height = Math.ceil(state.height / 2)
		invalidate()
	}

	const rig = () => {
		const { input, radius, centre: middle } = state.derived
		const key = `${middle[0].toFixed(2)}:${middle[1].toFixed(2)}:${radius}:${state.width}:${state.height}`
		const fresh = input.command.serial !== state.lastCommand
		state.lastCommand = input.command.serial
		if (fresh && input.command.action === "reset") state.userMoved = false
		if (
			(state.fitKey !== key && !state.userMoved) ||
			state.fitKey === "" ||
			(fresh && input.command.action === "reset")
		)
			fit()
		state.fitKey = key
		if (fresh && input.command.action !== "reset")
			zoomAt(input.command.action === "in" ? 1.3 : 1 / 1.3, state.width / 2, state.height / 2)
	}

	const draw = (sprite: Sprite) => {
		const [sx, sy, w, h] = SPRITES[sprite.sprite]
		const x = Math.round(sprite.x - w / 2)
		const y = Math.round(sprite.y - h - (sprite.lift ?? 0))
		if (sprite.flip !== true) return ctx.drawImage(atlas, sx, sy, w, h, x, y, w, h)
		ctx.save()
		ctx.translate(x + w, y)
		ctx.scale(-1, 1)
		ctx.drawImage(atlas, sx, sy, w, h, 0, 0, w, h)
		ctx.restore()
	}

	const fill = (ground: GroundName, path: Path2D) => {
		const pattern = patterns.get(ground)
		if (pattern === undefined) return
		ctx.fillStyle = pattern
		ctx.fill(path)
	}

	const circle = (x: number, y: number, radius: number): Path2D => {
		const path = new Path2D()
		path.arc(Math.round(x), Math.round(y), radius, 0, Math.PI * 2)
		return path
	}

	const line = (points: ReadonlyArray<Point>): Path2D => {
		const path = new Path2D()
		Arr.forEach(points, ([x, y], index) => (index === 0 ? path.moveTo(x, y) : path.lineTo(x, y)))
		return path
	}

	const drawLand = (land: Land) => {
		fill(land.art.ground, hexPath(land.at, 1))
		Arr.forEach(land.art.patches, (patch) =>
			fill(patch.ground, circle(land.at[0] + patch.x, land.at[1] + patch.y, patch.radius)),
		)
	}

	/** Carts and trains move on, and everything that moves is listed for drawing and for clicks. */
	const movers = (delta: number): Array<Sprite & { readonly ailing?: string | null }> => {
		const { input } = state.derived
		const sprites: Array<Sprite & { readonly ailing?: string | null }> = []
		state.hot = []
		Arr.forEach(state.carts, (cart) => {
			if (input.flowing && cart.running) cart.progress = (cart.progress + delta * cart.speed) % 1
			const out = cart.progress < 0.5
			const t = out ? cart.progress * 2 : 2 - cart.progress * 2
			const [dx, dy] = [cart.to[0] - cart.from[0], cart.to[1] - cart.from[1]]
			const length = Math.hypot(dx, dy)
			// Clear of both squares, and on the right of the road each way.
			const along = 26 + t * (length - 52)
			const side = out ? 7 : -7
			const x = cart.from[0] + (dx / length) * along - (dy / length) * side
			const y = cart.from[1] + (dy / length) * along + (dx / length) * side
			sprites.push({ sprite: "cart", x, y: y + 8, flip: (out ? dx : -dx) < 0, ailing: cart.isAiling })
			state.hot.push({ x, y: y - 6, linkId: cart.linkId, kind: "cart" })
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
				const [x, y] = toPx(found.at)
				return { x, y, flip: found.dx < 0 }
			}
			const nose = place(train.along)
			sprites.push({
				sprite: "loco",
				x: nose.x,
				y: nose.y + 8,
				flip: nose.flip,
				ailing: engine.isAiling,
			})
			state.hot.push({ x: nose.x, y: nose.y - 10, linkId: engine.linkId, kind: "train" })
			Arr.forEach(wagonsOf(train), (wagon) => {
				const at = place(train.along - wagon * COUPLING)
				sprites.push({
					sprite: isLoaded(train) ? "wagonFull" : "wagonEmpty",
					x: at.x,
					y: at.y + 8,
					flip: at.flip,
				})
				state.hot.push({ x: at.x, y: at.y - 8, linkId: engine.linkId, kind: "train" })
			})
			Arr.forEach(signalsOf(train.line), (signal) => {
				const found = pointAlong(path, signal.along)
				const [x, y] = toPx(found.at)
				const length = Math.hypot(found.dx, found.dy)
				const isRed = Arr.some(signal.guards, (section) => state.box?.isOccupied(section) === true)
				sprites.push({
					sprite: isRed ? "signalRed" : "signalGreen",
					x: x - (found.dy / length) * 16 * signal.side,
					y: y + (found.dx / length) * 16 * signal.side + 6,
				})
			})
		})
		return sprites
	}

	const ducks = (): Array<Sprite> => {
		const first = state.derived.lakes[0]
		if (first === undefined) return []
		const [cx, cy] = centre(first)
		return Arr.map([0.1, 0.42, 0.74], (phase, index) => {
			const turn = (phase + state.seconds * 0.02) * Math.PI * 2
			const hop = Math.max(0, 1 - (state.seconds - (state.hops[index] ?? -9)) / 0.45)
			return {
				sprite: "duck",
				x: cx + Math.cos(turn) * DUCK_LOOP * (0.7 + index * 0.25),
				y: cy + Math.sin(turn) * DUCK_LOOP * (0.55 + index * 0.2) + 6,
				flip: Math.sin(turn) > 0,
				lift: Math.sin(Math.PI * hop) * 10,
			}
		})
	}

	const isBirdStartled = (): boolean =>
		Arr.some(state.birds, (bird) => state.seconds - bird.startledAt < BIRD_FRIGHT)
	/** Where the birds are: a startled one beats its wings fast and climbs for a moment. */
	const birds = (): Array<Sprite> =>
		Arr.map(state.birds, (bird, index) => {
			const middle = toPx(state.derived.centre)
			const span = state.derived.radius * PX * 2.6
			const u = bird.turn % 1
			const fright = Math.max(0, 1 - (state.seconds - bird.startledAt) / BIRD_FRIGHT)
			const isUp = Math.floor(state.seconds * (fright > 0 ? 12 : 5) + index) % 2 === 0
			return {
				sprite: isUp ? "birdUp" : "birdDown",
				x: middle[0] - span / 2 + u * span + (index % 2) * 30,
				y:
					middle[1] -
					span * 0.28 +
					index * 150 +
					Math.sin(u * 9 + index) * 24 -
					Math.sin(Math.PI * fright) * 70,
			}
		})

	const placeLabels = () => {
		const { input, nodes, related, cells } = state.derived
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
		const [w, h] = [state.width / state.ratio, state.height / state.ratio]
		Arr.forEach(labels, ({ id, element }) => {
			const cell = cells.get(id)
			if (cell === undefined || id === input.heldId) {
				element.style.visibility = "hidden"
				return
			}
			const [x, y] = centre(cell)
			const left = (x * state.scale + state.x) / state.ratio
			const top = ((y + INRADIUS * 0.7) * state.scale + state.y) / state.ratio
			const [width, height] = [element.offsetWidth, element.offsetHeight]
			const hidden =
				left < width / 2 ||
				left > w - width / 2 ||
				top < 0 ||
				top > h - height ||
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

	/** Night falls as a dark veil with a hole of lamplight over every village; a low sun warms it. */
	const light = () => {
		const { input } = state.derived
		const day = daylightAt({ ...input.clock, hour: state.shownHour })
		const low = Math.max(0, 1 - Math.abs(day.elevation - 4) / 14) * (1 - day.lamps)
		ctx.setTransform(1, 0, 0, 1, 0, 0)
		ctx.globalCompositeOperation = "source-atop"
		if (low > 0.01) {
			ctx.fillStyle = `rgba(255, 126, 40, ${(low * 0.2).toFixed(3)})`
			ctx.fillRect(0, 0, state.width, state.height)
		}
		if (day.lamps > 0.01) {
			const veil = dark.getContext("2d")
			if (veil !== null) {
				veil.setTransform(1, 0, 0, 1, 0, 0)
				veil.globalCompositeOperation = "source-over"
				veil.clearRect(0, 0, dark.width, dark.height)
				veil.fillStyle = `rgba(16, 22, 62, ${(day.lamps * 0.62).toFixed(3)})`
				veil.fillRect(0, 0, dark.width, dark.height)
				veil.globalCompositeOperation = "destination-out"
				Arr.forEach(state.lamps, (lamp) => {
					const [x, y] = [
						(lamp.x * state.scale + state.x) / 2,
						(lamp.y * state.scale + state.y) / 2,
					]
					const radius = (lamp.radius * state.scale) / 2
					const glow = veil.createRadialGradient(x, y, 0, x, y, radius)
					glow.addColorStop(0, "rgba(0, 0, 0, 0.95)")
					glow.addColorStop(0.45, "rgba(0, 0, 0, 0.6)")
					glow.addColorStop(1, "rgba(0, 0, 0, 0)")
					veil.fillStyle = glow
					veil.fillRect(x - radius, y - radius, radius * 2, radius * 2)
				})
				ctx.imageSmoothingEnabled = true
				ctx.drawImage(dark, 0, 0, dark.width, dark.height, 0, 0, state.width, state.height)
			}
			// The lamplight itself: a little warmth added where the veil was opened.
			ctx.globalCompositeOperation = "lighter"
			Arr.forEach(state.lamps, (lamp) => {
				const [x, y] = [lamp.x * state.scale + state.x, lamp.y * state.scale + state.y]
				const radius = lamp.radius * state.scale * 0.7
				const glow = ctx.createRadialGradient(x, y, 0, x, y, radius)
				glow.addColorStop(0, `rgba(255, 176, 72, ${(day.lamps * 0.24).toFixed(3)})`)
				glow.addColorStop(1, "rgba(255, 176, 72, 0)")
				ctx.fillStyle = glow
				ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2)
			})
		}
		// A lighthouse turns its beam over the land after dark.
		if (day.lamps > 0.01) {
			ctx.globalCompositeOperation = "source-atop"
			Arr.forEach(state.lands, (land) => {
				const tower = land.art.landmark
				if (tower === null || tower.kind !== "lighthouse") return
				const x = (land.at[0] + tower.x) * state.scale + state.x
				const y = (land.at[1] + tower.y - SPRITES.lighthouse[3] + 14) * state.scale + state.y
				const turn = state.seconds * 0.7
				const reach = 270 * state.scale
				const beam = ctx.createRadialGradient(x, y, 0, x, y, reach)
				beam.addColorStop(0, `rgba(255, 226, 150, ${(day.lamps * 0.55).toFixed(3)})`)
				beam.addColorStop(1, "rgba(255, 226, 150, 0)")
				ctx.fillStyle = beam
				ctx.beginPath()
				ctx.moveTo(x, y)
				ctx.arc(x, y, reach, turn - 0.2, turn + 0.2)
				ctx.closePath()
				ctx.fill()
			})
		}
		ctx.globalCompositeOperation = "source-over"
	}

	const render = (delta: number) => {
		const { input, cells, nodes, related, targets, links, palette } = state.derived
		rig()
		ctx.setTransform(1, 0, 0, 1, 0, 0)
		ctx.globalCompositeOperation = "source-over"
		ctx.clearRect(0, 0, state.width, state.height)
		ctx.setTransform(state.scale, 0, 0, state.scale, state.x, state.y)
		// Nearest-neighbour when a pixel is a block; smoothed when the whole board is shrunk to fit.
		ctx.imageSmoothingEnabled = state.scale < 1
		ctx.imageSmoothingQuality = "high"
		// The earth under the board, showing along its southern edge.
		Arr.forEach(state.lands, (land) => {
			ctx.fillStyle = SOIL_SHADE
			ctx.fill(hexPath([land.at[0], land.at[1] + RIM], 1))
			ctx.fillStyle = SOIL
			ctx.fill(hexPath([land.at[0], land.at[1] + RIM * 0.55], 1))
		})
		Arr.forEach(state.lands, drawLand)
		// Roads: a dark edge under a strip of trodden earth.
		const { network } = state.derived
		ctx.lineCap = "round"
		Arr.forEach(network.roads, ({ from, to }) => {
			const road = line([toPx(from), toPx(to)])
			ctx.strokeStyle = "#8b6a44"
			ctx.lineWidth = 30
			ctx.stroke(road)
			ctx.strokeStyle = patterns.get("dirt") ?? "#c79a63"
			ctx.lineWidth = 25
			ctx.stroke(road)
		})
		// Railways: a gravel bed, sleepers as dashes across it, and two rails.
		ctx.lineCap = "butt"
		ctx.lineJoin = "round"
		Arr.forEach(state.rails, (piece) => {
			const track = line(piece)
			ctx.setLineDash([])
			ctx.strokeStyle = "#9c8f7c"
			ctx.lineWidth = 18
			ctx.stroke(track)
			ctx.setLineDash([4, 6])
			ctx.strokeStyle = "#6b4a2e"
			ctx.lineWidth = 16
			ctx.stroke(track)
			ctx.setLineDash([])
			ctx.strokeStyle = "#3d3540"
			ctx.lineWidth = 10
			ctx.stroke(track)
			ctx.strokeStyle = "#9c8f7c"
			ctx.lineWidth = 6
			ctx.stroke(track)
			ctx.setLineDash([4, 6])
			ctx.strokeStyle = "#6b4a2e"
			ctx.stroke(track)
			ctx.setLineDash([])
		})
		// A city's wall: a ring of stone round the town, open where a road or a railway leaves.
		Arr.forEach(state.lands, (land) => {
			const radius = land.art.wall
			if (radius === 0) return
			const gates = Arr.sort(
				land.id === null ? [] : (network.corridors.get(land.id) ?? []),
				Order.Number,
			)
			const gate = Math.asin(Math.min(1, 26 / radius))
			const ring = new Path2D()
			if (gates.length === 0) ring.arc(land.at[0], land.at[1], radius, 0, Math.PI * 2)
			Arr.forEach(gates, (way, index) => {
				const next = gates[(index + 1) % gates.length] ?? way
				const from = way + gate
				const to = (index === gates.length - 1 ? next + Math.PI * 2 : next) - gate
				if (to <= from) return
				ring.moveTo(land.at[0] + Math.cos(from) * radius, land.at[1] + Math.sin(from) * radius)
				ring.arc(land.at[0], land.at[1], radius, from, to)
			})
			ctx.lineCap = "butt"
			ctx.strokeStyle = OUTLINE
			ctx.lineWidth = 12
			ctx.stroke(ring)
			ctx.strokeStyle = "#b9ad9a"
			ctx.lineWidth = 8
			ctx.stroke(ring)
			// Lighter stones along the top, as battlements.
			ctx.setLineDash([6, 6])
			ctx.strokeStyle = "#ded5c5"
			ctx.lineWidth = 4
			ctx.stroke(ring)
			ctx.setLineDash([])
		})
		ctx.strokeStyle = OUTLINE
		ctx.lineWidth = 2
		ctx.lineCap = "round"
		ctx.stroke(state.coast)
		// Health and selection ring the tile; the tile under the pointer gets a pale one.
		Arr.forEach([...cells], ([id, cell]) => {
			if (id === input.heldId) return
			const node = nodes.get(id)
			const level = node === undefined ? "healthy" : health(node.errorRate)
			const isSelected = id === input.selectedId
			if (!isSelected && level === "healthy") return
			ctx.strokeStyle = isSelected ? palette.selected : HEALTH_COLOR[level]
			ctx.lineWidth = isSelected ? 7 : 4
			ctx.stroke(hexPath(centre(cell), -5))
		})
		if (state.hoverTile !== null && input.heldId === null) {
			ctx.strokeStyle = "rgba(255, 255, 255, 0.9)"
			ctx.lineWidth = 3
			ctx.stroke(hexPath(centre(state.hoverTile), -4))
		}
		// Rings on the water.
		state.rings = Arr.filter(state.rings, (ring) => state.seconds - ring.since < 1)
		Arr.forEach(state.rings, (ring) => {
			const u = state.seconds - ring.since
			ctx.strokeStyle = `rgba(255, 255, 255, ${(0.8 * (1 - u)).toFixed(3)})`
			ctx.lineWidth = 2
			ctx.stroke(circle(ring.at[0], ring.at[1], 6 + u * 34))
		})
		// Everything that stands up, north to south, so what is nearer covers what is behind.
		const moving = movers(delta)
		const standing = [
			...state.statics,
			...Arr.map(state.buffers, ([x, y]): Sprite => ({ sprite: "buffer", x, y: y + 10 })),
			...moving,
			...ducks(),
		]
		Arr.forEach(
			Arr.sort(
				standing,
				Order.mapInput(Order.Number, (sprite: Sprite) => sprite.y),
			),
			draw,
		)
		// A failing link's cart or engine carries its health colour as a dot above it.
		Arr.forEach(moving, (sprite) => {
			if (sprite.ailing === undefined || sprite.ailing === null) return
			ctx.fillStyle = OUTLINE
			ctx.fill(circle(sprite.x, sprite.y - SPRITES[sprite.sprite][3] - 6, 5))
			ctx.fillStyle = sprite.ailing
			ctx.fill(circle(sprite.x, sprite.y - SPRITES[sprite.sprite][3] - 6, 3.5))
		})
		// Tiles that have nothing to do with the selected service fall back.
		if (related !== null)
			Arr.forEach([...cells], ([id, cell]) => {
				if (related.has(id) || id === input.heldId) return
				ctx.fillStyle = "rgba(236, 236, 228, 0.55)"
				ctx.fill(hexPath(centre(cell), 1))
			})
		// Birds cross the board, flapping; a startled one hurries on.
		Arr.forEach(state.birds, (bird) => {
			const isStartled = state.seconds - bird.startledAt < BIRD_FRIGHT
			if (input.flowing || isStartled) bird.turn += delta * (isStartled ? 0.16 : 0.03)
		})
		if (input.flowing || isBirdStartled()) Arr.forEach(birds(), draw)
		light()
		// What is in hand is drawn over the night, so it reads at any hour.
		ctx.setTransform(state.scale, 0, 0, state.scale, state.x, state.y)
		ctx.imageSmoothingEnabled = state.scale < 1
		// Where a held tile may go, and which of those cells the pointer is over.
		Arr.forEach(targets?.free ?? [], (cell) => {
			const plate = hexPath(centre(cell), -4)
			ctx.fillStyle = "rgba(246, 236, 212, 0.85)"
			ctx.fill(plate)
			ctx.setLineDash([8, 6])
			ctx.strokeStyle = palette.slotEdge
			ctx.lineWidth = 2
			ctx.stroke(plate)
			ctx.setLineDash([])
		})
		if (state.hoverCell !== null && input.heldId !== null) {
			const [x, y] = centre(state.hoverCell)
			ctx.fillStyle = "rgba(245, 165, 36, 0.55)"
			ctx.fill(hexPath([x, y], -4))
			Arr.forEach(links, (link) => {
				const other =
					link.source === input.heldId
						? link.target
						: link.target === input.heldId
							? link.source
							: null
				const at = other === null ? undefined : cells.get(other)
				if (at === undefined || state.hoverCell === null || sameCell(at, state.hoverCell)) return
				const touching = hexDistance(at, state.hoverCell) === 1
				ctx.strokeStyle = touching ? palette.selected : "rgba(120, 100, 80, 0.7)"
				ctx.lineWidth = touching ? 12 : 3
				ctx.stroke(line([[x, y], centre(at)]))
			})
		}
		// The tile in hand follows the pointer, lifted off the board.
		// One moved by the keyboard has no pointer to follow: it stands over the place chosen.
		const under = state.hoverCell !== null ? centre(state.hoverCell) : state.pointer
		if (input.heldId !== null && under !== null) {
			const node = nodes.get(input.heldId)
			const at: Point = [under[0], under[1] - 22]
			if (node !== undefined) {
				const art = serviceArt({
					id: input.heldId,
					kind: node.kind,
					size: state.derived.sizes.get(input.heldId) ?? 0.5,
					biome: biomeOf(state.derived.biomes, node.namespace),
					corridors: [],
				})
				ctx.fillStyle = "rgba(30, 20, 30, 0.25)"
				ctx.fill(hexPath([at[0], at[1] + 30], 1))
				drawLand({ key: "held", at, art, id: input.heldId })
				ctx.strokeStyle = OUTLINE
				ctx.lineWidth = 2
				ctx.stroke(hexPath(at, 1))
				Arr.forEach(
					Arr.sort(
						Arr.map(art.items, (item): Sprite => ({
							...item,
							x: at[0] + item.x,
							y: at[1] + item.y,
						})),
						Order.mapInput(Order.Number, (sprite: Sprite) => sprite.y),
					),
					draw,
				)
			}
		}
		placeLabels()
	}

	const loop = (now: number) => {
		state.raf = requestAnimationFrame(loop)
		const { input } = state.derived
		// The hour shown turns towards the wanted one, so a change of light sweeps across.
		const apart = ((((input.clock.hour - state.shownHour) % 24) + 36) % 24) - 12
		const turning = Math.abs(apart) > 1e-3
		const playing =
			turning ||
			state.rings.length > 0 ||
			isBirdStartled() ||
			Arr.some(state.hops, (at) => state.seconds - at < 0.5)
		if (!state.dirty && !playing && !(input.flowing && now - state.last >= FRAME_MS)) return
		const delta = Math.min(0.05, (now - state.last) / 1000)
		state.last = now
		state.dirty = false
		if (turning) {
			const step = Math.min(Math.abs(apart), delta * Math.max(8, Math.abs(apart) * 3))
			state.shownHour = (((state.shownHour + Math.sign(apart) * step) % 24) + 24) % 24
		}
		if (input.flowing || playing) state.seconds += delta
		if (atlas.complete && atlas.naturalWidth > 0) render(delta)
	}

	/** The pointer's place on the board, in art pixels. */
	const artAt = (event: MouseEvent): Point => {
		const bounds = canvas.getBoundingClientRect()
		return [
			((event.clientX - bounds.left) * state.ratio - state.x) / state.scale,
			((event.clientY - bounds.top) * state.ratio - state.y) / state.scale,
		]
	}
	const cellAt = ([x, y]: Point): Cell => pointToCell([x / PX, y / PX])
	const serviceAt = (point: Point): string | null => {
		const cell = cellAt(point)
		const found = Arr.findFirst(
			[...state.derived.cells],
			([id, at]) => id !== state.derived.input.heldId && sameCell(at, cell),
		)
		return Option.getOrNull(Option.map(found, ([id]) => id))
	}
	const targetAt = (point: Point): Cell | null => {
		const { targets, cells, input } = state.derived
		if (targets === null || input.heldId === null) return null
		const cell = cellAt(point)
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
		if (changed) events.onHover(cell)
	}
	const moverAt = ([x, y]: Point): Hot | null =>
		Option.getOrNull(Arr.findFirst(state.hot, (hot) => Math.hypot(hot.x - x, hot.y - y) < 24))
	const duckAt = ([x, y]: Point): number | null =>
		Option.getOrNull(Arr.findFirstIndex(ducks(), (duck) => Math.hypot(duck.x - x, duck.y - 8 - y) < 16))
	/** The bird under the pointer, while the birds are out. */
	const birdAt = ([x, y]: Point): number | null =>
		state.derived.input.flowing || isBirdStartled()
			? Option.getOrNull(
					Arr.findFirstIndex(birds(), (bird) => Math.hypot(bird.x - x, bird.y - 10 - y) < 22),
				)
			: null
	const lakeAt = (point: Point): boolean => {
		const cell = cellAt(point)
		const [cx, cy] = centre(cell)
		return (
			Arr.some(state.derived.lakes, (lake) => sameCell(lake, cell)) &&
			Math.hypot(point[0] - cx, point[1] - cy) < 100
		)
	}

	const onPointerDown = (event: PointerEvent) => {
		state.pressed = { x: event.clientX, y: event.clientY, panning: false }
	}
	const onPointerMove = (event: PointerEvent) => {
		const point = artAt(event)
		state.pointer = point
		const { input } = state.derived
		const dragged = Math.hypot(event.clientX - state.pressed.x, event.clientY - state.pressed.y)
		if (event.buttons !== 0 && (state.pressed.panning || dragged > DRAG_TOLERANCE)) {
			state.pressed.panning = true
			state.x += Math.round(event.movementX * state.ratio)
			state.y += Math.round(event.movementY * state.ratio)
			state.userMoved = true
			canvas.style.cursor = "grabbing"
			return invalidate()
		}
		if (input.heldId !== null) {
			const cell = targetAt(point)
			setHover(cell)
			canvas.style.cursor = cell === null ? "grabbing" : "copy"
			return invalidate()
		}
		const id = serviceAt(point)
		const lively =
			moverAt(point) !== null || duckAt(point) !== null || birdAt(point) !== null || lakeAt(point)
		canvas.style.cursor = lively || id !== null ? "pointer" : ""
		const hover = id === null || lively ? null : (state.derived.cells.get(id) ?? null)
		if (
			(hover === null ? "" : cellKey(hover)) !==
			(state.hoverTile === null ? "" : cellKey(state.hoverTile))
		)
			invalidate()
		state.hoverTile = hover
	}
	const onClick = (event: MouseEvent) => {
		if (state.pressed.panning) return
		const { input } = state.derived
		const point = artAt(event)
		if (input.heldId !== null) {
			const cell = targetAt(point)
			if (cell !== null) events.onPlace(input.heldId, cell)
			return
		}
		const duck = duckAt(point)
		if (duck !== null) {
			state.hops[duck] = state.seconds
			if (!input.muted) quacks.quack(2)
			return invalidate()
		}
		const bird = birdAt(point)
		if (bird !== null) {
			const startled = state.birds[bird]
			if (startled !== undefined) startled.startledAt = state.seconds
			sounds.chirp(3)
			return invalidate()
		}
		const mover = input.building ? null : moverAt(point)
		if (mover !== null) {
			if (mover.kind === "train") sounds.whistle()
			else sounds.ding()
			return events.onPokeLink(mover.linkId)
		}
		const id = serviceAt(point)
		if (input.building) {
			if (id !== null) events.onPickUp(id)
			return
		}
		if (id === null && lakeAt(point)) {
			state.rings.push({ at: point, since: state.seconds })
			sounds.splash()
			return invalidate()
		}
		// A church rings its bell and the birds take fright; a lighthouse sounds its horn. The
		// click still selects the service.
		const land = Option.getOrUndefined(
			Arr.findFirst(state.lands, (each) => each.id !== null && each.id === id),
		)
		const tower = land?.art.landmark ?? null
		if (
			land !== undefined &&
			tower !== null &&
			Math.hypot(point[0] - land.at[0] - tower.x, point[1] - land.at[1] - tower.y + 30) < 40
		) {
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
	const onWheel = (event: WheelEvent) => {
		event.preventDefault()
		const bounds = canvas.getBoundingClientRect()
		zoomAt(
			Math.exp(-event.deltaY * 0.0022),
			(event.clientX - bounds.left) * state.ratio,
			(event.clientY - bounds.top) * state.ratio,
		)
	}
	const onLeave = () => {
		state.hoverTile = null
		invalidate()
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
			setHover(keyedTarget(state.derived, state.hoverCell, arrow))
			return invalidate()
		}
		if (event.key === "Enter" && state.hoverCell !== null) {
			event.preventDefault()
			events.onPlace(input.heldId, state.hoverCell)
		}
	}
	// A wheel over a name plate or a panel still zooms: only the canvas hears it otherwise.
	const onRootWheel = (event: Event) => {
		if (event.target === canvas || !(event instanceof WheelEvent)) return
		onWheel(event)
	}
	canvas.addEventListener("pointerdown", onPointerDown)
	canvas.addEventListener("pointermove", onPointerMove)
	canvas.addEventListener("pointerleave", onLeave)
	canvas.addEventListener("click", onClick)
	canvas.addEventListener("wheel", onWheel, { passive: false })
	labelsRoot.addEventListener("wheel", onRootWheel, { passive: false })
	window.addEventListener("keydown", onKeyDown)
	const observer = new ResizeObserver(resize)
	observer.observe(container)
	const sync = () => {
		syncBoard()
		syncTraffic()
		invalidate()
	}
	resize()
	sync()
	state.raf = requestAnimationFrame(loop)
	return {
		update: (input) => {
			const previous = state.derived
			state.derived = derive(input, previous)
			if (previous.input.heldId !== input.heldId || previous.input.cells !== input.cells)
				state.hoverCell = null
			sync()
		},
		stop: () => {
			cancelAnimationFrame(state.raf)
			observer.disconnect()
			canvas.removeEventListener("pointerdown", onPointerDown)
			canvas.removeEventListener("pointermove", onPointerMove)
			canvas.removeEventListener("pointerleave", onLeave)
			canvas.removeEventListener("click", onClick)
			canvas.removeEventListener("wheel", onWheel)
			labelsRoot.removeEventListener("wheel", onRootWheel)
			window.removeEventListener("keydown", onKeyDown)
			quacks.close()
			sounds.close()
		},
	}
}

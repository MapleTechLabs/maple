import { Array as Arr, Order } from "effect"
import { SPRITES } from "./art/sprites.generated"
import { corners, type Point } from "./hex"
import { CORNER, type GroundName, INRADIUS, PX, type TileArt } from "./pixel-layout"

// The ground of the pixel-art map, painted flat: every tile's turf and patches, the roads and
// the railways. The 3D scene lays the painting over its tiles as one texture, a texel to an
// art pixel wherever the board is small enough for that.

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
/** The widest a painting may be, in texels: every GPU a browser runs on takes this much. */
const WIDEST = 4096
const MARGIN = 4

/** One tile of the board: where its middle is in art pixels, and what is on it. */
export interface Land {
	readonly key: string
	readonly at: Point
	readonly art: TileArt
	/** The service standing on it; `null` for open country and lakes. */
	readonly id: string | null
}

/** Where a painting lies on the board: the art pixel at its top left corner, its size in art
 * pixels, and how many texels it has to an art pixel. */
export interface Frame {
	readonly origin: Point
	readonly size: Point
	readonly scale: number
}

export interface Painter {
	/** Paints the whole board on `canvas`, sized to fit it. */
	readonly board: (
		canvas: HTMLCanvasElement,
		lands: ReadonlyArray<Land>,
		roads: ReadonlyArray<readonly [Point, Point]>,
		rails: ReadonlyArray<ReadonlyArray<Point>>,
	) => Frame
	/** Paints one tile on its own, for the tile in hand. */
	readonly tile: (canvas: HTMLCanvasElement, art: TileArt) => Frame
}

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

const line = (points: ReadonlyArray<Point>): Path2D => {
	const path = new Path2D()
	Arr.forEach(points, ([x, y], index) => (index === 0 ? path.moveTo(x, y) : path.lineTo(x, y)))
	return path
}

/** A painter that takes its turf from `atlas`, which must already be loaded. */
export const makePainter = (atlas: HTMLImageElement): Painter => {
	const patterns = new Map<GroundName, CanvasPattern>()
	const scratch = document.createElement("canvas").getContext("2d")
	Arr.forEach(GROUNDS, (name) => {
		const [sx, sy, w, h] = SPRITES[name]
		const swatch = document.createElement("canvas")
		swatch.width = w
		swatch.height = h
		swatch.getContext("2d")?.drawImage(atlas, sx, sy, w, h, 0, 0, w, h)
		const pattern = scratch?.createPattern(swatch, "repeat") ?? null
		if (pattern !== null) patterns.set(name, pattern)
	})

	/** Sizes `canvas` to hold `size` art pixels from `origin` and returns a context drawing in them. */
	const open = (canvas: HTMLCanvasElement, origin: Point, size: Point) => {
		const scale = Math.min(1, WIDEST / Math.max(size[0], size[1]))
		canvas.width = Math.max(1, Math.ceil(size[0] * scale))
		canvas.height = Math.max(1, Math.ceil(size[1] * scale))
		const ctx = canvas.getContext("2d")
		if (ctx !== null) {
			ctx.setTransform(scale, 0, 0, scale, -origin[0] * scale, -origin[1] * scale)
			ctx.imageSmoothingEnabled = scale < 1
		}
		return { ctx, frame: { origin, size, scale } }
	}

	const turf = (ctx: CanvasRenderingContext2D, land: Land) => {
		const fill = (ground: GroundName, path: Path2D) => {
			const pattern = patterns.get(ground)
			if (pattern === undefined) return
			ctx.fillStyle = pattern
			ctx.fill(path)
		}
		ctx.save()
		// A patch never spills onto the tile next door.
		ctx.clip(hexPath(land.at, 1))
		fill(land.art.ground, hexPath(land.at, 1))
		Arr.forEach(land.art.patches, (patch) => {
			const blob = new Path2D()
			blob.arc(
				Math.round(land.at[0] + patch.x),
				Math.round(land.at[1] + patch.y),
				patch.radius,
				0,
				Math.PI * 2,
			)
			fill(patch.ground, blob)
		})
		ctx.restore()
	}

	return {
		board: (canvas, lands, roads, rails) => {
			const xs = Arr.map(lands, (land) => land.at[0])
			const ys = Arr.map(lands, (land) => land.at[1])
			const origin: Point = [
				Math.floor(Math.min(0, ...xs) - INRADIUS - MARGIN),
				Math.floor(Math.min(0, ...ys) - CORNER - MARGIN),
			]
			const size: Point = [
				Math.ceil(Math.max(0, ...xs) + INRADIUS + MARGIN) - origin[0],
				Math.ceil(Math.max(0, ...ys) + CORNER + MARGIN) - origin[1],
			]
			const { ctx, frame } = open(canvas, origin, size)
			if (ctx === null) return frame
			Arr.forEach(lands, (land) => turf(ctx, land))
			// Roads: a dark edge under a strip of trodden earth.
			ctx.lineCap = "round"
			Arr.forEach(roads, (ends) => {
				const road = line(ends)
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
			Arr.forEach(rails, (piece) => {
				const track = line(piece)
				const lay = (color: string, width: number, dash: ReadonlyArray<number>) => {
					ctx.setLineDash([...dash])
					ctx.strokeStyle = color
					ctx.lineWidth = width
					ctx.stroke(track)
				}
				lay("#9c8f7c", 18, [])
				lay("#6b4a2e", 16, [4, 6])
				lay("#3d3540", 10, [])
				lay("#9c8f7c", 6, [])
				lay("#6b4a2e", 6, [4, 6])
				ctx.setLineDash([])
			})
			return frame
		},
		tile: (canvas, art) => {
			const origin: Point = [-INRADIUS - MARGIN, -CORNER - MARGIN]
			const size: Point = [(INRADIUS + MARGIN) * 2, (CORNER + MARGIN) * 2]
			const { ctx, frame } = open(canvas, origin, size)
			if (ctx === null) return frame
			turf(ctx, { key: "held", at: [0, 0], art, id: null })
			ctx.strokeStyle = OUTLINE
			ctx.lineWidth = 2
			ctx.stroke(hexPath([0, 0], 1))
			return frame
		},
	}
}

/** North to south, as the tiles were laid in the flat painting. */
export const northFirst = (lands: ReadonlyArray<Land>): Array<Land> =>
	Arr.sort(
		lands,
		Order.mapInput(Order.Number, (land: Land) => land.at[1]),
	)

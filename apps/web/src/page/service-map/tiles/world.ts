import { Array as Arr, Record as Rec } from "effect"
import { connectedIds } from "../three/spatial-layout"
import type { Node3D, Topology3D } from "../three/types"
import { type Biome, biomesFor } from "./biome"
import {
	lakesOf,
	type Link,
	linksOf,
	type Placements,
	placesOf,
	stepTarget,
	targetsFor,
	type Targets,
	type Wild,
	wildsOf,
} from "./board"
import type { Clock } from "./daylight"
import { type Cell, cellToPoint, HEX_SIZE, NEIGHBOUR_DISTANCE, type Point } from "./hex"
import { type Network, networkOf } from "./network"
import { type TilePalette, tilePalette } from "./palette"

// What the scene draws from: its input, the events it sends back, and everything
// worked out from the input once (links, biomes, lakes, open country, roads and railways).

export interface CameraCommand {
	readonly action: "reset" | "in" | "out"
	readonly serial: number
}

export interface SceneInput {
	readonly topology: Topology3D
	/** Tiles on the board, by node id. A node without a cell is still in the stack. */
	readonly cells: Readonly<Record<string, Cell>>
	readonly selectedId: string | null
	/** The tile in hand: it follows the pointer until it is put down. */
	readonly heldId: string | null
	/** Rearranging: a click picks a tile up instead of selecting it. */
	readonly building: boolean
	readonly flowing: boolean
	readonly dark: boolean
	/** The time of day the map is lit for: the viewer's own, or one held from the toolbar. */
	readonly clock: Clock
	/** The map's noises are off: quacks, whistles, bells. */
	readonly muted: boolean
	readonly command: CameraCommand
}

export interface SceneEvents {
	readonly onSelect: (id: string | null) => void
	readonly onPickUp: (id: string) => void
	readonly onPlace: (id: string, cell: Cell) => void
	/** The cell the held tile would land on, or `null` away from every target. */
	readonly onHover: (cell: Cell | null) => void
	readonly onCancel: () => void
	/** A cart or a train was poked: the link it runs on. */
	readonly onPokeLink: (linkId: string) => void
}

export interface SceneHandle {
	readonly update: (input: SceneInput) => void
	readonly stop: () => void
}

export interface Derived {
	readonly input: SceneInput
	readonly palette: TilePalette
	readonly links: ReadonlyArray<Link>
	readonly cells: Placements
	readonly nodes: ReadonlyMap<string, Node3D>
	readonly sizes: ReadonlyMap<string, number>
	readonly related: ReadonlySet<string> | null
	readonly targets: Targets | null
	/** One biome per namespace on the map. */
	readonly biomes: ReadonlyMap<string, Biome>
	/** Cells the land closes in on, flooded on their own; the first holds the ducks. */
	readonly lakes: ReadonlyArray<Cell>
	/** The open country round the tiles. */
	readonly wilds: ReadonlyArray<Wild>
	readonly network: Network
	/** The middle and radius of the circle the camera frames. */
	readonly centre: Point
	readonly radius: number
}

const ARROWS: ReadonlyMap<string, Point> = new Map([
	["ArrowLeft", [-1, 0]],
	["ArrowRight", [1, 0]],
	["ArrowUp", [0, -1]],
	["ArrowDown", [0, 1]],
])

/** The way an arrow key points across the screen, x to the right and y down; `null` for other keys. */
export const arrowOf = (key: string): Point | null => ARROWS.get(key) ?? null

/** Whether a key press is meant for a text field, or is a shortcut with a modifier held. */
export const isTyping = (event: KeyboardEvent): boolean =>
	event.metaKey ||
	event.ctrlKey ||
	event.altKey ||
	(event.target instanceof HTMLElement &&
		(event.target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)))

/** Whether a key press landed on a button or a link, which Enter is meant to press. */
export const isOnControl = (event: KeyboardEvent): boolean =>
	event.target instanceof Element && event.target.closest("button, a[href], [role=button]") !== null

/** Where a keyboard step takes the held tile: one place on in `direction` (a vector on the board)
 * from the place it is over, or from its own cell; a tile off the stack starts at the place
 * nearest the middle of the board. */
export const keyedTarget = (derived: Derived, current: Cell | null, direction: Point): Cell | null => {
	const { targets, cells, input, centre } = derived
	if (targets === null || input.heldId === null) return null
	const places = placesOf(cells, input.heldId, targets)
	const from = current ?? cells.get(input.heldId)
	if (from !== undefined) return stepTarget(places, from, direction)
	const off = (cell: Cell): number => {
		const [x, z] = cellToPoint(cell)
		return Math.hypot(x - centre[0], z - centre[1])
	}
	return Arr.reduce(places, null as Cell | null, (near, cell) =>
		near === null || off(cell) < off(near) - 1e-9 ? cell : near,
	)
}

/** The smallest circle round the tiles (and the cells a held tile may go to), so the view grows
 * as tiles go down. */
const extentOf = (cells: ReadonlyArray<Cell>): { readonly centre: Point; readonly radius: number } => {
	const points = Arr.map(cells, cellToPoint)
	const first = points[0]
	if (first === undefined) return { centre: [0, 0], radius: NEIGHBOUR_DISTANCE }
	const far = (from: Point) =>
		Arr.reduce(points, from, (best, point) =>
			Math.hypot(point[0] - from[0], point[1] - from[1]) >
			Math.hypot(best[0] - from[0], best[1] - from[1])
				? point
				: best,
		)
	// Each step pulls the centre a little less towards the furthest tile; it settles on the middle.
	const centre = Arr.reduce(Arr.range(1, 60), first, (at: Point, step): Point => {
		const furthest = far(at)
		return [at[0] + (furthest[0] - at[0]) / (step + 1), at[1] + (furthest[1] - at[1]) / (step + 1)]
	})
	const furthest = far(centre)
	const reach = Math.hypot(furthest[0] - centre[0], furthest[1] - centre[1])
	// Quarter-tile steps, so the camera refits when the board grows, not on every tile.
	const step = NEIGHBOUR_DISTANCE / 4
	return { centre, radius: Math.ceil((reach + HEX_SIZE * 1.1) / step) * step }
}

export const derive = (input: SceneInput, previous: Derived | null): Derived => {
	const sameTopology = previous !== null && previous.input.topology === input.topology
	const links = sameTopology ? previous.links : linksOf(input.topology)
	const nodes = sameTopology
		? previous.nodes
		: new Map(Arr.map(input.topology.nodes, (node) => [node.id, node] as const))
	const logs = Arr.map(input.topology.nodes, (node) => Math.log10(1 + node.throughput))
	const low = Math.min(...logs)
	const high = Math.max(...logs)
	const sizes = sameTopology
		? previous.sizes
		: new Map(
				Arr.map(input.topology.nodes, (node, index) => [
					node.id,
					high === low ? 0.5 : ((logs[index] ?? low) - low) / (high - low),
				]),
			)
	const sameCells = previous !== null && previous.input.cells === input.cells
	const cells: Placements = sameCells
		? previous.cells
		: new Map(Arr.filter(Rec.toEntries(input.cells), ([id]) => nodes.has(id)))
	const targets = input.heldId === null ? null : targetsFor(cells, input.heldId)
	const sameBoard = sameTopology && sameCells && previous.input.heldId === input.heldId
	const lakes = sameBoard ? previous.lakes : lakesOf(cells, input.heldId ?? undefined)
	const wilds = sameBoard ? previous.wilds : wildsOf(cells, lakes, input.heldId ?? undefined)
	const country = [...lakes, ...Arr.map(wilds, (wild) => wild.cell)]
	return {
		input,
		palette: tilePalette(input.dark),
		links,
		cells,
		nodes,
		sizes,
		related: connectedIds(input.topology, input.selectedId),
		targets,
		biomes: sameTopology
			? previous.biomes
			: biomesFor(Arr.map(input.topology.nodes, (node) => node.namespace)),
		lakes,
		wilds,
		network: sameBoard ? previous.network : networkOf(links, cells, input.heldId, country),
		...extentOf([...cells.values(), ...country]),
	}
}

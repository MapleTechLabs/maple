import { Array as Arr, Effect, Option, Order, Queue, Record as Rec, Schema, Stream } from "effect"
import { Mount, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { SceneStartError, Topology } from "../scene3d"
import type { Topology3D } from "../three/types"
import { autoLayout, dealOrder, linksOf, type Placements, placeTile, prospect } from "./board"
import { Clock, clockOf, hourFor, LIGHT_MODES, LightMode } from "./daylight"
import { Cell, cellKey, ORIGIN } from "./hex"
import type { SceneEvents, SceneHandle, SceneInput } from "./world"

// The service map as a landscape of hex tiles, over whatever topology the parent passes in (the
// live map on the page, a fixture in the lab). This keeps the board: which tile stands on which
// cell, and the stack still to deal. The scene runs in a Mount that `import()`s `./scene`, so
// three stays out of the startup bundle. Selection belongs to the parent.

const CameraCommand = Schema.Struct({
	action: Schema.Literals(["reset", "in", "out"]),
	serial: Schema.Number,
})

export const Model = Schema.Struct({
	/** Tiles on the board, by node id. */
	cells: Schema.Record(Schema.String, Cell),
	/** The services `cells` was laid out for (`layoutKeyOf`); `null` before the first layout. */
	layoutKey: Schema.NullOr(Schema.String),
	/** Where tiles stood when their service left the map (a filter, a quiet window), so they come
	 * back to the same cell. Cleared by a new deal or Auto-arrange. */
	remembered: Schema.Record(Schema.String, Cell),
	/** Tiles still to deal, the next one first. Empty once the map is complete. */
	stack: Schema.Array(Schema.String),
	/** A tile lifted off the board while rearranging. */
	pickedId: Schema.NullOr(Schema.String),
	/** Rearranging: a click picks a tile up instead of selecting its service. */
	isBuilding: Schema.Boolean,
	/** The cell the held tile is over, when it may be put down there. */
	hover: Schema.NullOr(Cell),
	/** Roads the last move gained or lost. */
	lastGain: Schema.NullOr(Schema.Number),
	/** The link whose cart or train was last poked: its card shows until something else is picked. */
	pokedLinkId: Schema.NullOr(Schema.String),
	/** The map's noises are off. */
	isMuted: Schema.Boolean,
	/** How the map is lit: by the viewer's clock, or held at one time of day. */
	light: LightMode,
	/** The viewer's clock, read on mount and again every minute; `null` until read. */
	clock: Schema.NullOr(Clock),
	/** The traffic toggle; `null` until clicked, so it follows the reduced-motion setting. */
	traffic: Schema.NullOr(Schema.Boolean),
	command: CameraCommand,
	/** The `<html>` theme, read by a Mount; `null` until it ran. */
	isDark: Schema.NullOr(Schema.Boolean),
	isFailed: Schema.Boolean,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	ClickedRearrange: {},
	ClickedDeal: {},
	ClickedAutoArrange: {},
	ClickedPlaceRest: {},
	ClickedTraffic: { isFlowing: Schema.Boolean },
	ClickedSound: {},
	/** Steps the light on: the clock, then dawn, day, dusk and night. */
	ClickedLight: {},
	TickedClock: { clock: Clock },
	/** A cart or a train was clicked on the map. */
	PokedLink: { linkId: Schema.String },
	ClosedLinkCard: {},
	ClickedCamera: { action: Schema.Literals(["reset", "in", "out"]) },
	/** A service picked on the map or by its label; `null` clears the selection. */
	PickedNode: { nodeId: Schema.NullOr(Schema.String) },
	PickedUpTile: { nodeId: Schema.String },
	PlacedTile: { nodeId: Schema.String, cell: Cell },
	HoveredCell: { cell: Schema.NullOr(Cell) },
	CancelledHold: {},
	FailedScene: {},
	ResolvedTheme: { isDark: Schema.Boolean },
})
export type Message = typeof Message.Type

/** The parent owns the selection: the page opens its service panel, the lab its inspector. */
export const OutMessage = defineMessageUnion({
	Selected: { nodeId: Schema.NullOr(Schema.String) },
})
export type OutMessage = typeof OutMessage.Type

/** The viewer's clock now, in their own time zone. */
const readClock = (): Clock => clockOf(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone)

/** The clock the map is lit for: the viewer's own, or theirs with the hour held. */
export const litClockOf = (model: Pick<Model, "light">, clock: Clock): Clock => ({
	...clock,
	hour: hourFor(model.light, clock),
})

type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage>

const toRecord = (cells: Placements): Record<string, Cell> => Rec.fromEntries(cells)
export const placementsOf = (model: Pick<Model, "cells">): Placements => new Map(Rec.toEntries(model.cells))

/** The tile in hand: one lifted off the board, else the top of the stack. */
export const heldIdOf = (model: Pick<Model, "pickedId" | "stack">): string | null =>
	model.pickedId ?? model.stack[0] ?? null

const layoutKeys = new WeakMap<Topology3D, string>()

/** The set of services on a map, the key a layout is kept under; once per topology object. */
const layoutKeyOf = (topology: Topology3D): string => {
	const known = layoutKeys.get(topology)
	if (known !== undefined) return known
	const key = Arr.join(
		Arr.sort(
			Arr.map(topology.nodes, (node) => node.id),
			Order.String,
		),
		"\n",
	)
	layoutKeys.set(topology, key)
	return key
}

/**
 * The board for this topology. A tile whose service is still on the map keeps its cell, a
 * service new to the map is laid out round them (or joins the stack during a deal), and a tile
 * whose service left goes. Unchanged services return the model as it is.
 */
export const sync = (model: Model, topology: Topology3D): Model => {
	const key = layoutKeyOf(topology)
	if (key === model.layoutKey) return model
	const ids = new Set(Arr.map(topology.nodes, (node) => node.id))
	const staying = Arr.filter(Rec.toEntries(model.cells), ([id]) => ids.has(id))
	const gone = Arr.filter(Rec.toEntries(model.cells), ([id]) => !ids.has(id))
	const stack = Arr.filter(model.stack, (id) => ids.has(id))
	const dealing = model.layoutKey !== null && stack.length > 0
	// A returning service takes its old cell back, unless another tile stands there now.
	const taken = new Set(Arr.map(staying, ([, cell]) => cellKey(cell)))
	const returning = Arr.filter(Rec.toEntries(model.remembered), ([id, cell]) => {
		if (dealing || !ids.has(id) || taken.has(cellKey(cell))) return false
		taken.add(cellKey(cell))
		return true
	})
	const kept: Placements = new Map([...staying, ...returning])
	const newcomers = Arr.filter(dealOrder(topology, new Set(kept.keys())), (id) => !Arr.contains(stack, id))
	const pickedId = model.pickedId !== null && ids.has(model.pickedId) ? model.pickedId : null
	return {
		...model,
		layoutKey: key,
		remembered: Rec.filter({ ...model.remembered, ...Rec.fromEntries(gone) }, (_, id) => !ids.has(id)),
		cells: toRecord(dealing ? kept : autoLayout(topology, kept)),
		stack: dealing ? [...stack, ...newcomers] : [],
		pickedId: dealing ? null : pickedId,
		hover: null,
		lastGain: null,
	}
}

export const init = (): Model => ({
	cells: {},
	layoutKey: null,
	remembered: {},
	stack: [],
	pickedId: null,
	isBuilding: false,
	hover: null,
	lastGain: null,
	pokedLinkId: null,
	isMuted: false,
	light: "clock",
	clock: null,
	traffic: null,
	command: { action: "reset", serial: 0 },
	isDark: null,
	isFailed: false,
})

const deselect: OutMessage = OutMessage.Selected({ nodeId: null })

/** One step of the board over `topology`, laid out for it first (`sync`). */
export const update = (current: Model, message: Message, topology: Topology3D): Return => {
	const model = sync(current, topology)
	return Message.match<Return>(message, {
		// A deal in progress is always rearranging: there is a tile in hand until the stack is empty.
		ClickedRearrange: () =>
			model.stack.length > 0
				? { model }
				: {
						model: {
							...model,
							isBuilding: !model.isBuilding,
							pokedLinkId: null,
							pickedId: null,
							hover: null,
						},
						outMessage: deselect,
					},
		// The best connected tile starts in the middle; the rest come off the stack one at a time.
		ClickedDeal: () => {
			const order = dealOrder(topology)
			const first = order[0]
			return {
				model: {
					...model,
					cells: first === undefined ? {} : { [first]: ORIGIN },
					remembered: {},
					stack: Arr.drop(order, 1),
					pickedId: null,
					isBuilding: true,
					pokedLinkId: null,
					hover: null,
					lastGain: null,
				},
				outMessage: deselect,
			}
		},
		ClickedAutoArrange: () => ({
			model: {
				...model,
				cells: toRecord(autoLayout(topology)),
				remembered: {},
				stack: [],
				pickedId: null,
				isBuilding: false,
				hover: null,
				lastGain: null,
			},
		}),
		// Keeps every tile already down and lays the stack out around them.
		ClickedPlaceRest: () => ({
			model: {
				...model,
				cells: toRecord(autoLayout(topology, placementsOf(model))),
				stack: [],
				pickedId: null,
				hover: null,
				lastGain: null,
			},
		}),
		ClickedTraffic: ({ isFlowing }) => ({ model: { ...model, traffic: !isFlowing } }),
		ClickedSound: () => ({ model: { ...model, isMuted: !model.isMuted } }),
		ClickedLight: () => ({
			model: {
				...model,
				light: LIGHT_MODES[(LIGHT_MODES.indexOf(model.light) + 1) % LIGHT_MODES.length] ?? "clock",
			},
		}),
		TickedClock: ({ clock }) => ({ model: { ...model, clock } }),
		PokedLink: ({ linkId }) => ({
			model: Arr.some(linksOf(topology), (link) => link.id === linkId)
				? { ...model, pokedLinkId: linkId }
				: model,
		}),
		ClosedLinkCard: () => ({ model: { ...model, pokedLinkId: null } }),
		ClickedCamera: ({ action }) => ({
			model: { ...model, command: { action, serial: model.command.serial + 1 } },
		}),
		PickedNode: ({ nodeId }) => ({
			model: { ...model, pokedLinkId: null },
			outMessage: OutMessage.Selected({ nodeId }),
		}),
		PickedUpTile: ({ nodeId }) =>
			model.isBuilding && model.stack.length === 0 && nodeId in model.cells
				? { model: { ...model, pickedId: nodeId, hover: null }, outMessage: deselect }
				: { model },
		PlacedTile: ({ nodeId, cell }) => {
			if (nodeId !== heldIdOf(model)) return { model }
			const cells = placementsOf(model)
			return Option.match(
				Option.all({
					next: placeTile(cells, nodeId, cell),
					outcome: prospect(linksOf(topology), cells, nodeId, cell),
				}),
				{
					onNone: () => ({ model }),
					onSome: ({ next, outcome }) => ({
						model: {
							...model,
							cells: toRecord(next),
							stack: model.pickedId === null ? Arr.drop(model.stack, 1) : model.stack,
							pickedId: null,
							hover: null,
							lastGain: outcome.gain,
						},
					}),
				},
			)
		},
		HoveredCell: ({ cell }) => ({ model: { ...model, hover: cell } }),
		// Only a tile lifted off the board goes back; the stack's top stays in hand.
		CancelledHold: () => ({ model: { ...model, pickedId: null, hover: null } }),
		FailedScene: () => ({ model: { ...model, isFailed: true } }),
		ResolvedTheme: ({ isDark }) => ({ model: { ...model, isDark } }),
	})
}

// Scene input: the Mount reads it from data attributes, so a re-render patches, never remounts.

export const SceneState = Schema.Struct({
	selectedId: Schema.NullOr(Schema.String),
	heldId: Schema.NullOr(Schema.String),
	building: Schema.Boolean,
	flowing: Schema.Boolean,
	dark: Schema.Boolean,
	muted: Schema.Boolean,
	clock: Clock,
})

export const TOPOLOGY_ATTRIBUTE = "data-tiles-topology"
export const CELLS_ATTRIBUTE = "data-tiles-cells"
export const STATE_ATTRIBUTE = "data-tiles-state"
export const COMMAND_ATTRIBUTE = "data-tiles-command"

const decodeTopology = Schema.decodeUnknownOption(Schema.fromJsonString(Topology))
const decodeCells = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Cell)))
const decodeState = Schema.decodeUnknownOption(Schema.fromJsonString(SceneState))
const decodeCommand = Schema.decodeUnknownOption(Schema.fromJsonString(CameraCommand))

/** The last raw attribute and what it decoded to: an unchanged string keeps its object, and the
 * scene compares the topology and the cells by reference. */
interface Decoded<A> {
	raw: string | null
	value: Option.Option<A>
}

const decodeOnce = <A>(memo: Decoded<A>, raw: string | null, decode: (raw: string) => Option.Option<A>) => {
	if (raw !== memo.raw || Option.isNone(memo.value)) {
		memo.raw = raw
		memo.value = decode(raw ?? "")
	}
	return memo.value
}

interface InputMemo {
	readonly topology: Decoded<typeof Topology.Type>
	readonly cells: Decoded<Readonly<Record<string, Cell>>>
}

const readInput = (element: Element, memo: InputMemo): Option.Option<SceneInput> =>
	Option.all({
		topology: decodeOnce(memo.topology, element.getAttribute(TOPOLOGY_ATTRIBUTE), decodeTopology),
		cells: decodeOnce(memo.cells, element.getAttribute(CELLS_ATTRIBUTE), decodeCells),
		state: decodeState(element.getAttribute(STATE_ATTRIBUTE) ?? ""),
		command: decodeCommand(element.getAttribute(COMMAND_ATTRIBUTE) ?? ""),
	}).pipe(Option.map(({ topology, cells, state, command }) => ({ topology, cells, ...state, command })))

type SceneMessage =
	| ReturnType<typeof Message.PickedNode>
	| ReturnType<typeof Message.PickedUpTile>
	| ReturnType<typeof Message.PlacedTile>
	| ReturnType<typeof Message.HoveredCell>
	| ReturnType<typeof Message.CancelledHold>
	| ReturnType<typeof Message.PokedLink>
	| ReturnType<typeof Message.FailedScene>

type StartScene = (canvas: HTMLCanvasElement, initial: SceneInput, events: SceneEvents) => SceneHandle

const attach = (
	canvas: HTMLCanvasElement,
	startScene: StartScene,
	emit: (message: SceneMessage) => void,
): Option.Option<() => void> => {
	const memo: InputMemo = {
		topology: { raw: null, value: Option.none() },
		cells: { raw: null, value: Option.none() },
	}
	return Option.map(readInput(canvas, memo), (initial) => {
		const handle = startScene(canvas, initial, {
			onSelect: (nodeId) => emit(Message.PickedNode({ nodeId })),
			onPickUp: (nodeId) => emit(Message.PickedUpTile({ nodeId })),
			onPlace: (nodeId, cell) => emit(Message.PlacedTile({ nodeId, cell })),
			onHover: (cell) => emit(Message.HoveredCell({ cell })),
			onCancel: () => emit(Message.CancelledHold()),
			onPokeLink: (linkId) => emit(Message.PokedLink({ linkId })),
		})
		const observer = new MutationObserver(() =>
			Option.map(readInput(canvas, memo), (input) => handle.update(input)),
		)
		observer.observe(canvas, {
			attributes: true,
			attributeFilter: [TOPOLOGY_ATTRIBUTE, CELLS_ATTRIBUTE, STATE_ATTRIBUTE, COMMAND_ATTRIBUTE],
		})
		return () => {
			observer.disconnect()
			handle.stop()
		}
	})
}

/** The canvas and its scene for the element's lifetime. WebGL failing becomes `FailedScene`. */
export const MountScene = Mount.defineStream("MountServiceMapTiles", {
	messages: [
		Message.PickedNode,
		Message.PickedUpTile,
		Message.PlacedTile,
		Message.HoveredCell,
		Message.CancelledHold,
		Message.PokedLink,
		Message.FailedScene,
	],
	execute: ({ element }) =>
		!(element instanceof HTMLCanvasElement)
			? Stream.empty
			: Stream.callback<SceneMessage>((queue) =>
					Effect.acquireRelease(
						Effect.tryPromise({
							try: (): Promise<StartScene> =>
								import("./scene").then((loaded) => loaded.startScene),
							catch: (cause) =>
								new SceneStartError({
									message: "The landscape scene chunk did not load",
									cause,
								}),
						}).pipe(
							Effect.flatMap((startScene) =>
								Effect.try({
									try: () =>
										attach(element, startScene, (message) => {
											Queue.offerUnsafe(queue, message)
										}),
									catch: (cause) =>
										new SceneStartError({
											message: "The landscape scene did not start",
											cause,
										}),
								}),
							),
							Effect.catch(() =>
								Effect.sync(() => {
									Queue.offerUnsafe(queue, Message.FailedScene())
									return Option.none<() => void>()
								}),
							),
						),
						(stop) => Effect.sync(() => Option.map(stop, (release) => release())),
					).pipe(Effect.flatMap(() => Effect.never)),
				),
})

/** The viewer's clock on mount and again every minute, so a map left open goes from day to night. */
export const WatchClock = Mount.defineStream("WatchServiceMapTilesClock", {
	messages: [Message.TickedClock],
	execute: () =>
		Stream.callback<ReturnType<typeof Message.TickedClock>>((queue) =>
			Effect.acquireRelease(
				Effect.sync(() => {
					const tick = () => Queue.offerUnsafe(queue, Message.TickedClock({ clock: readClock() }))
					tick()
					return window.setInterval(tick, 60_000)
				}),
				(timer) => Effect.sync(() => window.clearInterval(timer)),
			).pipe(Effect.flatMap(() => Effect.never)),
		),
})

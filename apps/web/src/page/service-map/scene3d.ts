import { WORLD_OPS_MAX, WorldDocument, WorldEntity, WorldOp } from "@maple/domain/http"
import { Effect, Option, Queue, Result, Schema, Stream, Array as Arr } from "effect"
import { Command, Mount, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as ToggleGroup from "@maple/views/ui/toggle-group"
import {
	applyEdit,
	BatchOutcome,
	EditCommand,
	type EditResult,
	initialEdits,
	MoveBuilding,
	outstandingOps,
	reconcile,
	redo,
	undo,
	type WorldEdits,
} from "./factory/edits"
import type { SceneEvents, SceneHandle, SceneInput } from "./three/scene"

// The 3D viewport's own state: the Atlas or
// Cascade perspective, the traffic toggle and the camera command. The scene itself runs in a
// Mount that `import()`s `./three/scene`, so three never reaches the startup bundle.

/** The scene chunk failed to load, or WebGL failed to start. */
export class SceneStartError extends Schema.TaggedError<SceneStartError>()(
	"@maple/web/service-map/SceneStartError",
	{ message: Schema.String, cause: Schema.Defect() },
) {}

/** `WorldEdits` holds Maps, so the model carries it boxed, as the page boxes its bundles. */
export class WorldEditsBox {
	constructor(readonly value: WorldEdits) {}
}

export const Perspective = Schema.Literals(["atlas", "cascade"])
export type Perspective = typeof Perspective.Type

export const CameraCommand = Schema.Struct({
	action: Schema.Literals(["reset", "in", "out"]),
	serial: Schema.Number,
})
export type CameraCommand = typeof CameraCommand.Type

export const Model = Schema.Struct({
	perspective: Perspective,
	perspectiveGroup: ToggleGroup.Model,
	/** The traffic toggle; `null` until clicked, so it follows the system's reduced-motion setting. */
	traffic: Schema.NullOr(Schema.Boolean),
	command: CameraCommand,
	/** `useTheme()`: read from `<html>` by a Mount, `null` until it ran. */
	isDark: Schema.NullOr(Schema.Boolean),
	/** WebGL could not start: the fallback shows instead. */
	isFailed: Schema.Boolean,
	/** The org's shared factory: what the server confirmed, the optimistic edits and history. */
	world: Schema.instanceOf(WorldEditsBox),
	/** The world is requested once the theme resolves; the canvas waits for it. */
	worldState: Schema.Literals(["idle", "loading", "ready", "failed"]),
	/** Customize mode: buildings drag on the grid and the edit panel shows. */
	isEditing: Schema.Boolean,
	/** A batch is in flight; later edits wait and go out as the next one. */
	isSaving: Schema.Boolean,
	/** The last batch failed in transport; the edits stay on screen until a retry lands. */
	isSaveFailed: Schema.Boolean,
	/** Serial of the batch in flight: a late answer to an older one is ignored. */
	batch: Schema.Number,
	/** Why the server refused the last batch for good; cleared by the next edit. */
	rejection: Schema.NullOr(Schema.String),
	/** The last batch hit a teammate's newer change, now on screen; cleared by the next edit. */
	isConflicted: Schema.Boolean,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	GotPerspectiveMessage: { message: ToggleGroup.Message },
	/** `isFlowing`: what the button showed, since the default depends on reduced motion. */
	ClickedTraffic: { isFlowing: Schema.Boolean },
	ClickedCamera: { action: Schema.Literals(["reset", "in", "out"]) },
	/** A machine, sign or belt tag picked (already toggled), or `null` for empty paper. */
	PickedNode: { nodeId: Schema.NullOr(Schema.String) },
	FailedScene: {},
	ResolvedTheme: { isDark: Schema.Boolean },
	ClickedCustomize: {},
	ClickedDoneCustomizing: {},
	ClickedUndo: {},
	ClickedRedo: {},
	ClickedRetrySave: {},
	ClickedRetryLoad: {},
	/** A drop on the canvas or a choice in the edit panel. */
	EditedWorld: { command: EditCommand },
	/** The parent's answer to `RequestedWorld`. */
	LoadedWorld: { result: Schema.Result(WorldDocument, LoadFailure) },
	/** The parent's answer to `SavedWorldOps`, for the batch with that serial. */
	SettledWorldOps: { batch: Schema.Number, result: Schema.Result(BatchOutcome, LoadFailure) },
})
export type Message = typeof Message.Type

/** The parent owns the transport (the page calls the API, the lab keeps the world in memory). */
export const OutMessage = defineMessageUnion({
	Selected: { nodeId: Schema.NullOr(Schema.String) },
	RequestedWorld: {},
	SavedWorldOps: { batch: Schema.Number, ops: Schema.Array(WorldOp) },
})
export type OutMessage = typeof OutMessage.Type

// SCENE INPUT: the Mount reads it from data attributes, so a re-render patches, never remounts.

const Node3D = Schema.Struct({
	id: Schema.String,
	label: Schema.String,
	kind: Schema.Literals(["edge", "service", "database", "queue", "external"]),
	namespace: Schema.String,
	platform: Schema.Literals(["kubernetes", "cloudflare", "gcp", "lambda", "web", "unknown"]),
	runtime: Schema.optional(Schema.String),
	throughput: Schema.Number,
	errorRate: Schema.Number,
	hasSampling: Schema.optional(Schema.Boolean),
	dimmed: Schema.optional(Schema.Boolean),
	p95LatencyMs: Schema.optional(Schema.Number),
	system: Schema.optional(Schema.String),
})
const Edge3D = Schema.Struct({
	source: Schema.String,
	target: Schema.String,
	callsPerSecond: Schema.Number,
	errorRate: Schema.Number,
	hasSampling: Schema.optional(Schema.Boolean),
	dimmed: Schema.optional(Schema.Boolean),
	avgLatencyMs: Schema.Number,
	maxLatencyMs: Schema.optional(Schema.Number),
	relation: Schema.optional(Schema.Literal("hyperdrive-origin")),
	p95LatencyMs: Schema.optional(Schema.Number),
})
export const Topology = Schema.Struct({ nodes: Schema.Array(Node3D), edges: Schema.Array(Edge3D) })

export const SceneState = Schema.Struct({
	selectedId: Schema.NullOr(Schema.String),
	view: Perspective,
	flowing: Schema.Boolean,
	dark: Schema.Boolean,
	editing: Schema.Boolean,
})

/** What the scene draws of the world: the optimistic entities. Customize is in `SceneState`, so
 * toggling it keeps the entities (and the layout built from them) as they are. */
export const SceneWorld = Schema.Struct({ entities: Schema.Array(WorldEntity) })
export type SceneWorld = typeof SceneWorld.Type

export const TOPOLOGY_ATTRIBUTE = "data-scene-topology"
export const WORLD_ATTRIBUTE = "data-scene-world"
export const STATE_ATTRIBUTE = "data-scene-state"
export const COMMAND_ATTRIBUTE = "data-scene-command"

const decodeTopology = Schema.decodeUnknownOption(Schema.fromJsonString(Topology))
const decodeState = Schema.decodeUnknownOption(Schema.fromJsonString(SceneState))
const decodeCommand = Schema.decodeUnknownOption(Schema.fromJsonString(CameraCommand))
const decodeWorld = Schema.decodeUnknownOption(Schema.fromJsonString(SceneWorld))

/** The three attributes as one `SceneInput`; `None` while any is missing or malformed. */
const readInput = (element: Element): Option.Option<SceneInput> =>
	Option.all({
		topology: decodeTopology(element.getAttribute(TOPOLOGY_ATTRIBUTE) ?? ""),
		state: decodeState(element.getAttribute(STATE_ATTRIBUTE) ?? ""),
		command: decodeCommand(element.getAttribute(COMMAND_ATTRIBUTE) ?? ""),
		world: decodeWorld(element.getAttribute(WORLD_ATTRIBUTE) ?? ""),
	}).pipe(
		Option.map(({ topology, state, command, world }) => ({
			topology,
			...state,
			command,
			entities: world.entities,
		})),
	)

export const init = (): Model => ({
	perspective: "atlas",
	perspectiveGroup: ToggleGroup.init({ label: "Map perspective", values: ["atlas"] }),
	traffic: null,
	command: { action: "reset", serial: 0 },
	isDark: null,
	isFailed: false,
	world: new WorldEditsBox(initialEdits([])),
	worldState: "idle",
	isEditing: false,
	isSaving: false,
	isSaveFailed: false,
	batch: 0,
	rejection: null,
	isConflicted: false,
})

/** Entering 3D again starts the view over. The world is fetched again (teammates may have
 * changed it) unless edits are unsent or a batch is in flight: those survive a trip to 2D, so a
 * late answer never lands on an empty world. */
export const reenter = (previous: Model): Model =>
	!previous.isSaving && outstandingOps(previous.world.value).length === 0
		? init()
		: {
				...init(),
				world: previous.world,
				worldState: previous.worldState,
				isSaving: previous.isSaving,
				isSaveFailed: previous.isSaveFailed,
				batch: previous.batch,
				rejection: previous.rejection,
				isConflicted: previous.isConflicted,
			}

const decodePerspective = Schema.decodeUnknownOption(Perspective)

export const update = (
	model: Model,
	message: Message,
): Update.ReturnWithOutMessage<Model, Message, OutMessage> =>
	Message.match<Update.ReturnWithOutMessage<Model, Message, OutMessage>>(message, {
		// `onValueChange`: the newly pressed value, if it is a perspective; a release changes nothing.
		GotPerspectiveMessage: ({ message: inner }) => {
			const step = ToggleGroup.update(model.perspectiveGroup, inner)
			const next = step.model
			const picked = Option.flatMap(
				Arr.findFirst(next.values, (value) => value !== model.perspective),
				decodePerspective,
			)
			const perspective = Option.getOrElse(picked, () => model.perspective)
			return {
				model: {
					...model,
					perspective,
					perspectiveGroup: { ...next, values: [perspective] },
					// Cascade is never customized: leaving Atlas ends Customize.
					isEditing: model.isEditing && perspective === "atlas",
				},
				commands: Command.mapMessages(step.commands ?? [], (message) =>
					Message.GotPerspectiveMessage({ message }),
				),
			}
		},
		ClickedTraffic: ({ isFlowing }) => ({ model: { ...model, traffic: !isFlowing } }),
		ClickedCamera: ({ action }) => ({
			model: { ...model, command: { action, serial: model.command.serial + 1 } },
		}),
		PickedNode: ({ nodeId }) => ({ model, outMessage: OutMessage.Selected({ nodeId }) }),
		FailedScene: () => ({ model: { ...model, isFailed: true } }),
		// The theme resolving is the viewport's first moment: ask for the world once.
		ResolvedTheme: ({ isDark }) =>
			model.worldState === "idle"
				? {
						model: { ...model, isDark, worldState: "loading" },
						outMessage: OutMessage.RequestedWorld(),
					}
				: { model: { ...model, isDark } },
		ClickedCustomize: () =>
			model.worldState !== "ready"
				? { model }
				: { model: { ...withPerspective(model, "atlas"), isEditing: true } },
		ClickedDoneCustomizing: () => ({ model: { ...model, isEditing: false } }),
		ClickedUndo: () => editStep(model, undo(model.world.value)),
		ClickedRedo: () => editStep(model, redo(model.world.value)),
		ClickedRetrySave: () => flush({ ...model, isSaveFailed: false }),
		ClickedRetryLoad: () =>
			model.worldState === "failed"
				? { model: { ...model, worldState: "loading" }, outMessage: OutMessage.RequestedWorld() }
				: { model },
		EditedWorld: ({ command }) =>
			model.worldState !== "ready" || !model.isEditing
				? { model }
				: editStep(model, applyEdit(model.world.value, command)),
		// Only the answer to a pending load: a late one would replace a world already being edited.
		LoadedWorld: ({ result }) =>
			model.worldState !== "loading"
				? { model }
				: Result.match(result, {
						onSuccess: (document) => ({
							model: {
								...model,
								world: new WorldEditsBox(initialEdits(document.entities)),
								worldState: "ready" as const,
							},
						}),
						// The map still draws the automatic layout; Customize stays off.
						onFailure: () => ({ model: { ...model, worldState: "failed" as const } }),
					}),
		SettledWorldOps: ({ batch, result }) =>
			batch !== model.batch || !model.isSaving
				? { model }
				: Result.match(result, {
						onSuccess: (outcome) =>
							flush({
								...model,
								world: new WorldEditsBox(reconcile(model.world.value, outcome)),
								isSaving: false,
								rejection: outcome._tag === "Rejected" ? outcome.message : model.rejection,
								isConflicted: outcome._tag === "Conflicted" || model.isConflicted,
							}),
						onFailure: () => ({ model: { ...model, isSaving: false, isSaveFailed: true } }),
					}),
	})

type Step = Update.ReturnWithOutMessage<Model, Message, OutMessage>

/** Sends what is on screen but not yet stored, one batch at a time. */
const flush = (model: Model): Step => {
	const ops = outstandingOps(model.world.value)
	if (model.worldState !== "ready" || model.isSaving || model.isSaveFailed || ops.length === 0)
		return { model }
	const batch = model.batch + 1
	return {
		model: { ...model, isSaving: true, batch },
		outMessage: OutMessage.SavedWorldOps({ batch, ops: Arr.take(ops, WORLD_OPS_MAX) }),
	}
}

const editStep = (model: Model, result: EditResult): Step =>
	// A new edit is also a retry of a failed save: the batch is rebuilt from the latest state.
	result.state === model.world.value
		? { model }
		: flush({
				...model,
				world: new WorldEditsBox(result.state),
				isSaveFailed: false,
				rejection: null,
				isConflicted: false,
			})

const withPerspective = (model: Model, perspective: Perspective): Model => ({
	...model,
	perspective,
	perspectiveGroup: { ...model.perspectiveGroup, values: [perspective] },
})

// MOUNTS

type SceneMessage =
	| ReturnType<typeof Message.PickedNode>
	| ReturnType<typeof Message.FailedScene>
	| ReturnType<typeof Message.EditedWorld>
type StartScene = (canvas: HTMLCanvasElement, initial: SceneInput, events: SceneEvents) => SceneHandle

/** Starts the scene and feeds it attribute changes; a topology string that did not change keeps its object. */
const attach = (
	canvas: HTMLCanvasElement,
	startScene: StartScene,
	emit: (message: SceneMessage) => void,
): Option.Option<() => void> =>
	Option.map(readInput(canvas), (initial) => {
		const handle = startScene(canvas, initial, {
			onSelect: (nodeId) => emit(Message.PickedNode({ nodeId })),
			onMove: (nodeId, cell) =>
				emit(Message.EditedWorld({ command: MoveBuilding.make({ nodeId, cell }) })),
		})
		// Unchanged attribute strings keep their decoded objects: the scene compares by reference.
		const last = {
			topology: canvas.getAttribute(TOPOLOGY_ATTRIBUTE),
			value: initial.topology,
			world: canvas.getAttribute(WORLD_ATTRIBUTE),
			entities: initial.entities,
		}
		const observer = new MutationObserver(() =>
			Option.map(readInput(canvas), (input) => {
				const raw = canvas.getAttribute(TOPOLOGY_ATTRIBUTE)
				if (raw !== last.topology) {
					last.topology = raw
					last.value = input.topology
				}
				const rawWorld = canvas.getAttribute(WORLD_ATTRIBUTE)
				if (rawWorld !== last.world) {
					last.world = rawWorld
					last.entities = input.entities
				}
				handle.update({ ...input, topology: last.value, entities: last.entities })
			}),
		)
		observer.observe(canvas, {
			attributes: true,
			attributeFilter: [TOPOLOGY_ATTRIBUTE, STATE_ATTRIBUTE, COMMAND_ATTRIBUTE, WORLD_ATTRIBUTE],
		})
		return () => {
			observer.disconnect()
			handle.stop()
		}
	})

/** `<Canvas>` and its scene for the element's lifetime. WebGL failing becomes `FailedScene`. */
export const MountScene = Mount.defineStream("MountServiceMapScene", {
	messages: [Message.PickedNode, Message.FailedScene, Message.EditedWorld],
	execute: ({ element }) =>
		!(element instanceof HTMLCanvasElement)
			? Stream.empty
			: Stream.callback<SceneMessage>((queue) =>
					Effect.acquireRelease(
						Effect.tryPromise({
							try: () => import("./three/scene"),
							catch: (cause) =>
								new SceneStartError({ message: "The 3D scene chunk did not load", cause }),
						}).pipe(
							Effect.flatMap(({ startScene }) =>
								Effect.try({
									try: () =>
										attach(element, startScene, (message) => {
											Queue.offerUnsafe(queue, message)
										}),
									catch: (cause) =>
										new SceneStartError({ message: "The 3D scene did not start", cause }),
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

/** `useTheme()` for the palette: the `<html>` class now and on every flip. */
export const WatchTheme = Mount.defineStream("WatchServiceMapSceneTheme", {
	messages: [Message.ResolvedTheme],
	execute: () =>
		Stream.callback<ReturnType<typeof Message.ResolvedTheme>>((queue) =>
			Effect.acquireRelease(
				Effect.sync(() => {
					const root = document.documentElement
					const emit = () =>
						Queue.offerUnsafe(
							queue,
							Message.ResolvedTheme({ isDark: root.classList.contains("dark") }),
						)
					emit()
					const observer = new MutationObserver(emit)
					observer.observe(root, { attributes: true, attributeFilter: ["class"] })
					return observer
				}),
				(observer) => Effect.sync(() => observer.disconnect()),
			).pipe(Effect.flatMap(() => Effect.never)),
		),
})

import { Effect, Option, Queue, Schema, Stream } from "effect"
import { Command, Mount, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import * as ToggleGroup from "../../ui/toggle-group"
import type { SceneHandle, SceneInput } from "./three/scene"

// The 3D viewport's own state: the Atlas or
// Cascade perspective, the traffic toggle and the camera command. The scene itself runs in a
// Mount that `import()`s `./three/scene`, so three never reaches the startup bundle.

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
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({ Selected: { nodeId: Schema.NullOr(Schema.String) } })
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
})

export const TOPOLOGY_ATTRIBUTE = "data-scene-topology"
export const STATE_ATTRIBUTE = "data-scene-state"
export const COMMAND_ATTRIBUTE = "data-scene-command"

const decodeTopology = Schema.decodeUnknownOption(Schema.fromJsonString(Topology))
const decodeState = Schema.decodeUnknownOption(Schema.fromJsonString(SceneState))
const decodeCommand = Schema.decodeUnknownOption(Schema.fromJsonString(CameraCommand))

/** The three attributes as one `SceneInput`; `None` while any is missing or malformed. */
const readInput = (element: Element): Option.Option<SceneInput> =>
	Option.all({
		topology: decodeTopology(element.getAttribute(TOPOLOGY_ATTRIBUTE) ?? ""),
		state: decodeState(element.getAttribute(STATE_ATTRIBUTE) ?? ""),
		command: decodeCommand(element.getAttribute(COMMAND_ATTRIBUTE) ?? ""),
	}).pipe(Option.map(({ topology, state, command }) => ({ topology, ...state, command })))

export const init = (): Model => ({
	perspective: "atlas",
	perspectiveGroup: ToggleGroup.init({ label: "Map perspective", values: ["atlas"] }),
	traffic: null,
	command: { action: "reset", serial: 0 },
	isDark: null,
	isFailed: false,
})

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
				Option.fromNullishOr(next.values.find((value) => value !== model.perspective)),
				decodePerspective,
			)
			const perspective = Option.getOrElse(picked, () => model.perspective)
			return {
				model: {
					...model,
					perspective,
					perspectiveGroup: { ...next, values: [perspective] },
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
		ResolvedTheme: ({ isDark }) => ({ model: { ...model, isDark } }),
	})

// MOUNTS

type SceneMessage = ReturnType<typeof Message.PickedNode> | ReturnType<typeof Message.FailedScene>
type StartScene = (
	canvas: HTMLCanvasElement,
	initial: SceneInput,
	onSelect: (id: string | null) => void,
) => SceneHandle

/** Starts the scene and feeds it attribute changes; a topology string that did not change keeps its object. */
const attach = (
	canvas: HTMLCanvasElement,
	startScene: StartScene,
	emit: (message: SceneMessage) => void,
): Option.Option<() => void> =>
	Option.map(readInput(canvas), (initial) => {
		const handle = startScene(canvas, initial, (nodeId) => emit(Message.PickedNode({ nodeId })))
		const last = { topology: canvas.getAttribute(TOPOLOGY_ATTRIBUTE), value: initial.topology }
		const observer = new MutationObserver(() =>
			Option.map(readInput(canvas), (input) => {
				const raw = canvas.getAttribute(TOPOLOGY_ATTRIBUTE)
				if (raw !== last.topology) {
					last.topology = raw
					last.value = input.topology
				}
				handle.update({ ...input, topology: last.value })
			}),
		)
		observer.observe(canvas, {
			attributes: true,
			attributeFilter: [TOPOLOGY_ATTRIBUTE, STATE_ATTRIBUTE, COMMAND_ATTRIBUTE],
		})
		return () => {
			observer.disconnect()
			handle.stop()
		}
	})

/** `<Canvas>` and its scene for the element's lifetime. WebGL failing becomes `FailedScene`. */
export const MountScene = Mount.defineStream("MountServiceMapScene", {
	messages: [Message.PickedNode, Message.FailedScene],
	execute: ({ element }) =>
		!(element instanceof HTMLCanvasElement)
			? Stream.empty
			: Stream.callback<SceneMessage>((queue) =>
					Effect.acquireRelease(
						Effect.tryPromise(() => import("./three/scene")).pipe(
							Effect.flatMap(({ startScene }) =>
								Effect.try(() =>
									attach(element, startScene, (message) => {
										Queue.offerUnsafe(queue, message)
									}),
								),
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

import { WorldDocument, WorldEntityRecord } from "@maple/domain/http"
import { Effect, Result, Schema } from "effect"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { applyInMemory } from "./memory-world"
import { Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import * as Scene3d from "../../page/service-map/scene3d"
import type { Resources } from "../../platform/resources"

// `/lab/service-map-3d`: the 3D viewport Submodel over
// the sample topology, with the inventory and inspector rail beside it.

export const Model = Schema.Struct({
	scene: Scene3d.Model,
	selectedId: Schema.NullOr(Schema.String),
	query: Schema.String,
	/** `useReducedMotion()`, read once before init. */
	reducedMotion: Schema.Boolean,
	/** The in-memory world the viewport loads and saves to. */
	store: Schema.Array(WorldEntityRecord),
	/** `?failSaves=1`: every save fails in transport, to show the retry state. */
	failSaves: Schema.Boolean,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	GotSceneMessage: { message: Scene3d.Message },
	ClickedNode: { nodeId: Schema.NullOr(Schema.String) },
	ChangedQuery: { value: Schema.String },
})
export type Message = typeof Message.Type

export const Flags = Schema.Struct({ reducedMotion: Schema.Boolean, failSaves: Schema.Boolean })
export type Flags = typeof Flags.Type

export const flags = Effect.sync((): Flags => ({
	reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
	failSaves: new URLSearchParams(window.location.search).get("failSaves") === "1",
}))

type Return = Update.Return<Model, Message, Resources>

/** Hands the viewport its answer on the next tick, as a round trip to the API would. */
const AnswerScene = Command.define("AnswerServiceMap3dLabWorld", {
	args: { message: Scene3d.Message },
	messages: [Message.GotSceneMessage],
	execute: ({ message }) => Effect.succeed(Message.GotSceneMessage({ message })),
})

export const init = (flags: Flags): Return => ({
	model: {
		scene: Scene3d.init(),
		selectedId: null,
		query: "",
		reducedMotion: flags.reducedMotion,
		store: [],
		failSaves: flags.failSaves,
	},
})

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotSceneMessage: ({ message: inner }) => {
			const next = Scene3d.update(model.scene, inner)
			const lifted: Return = {
				model: { ...model, scene: next.model },
				commands: Command.mapMessages(next.commands ?? [], (message) =>
					Message.GotSceneMessage({ message }),
				),
			}
			if (next.outMessage === undefined) return lifted
			const answer = (message: Scene3d.Message, store = model.store): Return => ({
				model: { ...lifted.model, store },
				commands: [...(lifted.commands ?? []), AnswerScene({ message })],
			})
			return Scene3d.OutMessage.match<Return>(next.outMessage, {
				Selected: ({ nodeId }) => ({ ...lifted, model: { ...lifted.model, selectedId: nodeId } }),
				RequestedWorld: () =>
					answer(
						Scene3d.Message.LoadedWorld({
							result: Result.succeed(
								new WorldDocument({ schemaVersion: 1, entities: model.store }),
							),
						}),
					),
				SavedWorldOps: ({ ops }) => {
					if (model.failSaves)
						return answer(
							Scene3d.Message.SettledWorldOps({
								result: Result.fail(toLoadFailure("The lab fails every save.")),
							}),
						)
					const applied = applyInMemory(model.store, ops, 0)
					return answer(
						Scene3d.Message.SettledWorldOps({ result: Result.succeed(applied.outcome) }),
						applied.records,
					)
				},
			})
		},
		ClickedNode: ({ nodeId }) => ({ model: { ...model, selectedId: nodeId } }),
		ChangedQuery: ({ value }) => ({ model: { ...model, query: value } }),
	})

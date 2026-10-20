import { Effect, Schema } from "effect"
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
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	GotSceneMessage: { message: Scene3d.Message },
	ClickedNode: { nodeId: Schema.NullOr(Schema.String) },
	ChangedQuery: { value: Schema.String },
})
export type Message = typeof Message.Type

export const Flags = Schema.Struct({ reducedMotion: Schema.Boolean })
export type Flags = typeof Flags.Type

export const flags = Effect.sync(
	(): Flags => ({ reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches }),
)

type Return = Update.Return<Model, Message, Resources>

export const init = (flags: Flags): Return => ({
	model: { scene: Scene3d.init(), selectedId: null, query: "", reducedMotion: flags.reducedMotion },
})

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotSceneMessage: ({ message: inner }) => {
			const next = Scene3d.update(model.scene, inner)
			return {
				model: {
					...model,
					scene: next.model,
					selectedId: next.outMessage === undefined ? model.selectedId : next.outMessage.nodeId,
				},
				commands: Command.mapMessages(next.commands ?? [], (message) =>
					Message.GotSceneMessage({ message }),
				),
			}
		},
		ClickedNode: ({ nodeId }) => ({ model: { ...model, selectedId: nodeId } }),
		ChangedQuery: ({ value }) => ({ model: { ...model, query: value } }),
	})

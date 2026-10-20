import { Clock, Effect, Schema } from "effect"
import { Command, type Update } from "foldkit"
import type { Resources } from "../../platform/resources"
import { hubStep, initHub, labSignals } from "./hub-step"
import { Message, type Model } from "./model"

export type Return = Update.Return<Model, Message, Resources>

export const ErrorsLabFlags = Schema.Struct({ nowMs: Schema.Number, timeZone: Schema.String })
export type ErrorsLabFlags = typeof ErrorsLabFlags.Type

/** The boot clock (read once) and the browser's zone. */
export const errorsLabFlags: Effect.Effect<ErrorsLabFlags> = Effect.all({
	nowMs: Clock.currentTimeMillis,
	timeZone: Effect.sync(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
})

export const init = (flags: ErrorsLabFlags): Model => ({
	timeZone: flags.timeZone,
	hub: initHub(flags.nowMs),
	state: "ready",
	width: null,
})

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotHubMessage: ({ message: inner }) => {
			// The retry card's button puts the lab back to ready.
			if (inner._tag === "ClickedRetry") return { model: { ...model, state: "ready" } }
			const next = hubStep(model.hub, inner, labSignals(model.hub, model.state))
			return {
				model: { ...model, hub: next.hub },
				commands: Command.mapMessages(next.commands, (child) =>
					Message.GotHubMessage({ message: child }),
				),
			}
		},
		ClickedState: ({ state }) => ({ model: { ...model, state } }),
		ClickedWidth: ({ width }) => ({ model: { ...model, width } }),
	})

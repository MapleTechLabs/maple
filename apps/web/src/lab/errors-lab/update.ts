import { Clock, Effect, Option, Schema } from "effect"
import { Command, type Update } from "foldkit"
import type { Resources } from "../../platform/resources"
import { grantsOf, hubStep, initHub, labSignals } from "./hub-step"
import { LabRole, Message, type Model } from "./model"

export type Return = Update.Return<Model, Message, Resources>

export const ErrorsLabFlags = Schema.Struct({
	nowMs: Schema.Number,
	timeZone: Schema.String,
	role: LabRole,
})
export type ErrorsLabFlags = typeof ErrorsLabFlags.Type

const decodeRole = Schema.decodeUnknownOption(LabRole)

/** The boot clock (read once), the browser's zone and the `?role=` the list is read as. */
export const errorsLabFlags: Effect.Effect<ErrorsLabFlags> = Effect.all({
	nowMs: Clock.currentTimeMillis,
	timeZone: Effect.sync(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
	role: Effect.sync(() =>
		Option.getOrElse(
			decodeRole(new URLSearchParams(window.location.search).get("role")),
			(): LabRole => "member",
		),
	),
})

export const init = (flags: ErrorsLabFlags): Model => ({
	timeZone: flags.timeZone,
	hub: initHub(flags.nowMs, flags.role),
	state: "ready",
	role: flags.role,
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
		// A new role is a new session: its grants, and nothing left selected or open.
		ClickedRole: ({ role }) => ({
			model: {
				...model,
				role,
				hub: { ...model.hub, grants: grantsOf(role), selectedIds: [], picker: null },
			},
		}),
		ClickedWidth: ({ width }) => ({ model: { ...model, width } }),
	})

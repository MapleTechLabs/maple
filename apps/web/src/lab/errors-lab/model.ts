import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { Message as HubMessage } from "../../page/errors/hub/message"
import { Model as HubModel } from "../../page/errors/hub/model"

// `/lab/errors`: the errors hub over a fixture holding every row
// state at once, with the lab's State, Role and Width toggles (`?role=member|observer`).
// Shell-free; the entry wraps it.

export const LAB_STATES = ["ready", "loading", "failed", "empty"] as const
export const LabState = Schema.Literals(LAB_STATES)
export type LabState = typeof LabState.Type

/** A member triages; an observer reads the list and gets no checkbox, picker or bulk bar. */
export const LAB_ROLES = ["member", "observer"] as const
export const LabRole = Schema.Literals(LAB_ROLES)
export type LabRole = typeof LabRole.Type

/** Widths worth checking: the row's lanes are container queries. */
export const LAB_WIDTHS = [
	{ label: "Full", value: null },
	{ label: "1100px", value: 1100 },
	{ label: "820px", value: 820 },
	{ label: "600px", value: 600 },
] as const

export const Model = Schema.Struct({
	timeZone: Schema.String,
	/** The hub's toolbar and row state; its `search` holds the lab's view, sort, severity and query. */
	hub: HubModel,
	state: LabState,
	role: LabRole,
	width: Schema.NullOr(Schema.Number),
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	GotHubMessage: { message: HubMessage },
	ClickedState: { state: LabState },
	ClickedRole: { role: LabRole },
	ClickedWidth: { width: Schema.NullOr(Schema.Number) },
})
export type Message = typeof Message.Type
